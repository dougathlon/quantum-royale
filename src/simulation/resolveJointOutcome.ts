import { TUNING } from "../config/tuning";
import type { ChickenId } from "../content/chickens";
import type { Context, OutcomeKey } from "../fixtures/types";
import type { ActionName, AnimationIntent } from "./types";

export interface PlannedDamage {
  sourceId: ChickenId;
  targetId: ChickenId;
  amount: number;
}

export interface PlannedShield {
  sourceId: ChickenId;
  targetId: ChickenId;
  amount: number;
}

export interface PlannedMovement {
  chickenId: ChickenId;
  targetId: ChickenId;
  mode: "approach" | "withdraw";
}

export interface JointOutcomePlan {
  actions: { a: ActionName; b: ActionName };
  animationIntents: AnimationIntent[];
  damage: PlannedDamage[];
  shields: PlannedShield[];
  movement: PlannedMovement[];
}

const SIGNS: Record<OutcomeKey, readonly [boolean, boolean]> = {
  pp: [true, true],
  pm: [true, false],
  mp: [false, true],
  mm: [false, false],
};

export function resolveJointOutcome(
  context: Context,
  outcome: OutcomeKey,
  orderedPair: readonly [ChickenId, ChickenId],
): JointOutcomePlan {
  const [a, b] = orderedPair;
  const [aPlus, bPlus] = SIGNS[outcome];
  if (context === "X") {
    const aAction: ActionName = aPlus ? "attack" : "guard";
    const bAction: ActionName = bPlus ? "attack" : "guard";
    const damage: PlannedDamage[] = [];
    if (aPlus) {
      damage.push({
        sourceId: a,
        targetId: b,
        amount: bPlus ? TUNING.mutualAttackDamage : TUNING.blockedAttackDamage,
      });
    }
    if (bPlus) {
      damage.push({
        sourceId: b,
        targetId: a,
        amount: aPlus ? TUNING.mutualAttackDamage : TUNING.blockedAttackDamage,
      });
    }
    return {
      actions: { a: aAction, b: bAction },
      animationIntents: [
        { chickenId: a, action: aAction, targetId: b },
        { chickenId: b, action: bAction, targetId: a },
      ],
      damage,
      shields: [],
      movement: [],
    };
  }

  if (context === "Y") {
    const aAction: ActionName = aPlus ? "cover" : "ignore";
    const bAction: ActionName = bPlus ? "cover" : "ignore";
    const shields: PlannedShield[] = [];
    if (aPlus)
      shields.push({ sourceId: a, targetId: b, amount: TUNING.supportShield });
    if (bPlus)
      shields.push({ sourceId: b, targetId: a, amount: TUNING.supportShield });
    return {
      actions: { a: aAction, b: bAction },
      animationIntents: [
        { chickenId: a, action: aAction, targetId: b },
        { chickenId: b, action: bAction, targetId: a },
      ],
      damage: [],
      shields,
      movement: [],
    };
  }

  const aAction: ActionName = aPlus ? "approach" : "withdraw";
  const bAction: ActionName = bPlus ? "approach" : "withdraw";
  return {
    actions: { a: aAction, b: bAction },
    animationIntents: [
      { chickenId: a, action: aAction, targetId: b },
      { chickenId: b, action: bAction, targetId: a },
    ],
    damage: [],
    shields: [],
    movement: [
      { chickenId: a, targetId: b, mode: aAction },
      { chickenId: b, targetId: a, mode: bAction },
    ],
  };
}
