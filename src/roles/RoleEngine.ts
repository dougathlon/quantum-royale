import { CHICKENS, type ChickenId } from "../content/chickens";
import type { InteractionResolvedEvent } from "../simulation/types";
import {
  BASE_ROLES,
  emptyRoleScores,
  evolvingPublicName,
  identityFromScores,
  initialRoleState,
  modifiersForIdentity,
  NEUTRAL_ROLE_MODIFIERS,
  transitionKind,
  type BaseRole,
  type BehavioralTrace,
  type ChickenRoleState,
  type RoleActionCounts,
  type RoleHistoryEntry,
  type RoleScoreVector,
} from "./roleTypes";

interface MutableTrace extends Omit<
  BehavioralTrace,
  "sourceEventIds" | "actions"
> {
  sourceEventIds: number[];
  actions: RoleActionCounts;
  pursuitTargets: Set<ChickenId>;
  protectedPartners: Set<ChickenId>;
  positivePartners: Set<ChickenId>;
  positiveByPartner: Map<ChickenId, number>;
}

export interface RoleRoundEvaluation {
  state: ChickenRoleState;
  historyEntry: Omit<RoleHistoryEntry, "evaluationEventId">;
}

export interface RoleEvaluationOptions {
  /**
   * Interpret the supplied event slice once, after the match, instead of
   * smoothing it into a provisional role that can affect later rounds.
   */
  finalOnly?: boolean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : clamp01(numerator / denominator);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function traceFor(
  round: 1 | 2 | 3 | 4,
  chickenId: ChickenId,
  endHealth: Readonly<Record<ChickenId, number>>,
): MutableTrace {
  return {
    round,
    sourceEventIds: [],
    xParticipations: 0,
    yParticipations: 0,
    zParticipations: 0,
    actions: {
      attack: 0,
      guard: 0,
      cover: 0,
      ignore: 0,
      approach: 0,
      withdraw: 0,
    },
    baseDamageGiven: 0,
    baseDamageReceived: 0,
    baseShieldGranted: 0,
    baseShieldAbsorbedForOthers: 0,
    baseShieldAbsorbedReceived: 0,
    shieldSaves: 0,
    knockdownsGiven: 0,
    knockdownsReceived: 0,
    mutualAttacks: 0,
    opposedPursuits: 0,
    pursuitFollowThroughs: 0,
    distinctPursuitTargets: 0,
    positiveEvents: 0,
    distinctPositivePartners: 0,
    maxPairPositiveEvents: 0,
    distinctProtectedPartners: 0,
    endHealth: endHealth[chickenId],
    pursuitTargets: new Set(),
    protectedPartners: new Set(),
    positivePartners: new Set(),
    positiveByPartner: new Map(),
  };
}

function addPositive(
  trace: MutableTrace,
  partnerId: ChickenId,
  count = 1,
): void {
  trace.positiveEvents += count;
  trace.positivePartners.add(partnerId);
  trace.positiveByPartner.set(
    partnerId,
    (trace.positiveByPartner.get(partnerId) ?? 0) + count,
  );
}

function finalTrace(trace: MutableTrace): BehavioralTrace {
  const {
    pursuitTargets,
    protectedPartners,
    positivePartners,
    positiveByPartner,
    ...publicTrace
  } = trace;
  return {
    ...publicTrace,
    sourceEventIds: [...trace.sourceEventIds],
    actions: { ...trace.actions },
    distinctPursuitTargets: pursuitTargets.size,
    distinctProtectedPartners: protectedPartners.size,
    distinctPositivePartners: positivePartners.size,
    maxPairPositiveEvents: Math.max(0, ...positiveByPartner.values()),
  };
}

export function calculateRoleEvidence(trace: BehavioralTrace): RoleScoreVector {
  const evidence = emptyRoleScores();
  if (trace.baseShieldGranted > 0) {
    evidence.protector =
      100 *
      (0.3 * ratio(trace.actions.cover, trace.yParticipations) +
        0.35 *
          ratio(trace.baseShieldAbsorbedForOthers, trace.baseShieldGranted) +
        0.2 * ratio(trace.distinctProtectedPartners, 5) +
        0.15 * Math.min(trace.shieldSaves, 1));
  }
  if (trace.actions.attack > 0) {
    evidence.brawler =
      100 *
      (0.25 * ratio(trace.actions.attack, trace.xParticipations) +
        0.3 * ratio(trace.baseDamageGiven, 12) +
        0.2 * ratio(trace.mutualAttacks, trace.actions.attack) +
        0.25 * Math.min(trace.knockdownsGiven, 1));
  }
  if (trace.opposedPursuits >= 2) {
    evidence.pursuer =
      100 *
      (0.25 * ratio(trace.actions.approach, trace.zParticipations) +
        0.3 * ratio(trace.opposedPursuits, trace.actions.approach) +
        0.35 * ratio(trace.pursuitFollowThroughs, trace.opposedPursuits) +
        0.1 * ratio(trace.distinctPursuitTargets, 5));
  }
  const pressure = trace.baseDamageReceived + trace.baseShieldAbsorbedReceived;
  if (trace.knockdownsReceived === 0 && pressure >= 4) {
    evidence.survivor =
      100 * (0.7 * ratio(pressure, 12) + 0.3 * ratio(trace.endHealth, 12));
  }
  if (trace.positiveEvents >= 3 && trace.distinctPositivePartners >= 2) {
    const interactionCount = trace.yParticipations + trace.zParticipations;
    const spreadBalance =
      trace.positiveEvents === 0
        ? 0
        : clamp01(
            (1 - trace.maxPairPositiveEvents / trace.positiveEvents) / 0.8,
          );
    evidence.connector =
      100 *
      (0.45 * ratio(trace.distinctPositivePartners, 5) +
        0.3 * ratio(trace.positiveEvents, interactionCount) +
        0.25 * spreadBalance);
  }
  const relevantActions =
    trace.xParticipations + trace.yParticipations + trace.zParticipations;
  const selfProtectiveActions =
    trace.actions.guard + trace.actions.ignore + trace.actions.withdraw;
  const coordinationActions = trace.actions.cover + trace.actions.approach;
  const selfProtectiveRate = ratio(selfProtectiveActions, relevantActions);
  if (relevantActions >= 6 && selfProtectiveRate >= 0.45) {
    evidence["lone-wolf"] =
      100 *
      (0.55 * selfProtectiveRate +
        0.25 * (1 - ratio(trace.distinctPositivePartners, 5)) +
        0.2 * (1 - ratio(coordinationActions, relevantActions)));
  }
  for (const role of BASE_ROLES) evidence[role] = rounded(evidence[role]);
  return evidence;
}

export function updateHistoricalRoleScores(
  previous: RoleScoreVector,
  evidence: RoleScoreVector,
): RoleScoreVector {
  const scores = emptyRoleScores();
  for (const role of BASE_ROLES) {
    scores[role] = rounded(previous[role] * 0.55 + evidence[role] * 0.45);
  }
  return scores;
}

function pairKey(a: ChickenId, b: ChickenId): string {
  return [a, b].sort().join("|");
}

export function evaluateRoleRound(
  round: 1 | 2 | 3 | 4,
  interactions: readonly InteractionResolvedEvent[],
  endHealth: Readonly<Record<ChickenId, number>>,
  previousStates: Readonly<Record<ChickenId, ChickenRoleState>>,
  options: RoleEvaluationOptions = {},
): readonly RoleRoundEvaluation[] {
  const traces = Object.fromEntries(
    CHICKENS.map((chicken) => [
      chicken.id,
      traceFor(round, chicken.id, endHealth),
    ]),
  ) as Record<ChickenId, MutableTrace>;
  const pendingPursuits = new Map<
    string,
    { pursuerId: ChickenId; targetId: ChickenId; tick: number }
  >();

  for (const event of interactions) {
    const [a, b] = event.orderedPair;
    const participants = [
      [a, event.actions.a, b],
      [b, event.actions.b, a],
    ] as const;
    for (const [id, action] of participants) {
      const trace = traces[id];
      trace.sourceEventIds.push(event.eventId);
      trace.actions[action] += 1;
      if (event.context === "X") trace.xParticipations += 1;
      else if (event.context === "Y") trace.yParticipations += 1;
      else trace.zParticipations += 1;
    }

    const key = pairKey(a, b);
    if (event.context === "Z") {
      pendingPursuits.delete(key);
      const aPursues =
        event.actions.a === "approach" && event.actions.b === "withdraw";
      const bPursues =
        event.actions.b === "approach" && event.actions.a === "withdraw";
      if (aPursues || bPursues) {
        const pursuerId = aPursues ? a : b;
        const targetId = aPursues ? b : a;
        traces[pursuerId].opposedPursuits += 1;
        traces[pursuerId].pursuitTargets.add(targetId);
        pendingPursuits.set(key, { pursuerId, targetId, tick: event.tick });
      }
      if (event.actions.a === "approach" && event.actions.b === "approach") {
        addPositive(traces[a], b);
        addPositive(traces[b], a);
      }
    }
    if (event.context === "X") {
      const pursuit = pendingPursuits.get(key);
      if (pursuit && event.tick - pursuit.tick <= 48) {
        traces[pursuit.pursuerId].pursuitFollowThroughs += 1;
        pendingPursuits.delete(key);
      }
      if (event.actions.a === "attack" && event.actions.b === "attack") {
        traces[a].mutualAttacks += 1;
        traces[b].mutualAttacks += 1;
      }
    }

    for (const shield of event.consequences.shields) {
      traces[shield.sourceId].baseShieldGranted += shield.baseAppliedAmount;
    }
    for (const damage of event.consequences.damage) {
      traces[damage.sourceId].baseDamageGiven += damage.baseActualDamage;
      traces[damage.targetId].baseDamageReceived += damage.baseActualDamage;
      traces[damage.targetId].baseShieldAbsorbedReceived +=
        damage.baseShieldAbsorbed;
      for (const credit of damage.shieldCredits) {
        const sourceTrace = traces[credit.sourceId];
        sourceTrace.baseShieldAbsorbedForOthers += credit.baseAmount;
        sourceTrace.protectedPartners.add(damage.targetId);
        if (credit.baseAmount > 0) addPositive(sourceTrace, damage.targetId);
      }
      for (const saverId of damage.savingSourceIds) {
        traces[saverId].shieldSaves += 1;
      }
    }
    for (const knockdown of event.consequences.knockdowns) {
      traces[knockdown.sourceId].knockdownsGiven += 1;
      traces[knockdown.targetId].knockdownsReceived += 1;
    }
  }

  return CHICKENS.map((chicken) => {
    const trace = finalTrace(traces[chicken.id]);
    const evidence = calculateRoleEvidence(trace);
    const previous = previousStates[chicken.id] ?? initialRoleState(chicken.id);
    const scores = options.finalOnly
      ? { ...evidence }
      : updateHistoricalRoleScores(previous.scores, evidence);
    const identity = identityFromScores(scores);
    const transition = transitionKind(previous.identity, identity);
    const modifiers = options.finalOnly
      ? NEUTRAL_ROLE_MODIFIERS
      : round === 4
        ? NEUTRAL_ROLE_MODIFIERS
        : modifiersForIdentity(identity);
    const historyEntry = {
      round,
      previousIdentity: previous.identity,
      identity,
      transition,
      evidence,
      scores,
      trace,
      modifiers,
    } as const;
    const establishedAtRound =
      identity.stage === "established"
        ? (previous.establishedAtRound ?? round)
        : null;
    return {
      historyEntry,
      state: {
        chickenId: chicken.id,
        canonicalName: chicken.name,
        publicName: options.finalOnly
          ? chicken.name
          : evolvingPublicName(chicken.id, identity, true),
        identity,
        evidence,
        scores,
        modifiers,
        history: previous.history,
        establishedAtRound,
      },
    };
  });
}

export function strongestRoleScore(scores: RoleScoreVector): {
  role: BaseRole;
  score: number;
} {
  const role = [...BASE_ROLES].sort(
    (left, right) =>
      scores[right] - scores[left] ||
      BASE_ROLES.indexOf(left) - BASE_ROLES.indexOf(right),
  )[0] as BaseRole;
  return { role, score: scores[role] };
}
