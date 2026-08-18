import type { BetLedgerSnapshot } from "../betting/BetLedger";
import type { ChickenId } from "../content/chickens";
import type {
  BranchLabel,
  Context,
  OutcomeKey,
  ProbabilityVector,
  QuantumAcquisitionSource,
  ResolverMode,
} from "../fixtures/types";
import type { MatchSpeed } from "../config/tuning";
import type {
  BehavioralTrace,
  ChickenRoleState,
  RoleHistoryEntry,
  RoleIdentity,
  RoleModifiers,
  RoleScoreVector,
  RoleTransitionKind,
} from "../roles/roleTypes";

export type MatchPhase = "round" | "intermission" | "finished";
export type InteractionReason =
  | "movement-decision"
  | "injury-proximity"
  | "combat-proximity"
  | "spotlight-fallback";
export type ActionName =
  "attack" | "guard" | "cover" | "ignore" | "approach" | "withdraw";

export interface Vec2 {
  x: number;
  y: number;
}

export interface ChickenSnapshot {
  id: ChickenId;
  qubit: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  health: number;
  maxHealth: number;
  shield: number;
  isDown: boolean;
  isInvulnerable: boolean;
  knockdowns: number;
  damageDealt: number;
  movementMode: "wander" | "approach" | "withdraw";
  movementTargetId: ChickenId | null;
  publicName: string;
  role: ChickenRoleState;
}

export interface RoleModifierApplication {
  chickenId: ChickenId;
  roleIdentityId: string;
  kind:
    | "shield"
    | "attack-damage"
    | "approach-speed"
    | "knockdown-duration"
    | "cover-action-lock"
    | "withdraw-speed";
  baseValue: number;
  modifier: number;
  appliedValue: number;
  sourceRoleEvaluationEventId: number;
}

export interface ShieldAbsorptionCredit {
  sourceId: ChickenId;
  sourceInteractionEventId: number;
  amount: number;
  baseAmount: number;
}

export interface AnimationIntent {
  chickenId: ChickenId;
  action: ActionName | "hit" | "knockdown" | "recover" | "shield";
  targetId: ChickenId | null;
}

export interface DamageConsequence {
  sourceId: ChickenId;
  targetId: ChickenId;
  requestedDamage: number;
  baseRequestedDamage: number;
  modifierAmount: number;
  shieldAbsorbed: number;
  baseShieldAbsorbed: number;
  shieldCredits: readonly ShieldAbsorptionCredit[];
  savingSourceIds: readonly ChickenId[];
  actualDamage: number;
  baseActualDamage: number;
  targetHealthBefore: number;
  targetHealthAfter: number;
  ignoredReason: "down" | "invulnerable" | null;
}

export interface ShieldConsequence {
  sourceId: ChickenId;
  targetId: ChickenId;
  amount: number;
  baseAmount: number;
  modifierAmount: number;
  baseAppliedAmount: number;
  appliedAmount: number;
  shieldAfter: number;
}

export interface MovementConsequence {
  chickenId: ChickenId;
  targetId: ChickenId;
  mode: "approach" | "withdraw";
  untilTick: number;
  roleModifier: RoleModifierApplication | null;
}

export interface KnockdownConsequence {
  sourceId: ChickenId;
  targetId: ChickenId;
  pointAwarded: 1;
  baseDurationTicks: number;
  appliedDurationTicks: number;
  downUntilTick: number;
  roleModifier: RoleModifierApplication | null;
}

export interface ScoreChange {
  chickenId: ChickenId;
  delta: 1;
  scoreAfter: number;
}

export interface InteractionConsequences {
  damage: readonly DamageConsequence[];
  shields: readonly ShieldConsequence[];
  movement: readonly MovementConsequence[];
  knockdowns: readonly KnockdownConsequence[];
  roleModifiers: readonly RoleModifierApplication[];
}

export interface SpotlightResolution {
  eligible: boolean;
  selected: boolean;
  branchLabel: BranchLabel | null;
  pendingChildId: string | null;
}

interface EventBase {
  eventId: number;
  tick: number;
  round: number;
  roundTick: number;
  simulationSeconds: number;
}

export interface InteractionResolvedEvent extends EventBase {
  type: "INTERACTION_RESOLVED";
  checkpointId: string;
  orderedPair: readonly [ChickenId, ChickenId];
  qubits: readonly [number, number];
  canonicalEdge: readonly [number, number];
  context: Context;
  reason: InteractionReason;
  probabilities: Readonly<ProbabilityVector>;
  prngDraw: number;
  jointOutcome: OutcomeKey;
  actions: Readonly<{ a: ActionName; b: ActionName }>;
  animationIntents: readonly AnimationIntent[];
  consequences: InteractionConsequences;
  scoreChanges: readonly ScoreChange[];
  spotlight: SpotlightResolution;
  resolverMode: ResolverMode;
  acquisitionSource: QuantumAcquisitionSource | "classical-product-control";
  shotsPerCircuit: number;
}

export interface KnockdownEvent extends EventBase {
  type: "KNOCKDOWN";
  sourceInteractionEventId: number;
  sourceId: ChickenId;
  targetId: ChickenId;
  scoreAfter: number;
}

export interface RecoveryEvent extends EventBase {
  type: "RECOVERED";
  chickenId: ChickenId;
  healthAfter: number;
  invulnerableUntilTick: number;
}

export interface RoundEvent extends EventBase {
  type: "MATCH_STARTED" | "ROUND_STARTED" | "ROUND_ENDED";
  checkpointId: string;
}

export interface CheckpointSelectedEvent extends EventBase {
  type: "CHECKPOINT_SELECTED";
  sourceInteractionEventId: number;
  parentCheckpointId: string;
  childCheckpointId: string;
  branchLabel: BranchLabel;
  jointOutcome: OutcomeKey;
  resolverEvent: InteractionResolvedEvent;
}

export interface CheckpointActivatedEvent extends EventBase {
  type: "CHECKPOINT_ACTIVATED";
  checkpointId: string;
  parentCheckpointId: string;
}

export interface IntermissionEvent extends EventBase {
  type: "INTERMISSION_STARTED" | "INTERMISSION_ENDED";
  afterRound: 1 | 2 | 3;
  checkpointId: string;
}

export interface RoleEvaluatedEvent extends EventBase {
  type: "ROLE_EVALUATED";
  chickenId: ChickenId;
  previousIdentity: RoleIdentity;
  identity: RoleIdentity;
  transition: RoleTransitionKind;
  evidence: RoleScoreVector;
  scores: RoleScoreVector;
  trace: BehavioralTrace;
  modifiers: RoleModifiers;
  publicName: string;
}

export interface RoleTransitionedEvent extends EventBase {
  type: "ROLE_TRANSITIONED";
  chickenId: ChickenId;
  evaluationEventId: number;
  previousIdentity: RoleIdentity;
  identity: RoleIdentity;
  transition: Exclude<RoleTransitionKind, "stable">;
  publicName: string;
}

export type CommentarySpeaker = "clive-peckham" | "henrietta-hype";
export type CommentaryCategory =
  | "role"
  | "emerging"
  | "combat"
  | "support"
  | "movement"
  | "shield-save"
  | "knockdown"
  | "reversal"
  | "pair-pattern";

export interface CommentaryEvent extends EventBase {
  type: "COMMENTARY_EMITTED";
  speaker: CommentarySpeaker;
  category: CommentaryCategory;
  priority: number;
  templateId: string;
  sourceEventIds: readonly number[];
  slots: Readonly<Record<string, string | number>>;
  text: string;
}

export interface StrongestPairHistory {
  partnerId: ChickenId;
  interactionCount: number;
  covers: number;
  attacks: number;
  pursuits: number;
  sourceEventIds: readonly number[];
}

export interface CharacterProfile {
  chickenId: ChickenId;
  canonicalName: string;
  publicName: string;
  finalIdentity: RoleIdentity;
  roleHistory: readonly RoleHistoryEntry[];
  strongestTraceLabel: string;
  strongestTraceValue: number;
  strongestPair: StrongestPairHistory | null;
  rank: number;
  knockdowns: number;
  matchSummary: {
    damageDealt: number;
    damageReceived: number;
    shieldsGranted: number;
    shieldAbsorbedForOthers: number;
    knockdownsReceived: number;
    attacks: number;
    guards: number;
    covers: number;
    approaches: number;
    withdrawals: number;
    totalInteractions: number;
  };
  interviewLines: readonly string[];
}

export interface InterviewProfileCreatedEvent extends EventBase {
  type: "INTERVIEW_PROFILE_CREATED";
  profile: CharacterProfile;
}

export interface SpotlightTiming {
  checkpointId: string;
  orderedPair: readonly [ChickenId, ChickenId];
  qubits: readonly [number, number];
  context: Context;
  windowOpensAtRoundTick: number;
  reservationStartsAtRoundTick: number;
  fallbackDeadlineRoundTick: number;
}

export interface SpotlightFallbackScheduledEvent
  extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_FALLBACK_SCHEDULED";
}

export interface SpotlightWindowOpenedEvent extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_WINDOW_OPENED";
}

export interface SpotlightFallbackReservationStartedEvent
  extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_FALLBACK_RESERVATION_STARTED";
}

export interface SpotlightFallbackPreparedEvent
  extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_FALLBACK_PREPARED";
  actionLockUntilTicksBefore: readonly [number, number];
  pairCooldownUntilTickBefore: number;
  membersAvailableAfter: readonly [true, true];
  membersDown: readonly [false, false];
  triggerRange: number | null;
  distanceBefore: number;
  distanceAfter: number;
  repositioned: boolean;
  qualifyingReason:
    "peck-range" | "scheduled-protection-pressure" | "movement-decision";
}

export interface SpotlightFallbackDeferredEvent
  extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_FALLBACK_DEFERRED";
  downChickenIds: readonly ChickenId[];
  earliestRecoveryTick: number;
}

export interface SpotlightFallbackUsedEvent extends EventBase, SpotlightTiming {
  type: "SPOTLIGHT_FALLBACK_USED";
  sourceInteractionEventId: number;
}

export interface BetEvent extends EventBase {
  type: "BET_PLACED" | "BET_SKIPPED";
  afterRound: 1 | 2 | 3;
  chickenId: ChickenId | null;
  stake: number;
}

export interface MatchFinishedEvent extends EventBase {
  type: "MATCH_FINISHED";
  winnerId: ChickenId;
  ranking: readonly ChickenId[];
  finalPoints: number;
}

export type MatchEvent =
  | InteractionResolvedEvent
  | KnockdownEvent
  | RecoveryEvent
  | RoundEvent
  | CheckpointSelectedEvent
  | CheckpointActivatedEvent
  | IntermissionEvent
  | RoleEvaluatedEvent
  | RoleTransitionedEvent
  | CommentaryEvent
  | InterviewProfileCreatedEvent
  | SpotlightFallbackScheduledEvent
  | SpotlightWindowOpenedEvent
  | SpotlightFallbackReservationStartedEvent
  | SpotlightFallbackPreparedEvent
  | SpotlightFallbackDeferredEvent
  | SpotlightFallbackUsedEvent
  | BetEvent
  | MatchFinishedEvent;

export interface BranchHistoryEntry {
  afterRound: 1 | 2 | 3;
  parentCheckpointId: string;
  childCheckpointId: string;
  branchLabel: BranchLabel;
  outcome: OutcomeKey;
  sourceInteractionEventId: number;
  resolverEvent: InteractionResolvedEvent;
}

export interface MatchSnapshot {
  seed: number;
  resolverMode: ResolverMode;
  speed: MatchSpeed;
  paused: boolean;
  phase: MatchPhase;
  round: 1 | 2 | 3 | 4;
  roundTick: number;
  roundTicks: number;
  tick: number;
  simulationSeconds: number;
  activeCheckpointId: string;
  pendingCheckpointId: string | null;
  branchHistory: readonly BranchHistoryEntry[];
  spotlightResolved: boolean;
  chickens: readonly ChickenSnapshot[];
  bets: BetLedgerSnapshot;
  winnerId: ChickenId | null;
  ranking: readonly ChickenId[];
  latestInteraction: InteractionResolvedEvent | null;
  roleStates: Readonly<Record<ChickenId, ChickenRoleState>>;
  commentary: readonly CommentaryEvent[];
  interviews: readonly CharacterProfile[];
  auditHistory: readonly MatchEvent[];
}

export interface FramePacket {
  snapshot: MatchSnapshot;
  events: readonly MatchEvent[];
}

export interface DiagnosticResult {
  label: "CLASSICAL PRODUCT-OF-MARGINALS CONTROL";
  seed: number;
  primaryWinnerId: ChickenId;
  primaryRanking: readonly ChickenId[];
  primaryBranchPath: readonly string[];
  primaryFinalRoles: Readonly<Record<ChickenId, string>>;
  primaryRoleTrajectories: Readonly<Record<ChickenId, readonly string[]>>;
  primaryMigrations: number;
  primaryRoleDiversity: number;
  primaryPairNarrativeCount: number;
  winnerId: ChickenId;
  ranking: readonly ChickenId[];
  branchPath: readonly string[];
  interactionCount: number;
  scores: Readonly<Record<ChickenId, number>>;
  finalRoles: Readonly<Record<ChickenId, string>>;
  roleTrajectories: Readonly<Record<ChickenId, readonly string[]>>;
  migrations: number;
  roleDiversity: number;
  pairNarrativeCount: number;
  pairNarrativeDifferences: readonly string[];
}
