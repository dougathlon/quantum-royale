import { CHICKEN_BY_ID, type ChickenId } from "../content/chickens";
import type { Context } from "../fixtures/types";
import type {
  FramePacket,
  InteractionResolvedEvent,
} from "../simulation/types";

export interface ActiveArenaRelation {
  readonly sourceEventId: number;
  readonly orderedPair: readonly [ChickenId, ChickenId];
  readonly context: Context;
  readonly expiresTick: number;
}

export const RELATION_PRESENTATION_TICKS = Object.freeze({
  movement: 12,
  support: 18,
  combat: 16,
  shieldSave: 32,
  knockdown: 36,
  spotlight: 48,
});

const CONTEXT_PRIORITY: Readonly<Record<Context, number>> = {
  X: 3,
  Y: 2,
  Z: 1,
};

function pairKey(pair: readonly [ChickenId, ChickenId]): string {
  const qubits = pair.map((id) => {
    const chicken = CHICKEN_BY_ID.get(id);
    if (!chicken) throw new Error(`Unknown chicken ${id}.`);
    return chicken.qubit;
  });
  return `${Math.min(...qubits)}-${Math.max(...qubits)}`;
}

export function relationExpiresAt(event: InteractionResolvedEvent): number {
  if (event.spotlight.selected) {
    return event.tick + RELATION_PRESENTATION_TICKS.spotlight;
  }
  if (event.consequences.knockdowns.length > 0) {
    return event.tick + RELATION_PRESENTATION_TICKS.knockdown;
  }
  if (
    event.consequences.damage.some(
      (consequence) => consequence.savingSourceIds.length > 0,
    )
  ) {
    return event.tick + RELATION_PRESENTATION_TICKS.shieldSave;
  }
  if (event.context === "X") {
    return event.tick + RELATION_PRESENTATION_TICKS.combat;
  }
  if (event.context === "Y") {
    return event.tick + RELATION_PRESENTATION_TICKS.support;
  }
  return Math.max(
    event.tick + RELATION_PRESENTATION_TICKS.movement,
    ...event.consequences.movement.map((consequence) => consequence.untilTick),
  );
}

export function activeArenaRelation(
  event: InteractionResolvedEvent,
): ActiveArenaRelation {
  return Object.freeze({
    sourceEventId: event.eventId,
    orderedPair: event.orderedPair,
    context: event.context,
    expiresTick: relationExpiresAt(event),
  });
}

export function updateActiveArenaRelations(
  current: readonly ActiveArenaRelation[],
  packet: FramePacket,
): readonly ActiveArenaRelation[] {
  if (
    packet.snapshot.phase !== "round" ||
    packet.events.some((event) => event.type === "MATCH_STARTED")
  ) {
    return Object.freeze([]);
  }

  const candidates = [
    ...current,
    ...packet.snapshot.auditHistory
      .filter(
        (event): event is InteractionResolvedEvent =>
          event.type === "INTERACTION_RESOLVED" &&
          event.tick <= packet.snapshot.tick,
      )
      .map(activeArenaRelation),
    ...packet.events
      .filter(
        (event): event is InteractionResolvedEvent =>
          event.type === "INTERACTION_RESOLVED",
      )
      .map(activeArenaRelation),
  ].filter((relation) => relation.expiresTick > packet.snapshot.tick);

  const byPair = new Map<string, ActiveArenaRelation>();
  for (const candidate of candidates) {
    const key = pairKey(candidate.orderedPair);
    const existing = byPair.get(key);
    if (
      !existing ||
      CONTEXT_PRIORITY[candidate.context] >
        CONTEXT_PRIORITY[existing.context] ||
      (candidate.context === existing.context &&
        candidate.sourceEventId > existing.sourceEventId)
    ) {
      byPair.set(key, candidate);
    }
  }

  return Object.freeze(
    [...byPair.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, relation]) => relation),
  );
}

export function sameUnorderedPair(
  left: readonly [ChickenId, ChickenId],
  right: readonly [ChickenId, ChickenId],
): boolean {
  return pairKey(left) === pairKey(right);
}
