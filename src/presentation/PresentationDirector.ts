import {
  CHICKEN_BY_ID,
  CHICKEN_BY_QUBIT,
  type ChickenId,
} from "../content/chickens";
import type { Context, FixtureBank } from "../fixtures/types";
import type {
  CheckpointSelectedEvent,
  FramePacket,
  InteractionResolvedEvent,
  KnockdownEvent,
  MatchEvent,
  RecoveryEvent,
} from "../simulation/types";
import {
  RELATION_PRESENTATION_TICKS,
  relationExpiresAt,
} from "./activeRelations";

export interface PresentationFocus {
  readonly orderedPair: readonly [ChickenId, ChickenId];
  readonly context: Context;
  readonly sourceEventId: number | null;
  readonly activeUntilTick: number | null;
  readonly label: string;
  readonly caption: string;
  readonly actions: readonly [string, string] | null;
}

interface PresentationCandidate {
  readonly focus: PresentationFocus;
  readonly priority: number;
  readonly holdTicks: number;
}

interface HeldFocus extends PresentationCandidate {
  readonly holdUntilTick: number;
}

const PRIORITY = {
  fallback: 0,
  movement: 20,
  recovery: 55,
  role: 60,
  modifier: 65,
  support: 70,
  combat: 70,
  shieldSave: 90,
  knockdown: 95,
  spotlight: 100,
} as const;

const HOLD_TICKS = {
  movement: RELATION_PRESENTATION_TICKS.movement,
  support: RELATION_PRESENTATION_TICKS.support,
  combat: RELATION_PRESENTATION_TICKS.combat,
  recovery: 24,
  modifier: 30,
  shieldSave: RELATION_PRESENTATION_TICKS.shieldSave,
  role: 48,
  knockdown: RELATION_PRESENTATION_TICKS.knockdown,
  spotlight: RELATION_PRESENTATION_TICKS.spotlight,
} as const;

function chickenName(id: ChickenId): string {
  return CHICKEN_BY_ID.get(id)?.name ?? id;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function interactionConsequence(event: InteractionResolvedEvent): string {
  const parts: string[] = [];
  for (const damage of event.consequences.damage) {
    if (damage.actualDamage > 0) {
      parts.push(
        `${chickenName(damage.sourceId)} → ${chickenName(damage.targetId)} ${formatNumber(damage.actualDamage)} HP`,
      );
    }
    if (damage.shieldAbsorbed > 0) {
      parts.push(
        `${chickenName(damage.targetId)} SHIELD −${formatNumber(damage.shieldAbsorbed)}`,
      );
    }
  }
  for (const shield of event.consequences.shields) {
    if (shield.appliedAmount > 0) {
      parts.push(
        `${chickenName(shield.sourceId)} COVERS ${chickenName(shield.targetId)} +${formatNumber(shield.appliedAmount)}`,
      );
    }
  }
  for (const movement of event.consequences.movement) {
    parts.push(
      `${chickenName(movement.chickenId)} ${movement.mode.toUpperCase()}`,
    );
  }
  return parts.join(" · ") || "NO STATE CHANGE";
}

function ordinaryCandidate(
  event: InteractionResolvedEvent,
): PresentationCandidate {
  const shieldSave = event.consequences.damage.some(
    (consequence) => consequence.savingSourceIds.length > 0,
  );
  const hasModifier = event.consequences.roleModifiers.length > 0;
  const classification = event.spotlight.selected
    ? {
        priority: PRIORITY.spotlight,
        holdTicks: HOLD_TICKS.spotlight,
        label: `SPOTLIGHT · ${event.spotlight.branchLabel?.replace("_", " ")}`,
      }
    : event.consequences.knockdowns.length > 0
      ? {
          priority: PRIORITY.knockdown,
          holdTicks: HOLD_TICKS.knockdown,
          label: "KNOCKDOWN · JOINT ACTION CONSEQUENCE",
        }
      : shieldSave
        ? {
            priority: PRIORITY.shieldSave,
            holdTicks: HOLD_TICKS.shieldSave,
            label: "SHIELD SAVE · CREDITED RELATION",
          }
        : hasModifier
          ? {
              priority: PRIORITY.modifier,
              holdTicks: HOLD_TICKS.modifier,
              label: "ROLE MODIFIER · APPLIED CONSEQUENCE",
            }
          : event.context === "X"
            ? {
                priority: PRIORITY.combat,
                holdTicks: HOLD_TICKS.combat,
                label: `${event.context} RELATION · ${event.reason.replaceAll("-", " ").toUpperCase()}`,
              }
            : event.context === "Y"
              ? {
                  priority: PRIORITY.support,
                  holdTicks: HOLD_TICKS.support,
                  label: `${event.context} RELATION · ${event.reason.replaceAll("-", " ").toUpperCase()}`,
                }
              : {
                  priority: PRIORITY.movement,
                  holdTicks: HOLD_TICKS.movement,
                  label: `${event.context} RELATION · ${event.reason.replaceAll("-", " ").toUpperCase()}`,
                };

  return {
    priority: classification.priority,
    holdTicks: classification.holdTicks,
    focus: Object.freeze({
      orderedPair: event.orderedPair,
      context: event.context,
      sourceEventId: event.eventId,
      activeUntilTick: relationExpiresAt(event),
      label: classification.label,
      caption: `#${event.eventId} · ${event.actions.a.toUpperCase()} / ${event.actions.b.toUpperCase()} · ${interactionConsequence(event)}`,
      actions: [event.actions.a, event.actions.b] as const,
    }),
  };
}

function knockdownCandidate(
  event: KnockdownEvent,
  source: InteractionResolvedEvent,
): PresentationCandidate {
  return {
    priority: PRIORITY.knockdown,
    holdTicks: HOLD_TICKS.knockdown,
    focus: Object.freeze({
      orderedPair: source.orderedPair,
      context: source.context,
      sourceEventId: event.eventId,
      activeUntilTick: event.tick + HOLD_TICKS.knockdown,
      label: "KNOCKDOWN · JOINT ACTION CONSEQUENCE",
      caption: `#${event.eventId} · KNOCKDOWN · ${chickenName(event.sourceId)} DROPS ${chickenName(event.targetId)} · SOURCE #${event.sourceInteractionEventId}`,
      actions: [source.actions.a, source.actions.b] as const,
    }),
  };
}

function spotlightCandidate(
  event: CheckpointSelectedEvent,
): PresentationCandidate {
  const source = event.resolverEvent;
  return {
    priority: PRIORITY.spotlight,
    holdTicks: HOLD_TICKS.spotlight,
    focus: Object.freeze({
      orderedPair: source.orderedPair,
      context: source.context,
      sourceEventId: event.eventId,
      activeUntilTick: event.tick + HOLD_TICKS.spotlight,
      label: `SPOTLIGHT · ${event.branchLabel.replace("_", " ")}`,
      caption: `#${event.eventId} · ${event.branchLabel.replace("_", " ")} → ${event.childCheckpointId} · SOURCE #${event.sourceInteractionEventId}`,
      actions: [source.actions.a, source.actions.b] as const,
    }),
  };
}

function recoveryCandidate(
  event: RecoveryEvent,
  source: InteractionResolvedEvent,
): PresentationCandidate {
  return {
    priority: PRIORITY.recovery,
    holdTicks: HOLD_TICKS.recovery,
    focus: Object.freeze({
      orderedPair: source.orderedPair,
      context: source.context,
      sourceEventId: event.eventId,
      activeUntilTick: null,
      label: "RECOVERY · RETURN TO FIELD",
      caption: `#${event.eventId} · RECOVERY · ${chickenName(event.chickenId)} RETURNS AT ${formatNumber(event.healthAfter)} HP`,
      actions: [source.actions.a, source.actions.b] as const,
    }),
  };
}

function interactionFromHistory(
  packet: FramePacket,
  predicate: (event: InteractionResolvedEvent) => boolean,
): InteractionResolvedEvent | null {
  return (
    [...packet.snapshot.auditHistory]
      .reverse()
      .find(
        (event): event is InteractionResolvedEvent =>
          event.type === "INTERACTION_RESOLVED" && predicate(event),
      ) ?? null
  );
}

export class PresentationDirector {
  private held: HeldFocus | null = null;
  private trackedChickenId: ChickenId;

  constructor(private readonly bank: FixtureBank) {
    const first = CHICKEN_BY_QUBIT.get(0);
    if (!first) throw new Error("Presenter requires a chicken mapped to q0.");
    this.trackedChickenId = first.id;
  }

  setTrackedChicken(id: ChickenId): void {
    if (id === this.trackedChickenId) return;
    this.trackedChickenId = id;
    this.held = null;
  }

  update(packet: FramePacket): PresentationFocus {
    if (
      packet.events.some(
        (event) =>
          event.type === "MATCH_STARTED" ||
          event.type === "CHECKPOINT_ACTIVATED" ||
          event.type === "ROUND_STARTED",
      )
    ) {
      this.held = null;
    }

    if (this.held && packet.snapshot.tick >= this.held.holdUntilTick) {
      this.held = null;
    }

    const candidates = packet.events
      .map((event) => this.candidateForEvent(packet, event))
      .filter((candidate): candidate is PresentationCandidate => !!candidate)
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          (right.focus.sourceEventId ?? -1) - (left.focus.sourceEventId ?? -1),
      );
    const best = candidates[0];
    if (best) {
      const holdExpired =
        !this.held || packet.snapshot.tick >= this.held.holdUntilTick;
      const moreImportant = !this.held || best.priority > this.held.priority;
      const equallyImportantMajor =
        !!this.held &&
        best.priority === this.held.priority &&
        best.priority >= PRIORITY.shieldSave &&
        best.focus.sourceEventId !== this.held.focus.sourceEventId;
      if (holdExpired || moreImportant || equallyImportantMajor) {
        this.held = Object.freeze({
          ...best,
          holdUntilTick: packet.snapshot.tick + best.holdTicks,
        });
      }
    }
    if (this.held) return this.orientToTracked(this.held.focus);

    const latest = interactionFromHistory(packet, (interaction) =>
      interaction.orderedPair.includes(this.trackedChickenId),
    );
    if (latest) {
      const candidate = ordinaryCandidate(latest);
      const focus = this.orientToTracked({
        ...candidate.focus,
        label: `TRACKING ${chickenName(this.trackedChickenId).toUpperCase()} · ${candidate.focus.label}`,
      });
      this.held = Object.freeze({
        ...candidate,
        focus,
        holdUntilTick: packet.snapshot.tick,
      });
      return focus;
    }

    const checkpoint =
      this.bank.checkpoints[packet.snapshot.activeCheckpointId];
    if (!checkpoint)
      throw new Error(
        `Missing presentation checkpoint ${packet.snapshot.activeCheckpointId}.`,
      );
    const left = CHICKEN_BY_QUBIT.get(checkpoint.spotlight.orderedPair[0]);
    const right = CHICKEN_BY_QUBIT.get(checkpoint.spotlight.orderedPair[1]);
    if (!left || !right)
      throw new Error("Spotlight presentation pair is not mapped to chickens.");
    const checkpointPartner =
      left.id === this.trackedChickenId
        ? right.id
        : right.id === this.trackedChickenId
          ? left.id
          : (CHICKEN_BY_QUBIT.get(
              ((CHICKEN_BY_ID.get(this.trackedChickenId)?.qubit ?? 0) + 1) % 6,
            )?.id ?? right.id);
    const fallback: PresentationFocus = Object.freeze({
      orderedPair: [this.trackedChickenId, checkpointPartner] as const,
      context: checkpoint.spotlight.context,
      sourceEventId: null,
      activeUntilTick: null,
      label: `TRACKING ${chickenName(this.trackedChickenId).toUpperCase()}`,
      caption: `WAITING FOR ${chickenName(this.trackedChickenId).toUpperCase()}'S NEXT PAIR EVENT`,
      actions: null,
    });
    this.held = Object.freeze({
      focus: fallback,
      priority: PRIORITY.fallback,
      holdTicks: 0,
      holdUntilTick: packet.snapshot.tick,
    });
    return fallback;
  }

  reset(): void {
    this.held = null;
  }

  private candidateForEvent(
    packet: FramePacket,
    event: MatchEvent,
  ): PresentationCandidate | null {
    switch (event.type) {
      case "INTERACTION_RESOLVED":
        return event.orderedPair.includes(this.trackedChickenId)
          ? ordinaryCandidate(event)
          : null;
      case "KNOCKDOWN": {
        const source = interactionFromHistory(
          packet,
          (interaction) =>
            interaction.eventId === event.sourceInteractionEventId,
        );
        return source?.orderedPair.includes(this.trackedChickenId)
          ? knockdownCandidate(event, source)
          : null;
      }
      case "CHECKPOINT_SELECTED":
        return event.resolverEvent.orderedPair.includes(this.trackedChickenId)
          ? spotlightCandidate(event)
          : null;
      case "RECOVERED": {
        if (event.chickenId !== this.trackedChickenId) return null;
        const source = interactionFromHistory(packet, (interaction) =>
          interaction.orderedPair.includes(event.chickenId),
        );
        return source ? recoveryCandidate(event, source) : null;
      }
      default:
        return null;
    }
  }

  private orientToTracked(focus: PresentationFocus): PresentationFocus {
    if (focus.orderedPair[0] === this.trackedChickenId) return focus;
    if (focus.orderedPair[1] !== this.trackedChickenId) return focus;
    return Object.freeze({
      ...focus,
      orderedPair: [focus.orderedPair[1], focus.orderedPair[0]] as const,
      actions: focus.actions
        ? ([focus.actions[1], focus.actions[0]] as const)
        : null,
    });
  }
}
