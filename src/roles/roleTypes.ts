import { CHICKEN_BY_ID, type ChickenId } from "../content/chickens";

export const BASE_ROLES = [
  "protector",
  "brawler",
  "pursuer",
  "survivor",
  "connector",
  "lone-wolf",
] as const;

export type BaseRole = (typeof BASE_ROLES)[number];
export type RoleStage = "unformed" | "emerging" | "established";
export type RoleTransitionKind =
  | "stable"
  | "emerged"
  | "strengthened"
  | "weakened"
  | "replaced"
  | "hybridized"
  | "lost";

export type RoleScoreVector = Readonly<Record<BaseRole, number>>;

export interface RoleActionCounts {
  attack: number;
  guard: number;
  cover: number;
  ignore: number;
  approach: number;
  withdraw: number;
}

export interface BehavioralTrace {
  round: 1 | 2 | 3 | 4;
  sourceEventIds: readonly number[];
  xParticipations: number;
  yParticipations: number;
  zParticipations: number;
  actions: Readonly<RoleActionCounts>;
  baseDamageGiven: number;
  baseDamageReceived: number;
  baseShieldGranted: number;
  baseShieldAbsorbedForOthers: number;
  baseShieldAbsorbedReceived: number;
  shieldSaves: number;
  knockdownsGiven: number;
  knockdownsReceived: number;
  mutualAttacks: number;
  opposedPursuits: number;
  pursuitFollowThroughs: number;
  distinctPursuitTargets: number;
  positiveEvents: number;
  distinctPositivePartners: number;
  maxPairPositiveEvents: number;
  distinctProtectedPartners: number;
  endHealth: number;
}

export interface RoleIdentity {
  id: string;
  label: string;
  epithet: string;
  stage: RoleStage;
  components: readonly BaseRole[];
}

export interface RoleModifiers {
  shieldBonus: number;
  attackDamageBonus: number;
  approachSpeedMultiplier: number;
  knockdownReductionTicks: number;
  coverActionLockReductionTicks: number;
  withdrawSpeedMultiplier: number;
}

export interface RoleHistoryEntry {
  round: 1 | 2 | 3 | 4;
  previousIdentity: RoleIdentity;
  identity: RoleIdentity;
  transition: RoleTransitionKind;
  evidence: RoleScoreVector;
  scores: RoleScoreVector;
  trace: BehavioralTrace;
  modifiers: RoleModifiers;
  evaluationEventId: number;
}

export interface ChickenRoleState {
  chickenId: ChickenId;
  canonicalName: string;
  publicName: string;
  identity: RoleIdentity;
  evidence: RoleScoreVector;
  scores: RoleScoreVector;
  modifiers: RoleModifiers;
  history: readonly RoleHistoryEntry[];
  establishedAtRound: 1 | 2 | 3 | 4 | null;
}

export const ROLE_LABELS: Readonly<Record<BaseRole, string>> = {
  protector: "Protector",
  brawler: "Brawler",
  pursuer: "Pursuer",
  survivor: "Survivor",
  connector: "Connector",
  "lone-wolf": "Lone Wolf",
};

export const ROLE_EPITHETS: Readonly<Record<BaseRole, string>> = {
  protector: "Shield",
  brawler: "Bruiser",
  pursuer: "Hunter",
  survivor: "Holdfast",
  connector: "Flockmaker",
  "lone-wolf": "Stray",
};

const HYBRID_NAMES: Readonly<Record<string, string>> = {
  "protector+brawler": "Enforcer",
  "protector+pursuer": "Bodyguard",
  "protector+survivor": "Bulwark",
  "protector+connector": "Shepherd",
  "protector+lone-wolf": "Sentinel",
  "brawler+pursuer": "Marauder",
  "brawler+survivor": "Scrapper",
  "brawler+connector": "Captain",
  "brawler+lone-wolf": "Renegade",
  "pursuer+survivor": "Escape Artist",
  "pursuer+connector": "Scout",
  "pursuer+lone-wolf": "Tracker",
  "survivor+connector": "Anchor",
  "survivor+lone-wolf": "Holdout",
  "connector+lone-wolf": "Maverick",
};

export const NEUTRAL_ROLE_MODIFIERS: RoleModifiers = Object.freeze({
  shieldBonus: 0,
  attackDamageBonus: 0,
  approachSpeedMultiplier: 1,
  knockdownReductionTicks: 0,
  coverActionLockReductionTicks: 0,
  withdrawSpeedMultiplier: 1,
});

const ROLE_MODIFIERS: Readonly<Record<BaseRole, RoleModifiers>> = {
  protector: { ...NEUTRAL_ROLE_MODIFIERS, shieldBonus: 0.5 },
  brawler: { ...NEUTRAL_ROLE_MODIFIERS, attackDamageBonus: 0.25 },
  pursuer: { ...NEUTRAL_ROLE_MODIFIERS, approachSpeedMultiplier: 1.08 },
  survivor: { ...NEUTRAL_ROLE_MODIFIERS, knockdownReductionTicks: 4 },
  connector: {
    ...NEUTRAL_ROLE_MODIFIERS,
    coverActionLockReductionTicks: 2,
  },
  "lone-wolf": { ...NEUTRAL_ROLE_MODIFIERS, withdrawSpeedMultiplier: 1.08 },
};

export function emptyRoleScores(): Record<BaseRole, number> {
  return Object.fromEntries(BASE_ROLES.map((role) => [role, 0])) as Record<
    BaseRole,
    number
  >;
}

export function unformedIdentity(): RoleIdentity {
  return {
    id: "unformed",
    label: "Unformed",
    epithet: "Unwritten",
    stage: "unformed",
    components: [],
  };
}

function hybridKey(roles: readonly BaseRole[]): string {
  return BASE_ROLES.filter((role) => roles.includes(role)).join("+");
}

export function identityFromScores(scores: RoleScoreVector): RoleIdentity {
  const ordered = [...BASE_ROLES].sort(
    (left, right) =>
      scores[right] - scores[left] ||
      BASE_ROLES.indexOf(left) - BASE_ROLES.indexOf(right),
  );
  const first = ordered[0];
  const second = ordered[1];
  if (!first || scores[first] < 42) return unformedIdentity();
  const stage: RoleStage = scores[first] >= 58 ? "established" : "emerging";
  const isHybrid =
    Boolean(second) &&
    scores[second as BaseRole] >= 42 &&
    scores[first] - scores[second as BaseRole] <= 8;
  const components = isHybrid
    ? ([first, second as BaseRole] as const)
    : ([first] as const);
  if (components.length === 2) {
    const key = hybridKey(components);
    const label = HYBRID_NAMES[key];
    if (!label) throw new Error(`Missing hybrid identity for ${key}.`);
    return { id: key, label, epithet: label, stage, components };
  }
  return {
    id: first,
    label: ROLE_LABELS[first],
    epithet: ROLE_EPITHETS[first],
    stage,
    components,
  };
}

export function modifiersForIdentity(identity: RoleIdentity): RoleModifiers {
  if (identity.stage !== "established") return NEUTRAL_ROLE_MODIFIERS;
  const scale = identity.components.length === 2 ? 0.5 : 1;
  const result = { ...NEUTRAL_ROLE_MODIFIERS };
  for (const role of identity.components) {
    const modifier = ROLE_MODIFIERS[role];
    result.shieldBonus += modifier.shieldBonus * scale;
    result.attackDamageBonus += modifier.attackDamageBonus * scale;
    result.approachSpeedMultiplier +=
      (modifier.approachSpeedMultiplier - 1) * scale;
    result.knockdownReductionTicks += modifier.knockdownReductionTicks * scale;
    result.coverActionLockReductionTicks +=
      modifier.coverActionLockReductionTicks * scale;
    result.withdrawSpeedMultiplier +=
      (modifier.withdrawSpeedMultiplier - 1) * scale;
  }
  return result;
}

export function transitionKind(
  previous: RoleIdentity,
  next: RoleIdentity,
): RoleTransitionKind {
  if (previous.id === next.id && previous.stage === next.stage) return "stable";
  if (previous.stage === "unformed" && next.stage !== "unformed")
    return "emerged";
  if (previous.stage !== "unformed" && next.stage === "unformed") return "lost";
  if (previous.id === next.id) {
    if (previous.stage === "emerging" && next.stage === "established")
      return "strengthened";
    return "weakened";
  }
  if (previous.components.length === 1 && next.components.length === 2)
    return "hybridized";
  return "replaced";
}

export function evolvingPublicName(
  chickenId: ChickenId,
  identity: RoleIdentity,
  hasEvaluation: boolean,
): string {
  const profile = CHICKEN_BY_ID.get(chickenId);
  if (!profile) return chickenId;
  if (!hasEvaluation) return profile.name;
  const epithet =
    identity.stage === "unformed"
      ? "The Unwritten"
      : identity.stage === "emerging"
        ? identity.components.length === 2
          ? `Emerging ${identity.epithet}`
          : `Rising ${identity.epithet}`
        : `The ${identity.epithet}`;
  return `${profile.givenName} “${epithet}” ${profile.familyName}`;
}

export function initialRoleState(chickenId: ChickenId): ChickenRoleState {
  const identity = unformedIdentity();
  const profile = CHICKEN_BY_ID.get(chickenId);
  return {
    chickenId,
    canonicalName: profile?.name ?? chickenId,
    publicName: profile?.name ?? chickenId,
    identity,
    evidence: emptyRoleScores(),
    scores: emptyRoleScores(),
    modifiers: NEUTRAL_ROLE_MODIFIERS,
    history: [],
    establishedAtRound: null,
  };
}

export function hybridIdentityNames(): readonly string[] {
  return Object.values(HYBRID_NAMES);
}
