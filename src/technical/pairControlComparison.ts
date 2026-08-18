import type {
  FixtureBank,
  OutcomeKey,
  ProbabilityVector,
} from "../fixtures/types";
import { FixtureResolver, selectOutcome } from "../fixtures/FixtureResolver";
import { resolveJointOutcome } from "../simulation/resolveJointOutcome";
import type { ActionName, InteractionResolvedEvent } from "../simulation/types";

export interface PairControlComparison {
  readonly sourceEventId: number;
  readonly checkpointId: string;
  readonly orderedPair: InteractionResolvedEvent["orderedPair"];
  readonly context: InteractionResolvedEvent["context"];
  readonly draw: number;
  readonly storedVector: Readonly<ProbabilityVector>;
  readonly controlVector: Readonly<ProbabilityVector>;
  readonly marginals: Readonly<{ aPlus: number; bPlus: number }>;
  readonly storedCovariance: number;
  readonly controlCovariance: number;
  readonly storedOutcome: OutcomeKey;
  readonly controlOutcome: OutcomeKey;
  readonly storedActions: Readonly<{ a: ActionName; b: ActionName }>;
  readonly controlActions: Readonly<{ a: ActionName; b: ActionName }>;
  readonly outcomeChanged: boolean;
}

function marginals(vector: ProbabilityVector): {
  aPlus: number;
  bPlus: number;
} {
  return {
    aPlus: vector.pp + vector.pm,
    bPlus: vector.pp + vector.mp,
  };
}

function covariance(vector: ProbabilityVector): number {
  const rates = marginals(vector);
  return vector.pp - rates.aPlus * rates.bPlus;
}

export function comparePairEventToProductControl(
  bank: FixtureBank,
  event: InteractionResolvedEvent,
): PairControlComparison {
  const resolver = new FixtureResolver(bank);
  const control = resolver.getPairDistribution(
    event.checkpointId,
    [...event.orderedPair],
    event.context,
    "product-control",
  ).probabilities;
  const storedOutcome = selectOutcome(event.probabilities, event.prngDraw);
  const controlOutcome = selectOutcome(control, event.prngDraw);
  const storedActions = resolveJointOutcome(
    event.context,
    storedOutcome,
    event.orderedPair,
  ).actions;
  const controlActions = resolveJointOutcome(
    event.context,
    controlOutcome,
    event.orderedPair,
  ).actions;

  return Object.freeze({
    sourceEventId: event.eventId,
    checkpointId: event.checkpointId,
    orderedPair: event.orderedPair,
    context: event.context,
    draw: event.prngDraw,
    storedVector: Object.freeze({ ...event.probabilities }),
    controlVector: Object.freeze({ ...control }),
    marginals: Object.freeze(marginals(event.probabilities)),
    storedCovariance: covariance(event.probabilities),
    controlCovariance: covariance(control),
    storedOutcome,
    controlOutcome,
    storedActions: Object.freeze({ ...storedActions }),
    controlActions: Object.freeze({ ...controlActions }),
    outcomeChanged: storedOutcome !== controlOutcome,
  });
}
