import {
  CHICKEN_BY_ID,
  CHICKEN_BY_QUBIT,
  type ChickenId,
} from "../content/chickens";
import type {
  Context,
  FixtureBank,
  FixtureCheckpoint,
  OutcomeKey,
  ProbabilityVector,
  ResolvedDistribution,
  ResolverMode,
} from "./types";

function copyVector(vector: ProbabilityVector): ProbabilityVector {
  return { pp: vector.pp, pm: vector.pm, mp: vector.mp, mm: vector.mm };
}

function reverseVector(vector: ProbabilityVector): ProbabilityVector {
  return { pp: vector.pp, pm: vector.mp, mp: vector.pm, mm: vector.mm };
}

export function selectOutcome(
  vector: ProbabilityVector,
  draw: number,
): OutcomeKey {
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
    throw new Error("PRNG draw must be in [0, 1). ");
  let cumulative = 0;
  for (const key of ["pp", "pm", "mp", "mm"] as const) {
    cumulative += vector[key];
    if (draw < cumulative || key === "mm") return key;
  }
  return "mm";
}

export class FixtureResolver {
  constructor(private readonly bank: FixtureBank) {}

  getBank(): FixtureBank {
    return this.bank;
  }

  getCheckpoint(checkpointId: string): FixtureCheckpoint {
    const checkpoint = this.bank.checkpoints[checkpointId];
    if (!checkpoint) throw new Error(`Unknown checkpoint ${checkpointId}.`);
    return checkpoint;
  }

  getPairDistribution(
    checkpointId: string,
    orderedPair: [ChickenId, ChickenId],
    context: Context,
    mode: ResolverMode,
  ): ResolvedDistribution {
    const left = CHICKEN_BY_ID.get(orderedPair[0]);
    const right = CHICKEN_BY_ID.get(orderedPair[1]);
    if (!left || !right || left.id === right.id)
      throw new Error("A distribution requires two known, distinct chickens.");
    const lo = Math.min(left.qubit, right.qubit);
    const hi = Math.max(left.qubit, right.qubit);
    const checkpoint = this.getCheckpoint(checkpointId);
    const pair = checkpoint.pairs[`${lo}-${hi}`];
    if (!pair)
      throw new Error(
        `Checkpoint ${checkpointId} does not admit pair ${lo}-${hi}.`,
      );
    const source =
      mode === "quantum"
        ? pair.distributions[context]
        : pair.productMarginalsControl[context];
    const probabilities =
      left.qubit < right.qubit ? copyVector(source) : reverseVector(source);
    return {
      checkpointId,
      orderedPair,
      qubits: [left.qubit, right.qubit],
      canonicalEdge: [lo, hi],
      context,
      probabilities,
      mode,
      acquisitionSource:
        mode === "quantum"
          ? this.bank.acquisitionSource
          : "classical-product-control",
      shotsPerCircuit: checkpoint.acquisition.shotsPerCircuit,
    };
  }

  chickenForQubit(qubit: number): ChickenId {
    const chicken = CHICKEN_BY_QUBIT.get(qubit);
    if (!chicken) throw new Error(`Unknown qubit ${qubit}.`);
    return chicken.id;
  }
}
