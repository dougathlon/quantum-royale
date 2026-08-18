import { BetLedger, type BetTicket } from "../betting/BetLedger";
import { TUNING, type MatchSpeed } from "../config/tuning";
import { CHICKENS, CHICKEN_BY_ID, type ChickenId } from "../content/chickens";
import { FixtureResolver, selectOutcome } from "../fixtures/FixtureResolver";
import type {
  BranchLabel,
  Context,
  FixtureBank,
  OutcomeKey,
  ResolverMode,
} from "../fixtures/types";
import { validateFixtureBank } from "../fixtures/validateFixtureBank";
import {
  CommentaryDirector,
  type CommentaryDraft,
} from "../commentary/CommentaryDirector";
import { buildCharacterProfiles } from "../interviews/InterviewVerbalizer";
import { evaluateRoleRound } from "../roles/RoleEngine";
import {
  initialRoleState,
  type ChickenRoleState,
  type RoleHistoryEntry,
} from "../roles/roleTypes";
import { resolveJointOutcome, type PlannedDamage } from "./resolveJointOutcome";
import { DeterministicRng, mixSeed } from "./rng";
import type {
  AnimationIntent,
  BetEvent,
  BranchHistoryEntry,
  CheckpointActivatedEvent,
  CheckpointSelectedEvent,
  CharacterProfile,
  ChickenSnapshot,
  CommentaryEvent,
  DamageConsequence,
  DiagnosticResult,
  FramePacket,
  InteractionConsequences,
  InteractionReason,
  InteractionResolvedEvent,
  InterviewProfileCreatedEvent,
  IntermissionEvent,
  KnockdownConsequence,
  KnockdownEvent,
  MatchEvent,
  MatchFinishedEvent,
  MatchPhase,
  MatchSnapshot,
  MovementConsequence,
  RecoveryEvent,
  RoleModifierApplication,
  RoleEvaluatedEvent,
  RoleTransitionedEvent,
  RoundEvent,
  ScoreChange,
  ShieldConsequence,
  ShieldAbsorptionCredit,
  SpotlightFallbackDeferredEvent,
  SpotlightFallbackPreparedEvent,
  SpotlightFallbackReservationStartedEvent,
  SpotlightFallbackScheduledEvent,
  SpotlightFallbackUsedEvent,
  SpotlightTiming,
  SpotlightWindowOpenedEvent,
} from "./types";

interface RuntimeChicken {
  id: ChickenId;
  qubit: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  health: number;
  shield: number;
  shieldUntilTick: number;
  shieldGrants: RuntimeShieldGrant[];
  downUntilTick: number;
  invulnerableUntilTick: number;
  knockdowns: number;
  damageDealt: number;
  lastDamagerId: ChickenId | null;
  movementMode: "wander" | "approach" | "withdraw";
  movementTargetId: ChickenId | null;
  movementUntilTick: number;
  wanderAngle: number;
  actionLockUntilTick: number;
}

interface RuntimeShieldGrant {
  sourceId: ChickenId;
  sourceInteractionEventId: number;
  remainingAmount: number;
  remainingBaseAmount: number;
}

interface AppliedDamageBatch {
  damage: DamageConsequence[];
  knockdowns: KnockdownConsequence[];
  scoreChanges: ScoreChange[];
  extraAnimations: AnimationIntent[];
  roleModifiers: RoleModifierApplication[];
}

interface SimulationOptions {
  validateFixtures?: boolean;
}

const SPEEDS: readonly MatchSpeed[] = [1, 2, 4];
const ROUND_VALUES = [1, 2, 3, 4] as const;
const SPOTLIGHT_RESERVATION_LEAD_TICKS = TUNING.spotlightReservationLeadTicks;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child);
  return value;
}

function distanceSquared(a: RuntimeChicken, b: RuntimeChicken): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isIntermissionRound(round: number): round is 1 | 2 | 3 {
  return round === 1 || round === 2 || round === 3;
}

function isMovementDecisionTick(roundTick: number): boolean {
  return roundTick >= 1 && (roundTick - 1) % TUNING.movementDecisionTicks === 0;
}

export class QuantumRoyaleSimulation {
  private readonly bank: FixtureBank;
  private readonly resolver: FixtureResolver;
  private readonly seed: number;
  private readonly resolverMode: ResolverMode;
  private navigationRng!: DeterministicRng;
  private encounterRng!: DeterministicRng;
  private outcomeRng!: DeterministicRng;
  private ledger!: BetLedger;
  private chickens: RuntimeChicken[] = [];
  private speed: MatchSpeed = 1;
  private paused = false;
  private phase: MatchPhase = "round";
  private round: 1 | 2 | 3 | 4 = 1;
  private roundTick = 0;
  private tick = 0;
  private accumulatorSeconds = 0;
  private activeCheckpointId = "round-1-root";
  private pendingCheckpointId: string | null = null;
  private spotlightResolved = false;
  private branchHistory: BranchHistoryEntry[] = [];
  private history: MatchEvent[] = [];
  private outgoingEvents: MatchEvent[] = [];
  private latestInteraction: InteractionResolvedEvent | null = null;
  private eventCounter = 0;
  private winnerId: ChickenId | null = null;
  private ranking: ChickenId[] = [];
  private pairCooldowns = new Map<string, number>();
  private spotlightDeferralLogged = false;
  private roleStates!: Record<ChickenId, ChickenRoleState>;
  private roleEvaluationEventIds!: Record<ChickenId, number>;
  private commentaryDirector!: CommentaryDirector;
  private commentary: CommentaryEvent[] = [];
  private interviews: CharacterProfile[] = [];
  private roundInteractions: InteractionResolvedEvent[] = [];
  private allInteractions: InteractionResolvedEvent[] = [];

  constructor(
    inputBank: unknown,
    seed = 0x260817,
    resolverMode: ResolverMode = "quantum",
    options: SimulationOptions = {},
  ) {
    this.bank =
      options.validateFixtures === false
        ? (inputBank as FixtureBank)
        : validateFixtureBank(inputBank);
    this.resolver = new FixtureResolver(this.bank);
    this.seed = seed >>> 0;
    this.resolverMode = resolverMode;
    this.commentaryDirector = new CommentaryDirector(
      this.seed,
      (id) =>
        this.roleStates?.[id]?.publicName ?? CHICKEN_BY_ID.get(id)?.name ?? id,
    );
    const initialPacket = this.restart();
    this.outgoingEvents = [...initialPacket.events];
  }

  restart(): FramePacket {
    this.navigationRng = new DeterministicRng(mixSeed(this.seed, 0x4e4156));
    this.encounterRng = new DeterministicRng(mixSeed(this.seed, 0x454e43));
    this.outcomeRng = new DeterministicRng(mixSeed(this.seed, 0x4f5554));
    this.ledger = new BetLedger();
    this.speed = 1;
    this.paused = false;
    this.phase = "round";
    this.round = 1;
    this.roundTick = 0;
    this.tick = 0;
    this.accumulatorSeconds = 0;
    this.activeCheckpointId = "round-1-root";
    this.pendingCheckpointId = null;
    this.spotlightResolved = false;
    this.branchHistory = [];
    this.history = [];
    this.outgoingEvents = [];
    this.latestInteraction = null;
    this.eventCounter = 0;
    this.winnerId = null;
    this.ranking = [];
    this.pairCooldowns = new Map();
    this.spotlightDeferralLogged = false;
    this.roleStates = Object.fromEntries(
      CHICKENS.map((profile) => [profile.id, initialRoleState(profile.id)]),
    ) as Record<ChickenId, ChickenRoleState>;
    this.roleEvaluationEventIds = Object.fromEntries(
      CHICKENS.map((profile) => [profile.id, 0]),
    ) as Record<ChickenId, number>;
    this.commentary = [];
    this.interviews = [];
    this.roundInteractions = [];
    this.allInteractions = [];
    this.commentaryDirector.reset();
    this.chickens = CHICKENS.map((profile) => ({
      id: profile.id,
      qubit: profile.qubit,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      facing: profile.qubit < 3 ? 1 : -1,
      health: TUNING.maxHealth,
      shield: 0,
      shieldUntilTick: 0,
      shieldGrants: [],
      downUntilTick: 0,
      invulnerableUntilTick: 0,
      knockdowns: 0,
      damageDealt: 0,
      lastDamagerId: null,
      movementMode: "wander",
      movementTargetId: null,
      movementUntilTick: 0,
      wanderAngle: 0,
      actionLockUntilTick: 0,
    }));
    this.resetRoundBodies(1);
    this.record<RoundEvent>({
      ...this.allocateBase(),
      type: "MATCH_STARTED",
      checkpointId: this.activeCheckpointId,
    });
    this.record<RoundEvent>({
      ...this.allocateBase(),
      type: "ROUND_STARTED",
      checkpointId: this.activeCheckpointId,
    });
    this.recordSpotlightSchedule();
    return this.drainFramePacket();
  }

  setSpeed(speed: MatchSpeed): void {
    if (!SPEEDS.includes(speed))
      throw new Error("Speed must be 1x, 2x, or 4x.");
    this.speed = speed;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.accumulatorSeconds = 0;
  }

  togglePaused(): void {
    this.setPaused(!this.paused);
  }

  updateFrame(wallSeconds: number): FramePacket {
    if (!Number.isFinite(wallSeconds) || wallSeconds < 0) {
      throw new Error(
        "Frame duration must be a finite, non-negative number of seconds.",
      );
    }
    if (!this.paused && this.phase === "round") {
      this.accumulatorSeconds += wallSeconds * this.speed;
      while (
        this.accumulatorSeconds + Number.EPSILON >=
        TUNING.fixedStepSeconds
      ) {
        if (this.phase !== "round" || this.paused) break;
        this.accumulatorSeconds -= TUNING.fixedStepSeconds;
        this.stepTick();
      }
      if (this.phase !== "round") this.accumulatorSeconds = 0;
    }
    return this.drainFramePacket();
  }

  advanceTicks(count: number): FramePacket {
    if (!Number.isInteger(count) || count < 0)
      throw new Error("Tick count must be a non-negative integer.");
    for (let index = 0; index < count && this.phase === "round"; index += 1)
      this.stepTick();
    return this.drainFramePacket();
  }

  placeBet(chickenId: ChickenId, stake: number): BetTicket {
    const afterRound = this.requireIntermission();
    const ticket = this.ledger.place(afterRound, chickenId, stake);
    this.record<BetEvent>({
      ...this.allocateBase(),
      type: "BET_PLACED",
      afterRound,
      chickenId,
      stake,
    });
    return ticket;
  }

  skipBet(): void {
    const afterRound = this.requireIntermission();
    this.ledger.skip(afterRound);
    this.record<BetEvent>({
      ...this.allocateBase(),
      type: "BET_SKIPPED",
      afterRound,
      chickenId: null,
      stake: 0,
    });
  }

  continueFromIntermission(): void {
    const afterRound = this.requireIntermission();
    if (!this.ledger.hasDecision(afterRound)) {
      throw new Error("Place one bet or explicitly skip before continuing.");
    }
    this.record<IntermissionEvent>({
      ...this.allocateBase(),
      type: "INTERMISSION_ENDED",
      afterRound,
      checkpointId: this.activeCheckpointId,
    });
    this.round = ROUND_VALUES[afterRound];
    this.roundTick = 0;
    this.phase = "round";
    this.spotlightResolved = false;
    this.spotlightDeferralLogged = false;
    this.resetRoundBodies(this.round);
    this.commentaryDirector.startRound(this.round);
    this.record<RoundEvent>({
      ...this.allocateBase(),
      type: "ROUND_STARTED",
      checkpointId: this.activeCheckpointId,
    });
    this.recordSpotlightSchedule();
  }

  getSnapshot(): MatchSnapshot {
    return this.createSnapshot();
  }

  drainFramePacket(): FramePacket {
    const events = this.outgoingEvents.splice(0);
    return deepFreeze({ snapshot: this.createSnapshot(), events });
  }

  runProductControlDiagnostic(): DiagnosticResult {
    const ledgerBefore = JSON.stringify(this.ledger.snapshot());
    const complete = (mode: ResolverMode): MatchSnapshot => {
      const simulation = new QuantumRoyaleSimulation(
        this.bank,
        this.seed,
        mode,
        {
          validateFixtures: false,
        },
      );
      simulation.drainFramePacket();
      while (simulation.phase !== "finished") {
        if (simulation.phase === "round") {
          simulation.advanceTicks(TUNING.roundTicks + 1);
        } else {
          simulation.skipBet();
          simulation.continueFromIntermission();
          simulation.drainFramePacket();
        }
      }
      const snapshot = simulation.getSnapshot();
      if (!snapshot.winnerId)
        throw new Error(`${mode} diagnostic did not finish.`);
      return snapshot;
    };
    const summarize = (snapshot: MatchSnapshot) => {
      if (!snapshot.winnerId)
        throw new Error("Cannot summarize an unfinished diagnostic.");
      const scores = Object.fromEntries(
        snapshot.chickens.map((chicken) => [chicken.id, chicken.knockdowns]),
      ) as Record<ChickenId, number>;
      const finalRoles = Object.fromEntries(
        snapshot.chickens.map((chicken) => [
          chicken.id,
          chicken.role.identity.label,
        ]),
      ) as Record<ChickenId, string>;
      const roleTrajectories = Object.fromEntries(
        snapshot.chickens.map((chicken) => [
          chicken.id,
          chicken.role.history.map(
            (entry) => `R${entry.round} ${entry.identity.label}`,
          ),
        ]),
      ) as unknown as Record<ChickenId, readonly string[]>;
      const migrations = snapshot.chickens.reduce((total, chicken) => {
        let chickenMigrations = 0;
        for (let index = 1; index < chicken.role.history.length; index += 1) {
          const previous = chicken.role.history[index - 1];
          const current = chicken.role.history[index];
          if (
            previous?.identity.stage === "established" &&
            current?.identity.stage === "established" &&
            previous.identity.id !== current.identity.id
          ) {
            chickenMigrations += 1;
          }
        }
        return total + chickenMigrations;
      }, 0);
      return {
        winnerId: snapshot.winnerId,
        ranking: [...snapshot.ranking],
        branchPath: snapshot.branchHistory.map(
          (entry) => entry.childCheckpointId,
        ),
        interactionCount: snapshot.auditHistory.filter(
          (event): event is InteractionResolvedEvent =>
            event.type === "INTERACTION_RESOLVED",
        ).length,
        scores,
        finalRoles,
        roleTrajectories,
        migrations,
        roleDiversity: new Set(
          snapshot.chickens
            .filter((chicken) => chicken.role.identity.stage === "established")
            .map((chicken) => chicken.role.identity.id),
        ).size,
        pairNarrativeCount: snapshot.commentary.filter(
          (event) =>
            event.category === "pair-pattern" || event.category === "reversal",
        ).length,
      };
    };
    const primarySnapshot = complete("quantum");
    const controlSnapshot = complete("product-control");
    const primary = summarize(primarySnapshot);
    const control = summarize(controlSnapshot);
    const pairNarrativeDifferences = CHICKENS.flatMap((chicken) => {
      const primaryPair = primarySnapshot.interviews.find(
        (profile) => profile.chickenId === chicken.id,
      )?.strongestPair;
      const controlPair = controlSnapshot.interviews.find(
        (profile) => profile.chickenId === chicken.id,
      )?.strongestPair;
      const primaryLabel = primaryPair
        ? `${primaryPair.partnerId} (${primaryPair.interactionCount})`
        : "none";
      const controlLabel = controlPair
        ? `${controlPair.partnerId} (${controlPair.interactionCount})`
        : "none";
      return primaryLabel === controlLabel
        ? []
        : [`${chicken.id}: primary ${primaryLabel}; control ${controlLabel}`];
    });
    if (JSON.stringify(this.ledger.snapshot()) !== ledgerBefore) {
      throw new Error("Diagnostic mutated the primary betting ledger.");
    }
    return deepFreeze({
      label: "CLASSICAL PRODUCT-OF-MARGINALS CONTROL",
      seed: this.seed,
      primaryWinnerId: primary.winnerId,
      primaryRanking: primary.ranking,
      primaryBranchPath: primary.branchPath,
      primaryFinalRoles: primary.finalRoles,
      primaryRoleTrajectories: primary.roleTrajectories,
      primaryMigrations: primary.migrations,
      primaryRoleDiversity: primary.roleDiversity,
      primaryPairNarrativeCount: primary.pairNarrativeCount,
      winnerId: control.winnerId,
      ranking: control.ranking,
      branchPath: control.branchPath,
      interactionCount: control.interactionCount,
      scores: control.scores,
      finalRoles: control.finalRoles,
      roleTrajectories: control.roleTrajectories,
      migrations: control.migrations,
      roleDiversity: control.roleDiversity,
      pairNarrativeCount: control.pairNarrativeCount,
      pairNarrativeDifferences,
    });
  }

  private stepTick(): void {
    this.tick += 1;
    this.roundTick += 1;
    this.recordSpotlightWindowOpening();
    this.recordSpotlightReservationStart();
    this.recoverAndExpireEffects();
    this.resolveScheduledFallbackBeforeWaves();
    if (isMovementDecisionTick(this.roundTick)) {
      this.scheduleMovementWave();
    }
    this.moveBodies();
    this.scheduleSupportEngagements();
    this.scheduleCombatEngagements();
    if (this.roundTick >= TUNING.roundTicks) this.endRound();
  }

  private recoverAndExpireEffects(): void {
    for (const chicken of this.chickens) {
      if (chicken.shield > 0 && this.tick >= chicken.shieldUntilTick) {
        chicken.shield = 0;
        chicken.shieldUntilTick = 0;
        chicken.shieldGrants = [];
      }
      if (chicken.downUntilTick > 0 && this.tick >= chicken.downUntilTick) {
        chicken.downUntilTick = 0;
        chicken.health = TUNING.maxHealth;
        chicken.invulnerableUntilTick = this.tick + TUNING.invulnerabilityTicks;
        this.record<RecoveryEvent>({
          ...this.allocateBase(),
          type: "RECOVERED",
          chickenId: chicken.id,
          healthAfter: chicken.health,
          invulnerableUntilTick: chicken.invulnerableUntilTick,
        });
      }
    }
  }

  private scheduleMovementWave(): void {
    const spotlight = this.reservedSpotlightOpportunity("Z");
    if (spotlight) {
      const a = this.requireChicken(spotlight.orderedPair[0]);
      const b = this.requireChicken(spotlight.orderedPair[1]);
      if (
        !this.isDown(a) &&
        !this.isDown(b) &&
        this.isActionAvailable(a) &&
        this.isActionAvailable(b) &&
        this.isPairAvailable(a.id, b.id, "Z")
      ) {
        this.resolveInteraction(
          [...spotlight.orderedPair],
          "Z",
          "movement-decision",
        );
      }
    }

    const available = this.chickens.filter(
      (chicken) =>
        !this.isDown(chicken) &&
        this.isActionAvailable(chicken) &&
        !this.isSpotlightReservedChicken(chicken.id),
    );
    for (let index = available.length - 1; index > 0; index -= 1) {
      const swapIndex = this.encounterRng.int(index + 1);
      const temporary = available[index];
      available[index] = available[swapIndex] as RuntimeChicken;
      available[swapIndex] = temporary as RuntimeChicken;
    }
    for (let index = 0; index + 1 < available.length; index += 2) {
      const a = available[index];
      const b = available[index + 1];
      if (a && b && this.isPairAvailable(a.id, b.id, "Z")) {
        this.resolveInteraction([a.id, b.id], "Z", "movement-decision");
      }
    }
  }

  private scheduleCombatEngagements(): void {
    const rangeSquared = TUNING.combatRange * TUNING.combatRange;
    const spotlight = this.reservedSpotlightOpportunity("X");
    if (spotlight) {
      const a = this.requireChicken(spotlight.orderedPair[0]);
      const b = this.requireChicken(spotlight.orderedPair[1]);
      if (
        !this.isDown(a) &&
        !this.isDown(b) &&
        this.isActionAvailable(a) &&
        this.isActionAvailable(b) &&
        this.isPairAvailable(a.id, b.id, "X") &&
        distanceSquared(a, b) <= rangeSquared
      ) {
        this.resolveInteraction(
          [...spotlight.orderedPair],
          "X",
          "combat-proximity",
        );
      }
    }

    const candidates: Array<{
      a: RuntimeChicken;
      b: RuntimeChicken;
      distance: number;
    }> = [];
    for (let left = 0; left < this.chickens.length; left += 1) {
      for (let right = left + 1; right < this.chickens.length; right += 1) {
        const a = this.chickens[left];
        const b = this.chickens[right];
        if (
          !a ||
          !b ||
          this.isDown(a) ||
          this.isDown(b) ||
          this.isSpotlightReservedChicken(a.id) ||
          this.isSpotlightReservedChicken(b.id) ||
          !this.isActionAvailable(a) ||
          !this.isActionAvailable(b) ||
          !this.isPairAvailable(a.id, b.id, "X")
        ) {
          continue;
        }
        const distance = distanceSquared(a, b);
        if (distance <= rangeSquared) candidates.push({ a, b, distance });
      }
    }
    candidates.sort(
      (left, right) =>
        left.distance - right.distance ||
        left.a.qubit - right.a.qubit ||
        left.b.qubit - right.b.qubit,
    );
    const used = new Set<ChickenId>();
    for (const candidate of candidates) {
      if (used.has(candidate.a.id) || used.has(candidate.b.id)) continue;
      used.add(candidate.a.id);
      used.add(candidate.b.id);
      this.resolveInteraction(
        [candidate.a.id, candidate.b.id],
        "X",
        "combat-proximity",
      );
    }
  }

  private scheduleSupportEngagements(): void {
    const rangeSquared = TUNING.supportRange * TUNING.supportRange;
    const spotlight = this.reservedSpotlightOpportunity("Y");
    if (spotlight) {
      const a = this.requireChicken(spotlight.orderedPair[0]);
      const b = this.requireChicken(spotlight.orderedPair[1]);
      if (
        !this.isDown(a) &&
        !this.isDown(b) &&
        this.isActionAvailable(a) &&
        this.isActionAvailable(b) &&
        this.isPairAvailable(a.id, b.id, "Y") &&
        distanceSquared(a, b) <= rangeSquared &&
        (this.isSupportOpportunityTarget(a) ||
          this.isSupportOpportunityTarget(b))
      ) {
        this.resolveInteraction(
          [...spotlight.orderedPair],
          "Y",
          "injury-proximity",
        );
      }
    }

    const targets = [...this.chickens]
      .filter(
        (chicken) =>
          !this.isDown(chicken) &&
          !this.isSpotlightReservedChicken(chicken.id) &&
          this.isActionAvailable(chicken) &&
          this.isSupportOpportunityTarget(chicken),
      )
      .sort(
        (left, right) => left.health - right.health || left.qubit - right.qubit,
      );
    const used = new Set<ChickenId>();
    for (const target of targets) {
      if (used.has(target.id)) continue;
      const helper = this.chickens
        .filter(
          (candidate) =>
            candidate.id !== target.id &&
            !used.has(candidate.id) &&
            !this.isDown(candidate) &&
            !this.isSpotlightReservedChicken(candidate.id) &&
            this.isActionAvailable(candidate) &&
            this.isPairAvailable(candidate.id, target.id, "Y") &&
            distanceSquared(candidate, target) <= rangeSquared,
        )
        .sort(
          (left, right) =>
            distanceSquared(left, target) - distanceSquared(right, target) ||
            left.qubit - right.qubit,
        )[0];
      if (!helper) continue;
      used.add(helper.id);
      used.add(target.id);
      this.resolveInteraction([helper.id, target.id], "Y", "injury-proximity");
    }
  }

  private resolveScheduledFallbackBeforeWaves(): void {
    if (this.spotlightResolved || this.round === 4) return;
    const timing = this.spotlightTiming();
    if (this.roundTick < timing.fallbackDeadlineRoundTick) return;
    if (!this.prepareSpotlightFallback(timing)) return;
    const interaction = this.resolveInteraction(
      [...timing.orderedPair],
      timing.context,
      "spotlight-fallback",
    );
    if (!this.spotlightResolved)
      throw new Error("Spotlight fallback failed to select a compiled child.");
    if (!interaction.spotlight.selected)
      throw new Error("Spotlight fallback interaction was not selected.");
  }

  private recordSpotlightSchedule(): void {
    if (this.round === 4) return;
    const timing = this.spotlightTiming();
    this.record<SpotlightFallbackScheduledEvent>({
      ...this.allocateBase(),
      type: "SPOTLIGHT_FALLBACK_SCHEDULED",
      ...timing,
    });
    if (timing.windowOpensAtRoundTick === this.roundTick) {
      this.record<SpotlightWindowOpenedEvent>({
        ...this.allocateBase(),
        type: "SPOTLIGHT_WINDOW_OPENED",
        ...timing,
      });
    }
    if (timing.reservationStartsAtRoundTick === this.roundTick) {
      this.recordSpotlightReservation(timing);
    }
  }

  private recordSpotlightWindowOpening(): void {
    if (this.round === 4) return;
    const timing = this.spotlightTiming();
    if (this.roundTick !== timing.windowOpensAtRoundTick) return;
    this.record<SpotlightWindowOpenedEvent>({
      ...this.allocateBase(),
      type: "SPOTLIGHT_WINDOW_OPENED",
      ...timing,
    });
  }

  private recordSpotlightReservationStart(): void {
    if (this.spotlightResolved || this.round === 4) return;
    const timing = this.spotlightTiming();
    if (this.roundTick !== timing.reservationStartsAtRoundTick) return;
    this.recordSpotlightReservation(timing);
  }

  private recordSpotlightReservation(timing: SpotlightTiming): void {
    this.record<SpotlightFallbackReservationStartedEvent>({
      ...this.allocateBase(),
      type: "SPOTLIGHT_FALLBACK_RESERVATION_STARTED",
      ...timing,
    });
  }

  private spotlightTiming(): SpotlightTiming {
    const checkpoint = this.resolver.getCheckpoint(this.activeCheckpointId);
    const qubits: [number, number] = [...checkpoint.spotlight.orderedPair];
    const orderedPair: [ChickenId, ChickenId] = [
      this.resolver.chickenForQubit(qubits[0]),
      this.resolver.chickenForQubit(qubits[1]),
    ];
    return {
      checkpointId: this.activeCheckpointId,
      orderedPair,
      qubits,
      context: checkpoint.spotlight.context,
      windowOpensAtRoundTick: Math.round(
        checkpoint.spotlight.windowOpensAtSeconds * TUNING.ticksPerSecond,
      ),
      reservationStartsAtRoundTick: Math.max(
        0,
        Math.round(
          checkpoint.spotlight.fallbackDeadlineSeconds * TUNING.ticksPerSecond,
        ) - SPOTLIGHT_RESERVATION_LEAD_TICKS,
      ),
      fallbackDeadlineRoundTick: Math.round(
        checkpoint.spotlight.fallbackDeadlineSeconds * TUNING.ticksPerSecond,
      ),
    };
  }

  private prepareSpotlightFallback(timing: SpotlightTiming): boolean {
    const [aId, bId] = timing.orderedPair;
    const a = this.requireChicken(aId);
    const b = this.requireChicken(bId);
    const downChickens = [a, b].filter((chicken) => this.isDown(chicken));
    if (downChickens.length > 0) {
      if (!this.spotlightDeferralLogged) {
        this.record<SpotlightFallbackDeferredEvent>({
          ...this.allocateBase(),
          type: "SPOTLIGHT_FALLBACK_DEFERRED",
          ...timing,
          downChickenIds: downChickens.map((chicken) => chicken.id),
          earliestRecoveryTick: Math.max(
            ...downChickens.map((chicken) => chicken.downUntilTick),
          ),
        });
        this.spotlightDeferralLogged = true;
      }
      return false;
    }

    const actionLockUntilTicksBefore: [number, number] = [
      a.actionLockUntilTick,
      b.actionLockUntilTick,
    ];
    const cooldownKey = this.pairCooldownKey(a.id, b.id, timing.context);
    const pairCooldownUntilTickBefore =
      this.pairCooldowns.get(cooldownKey) ?? 0;
    a.actionLockUntilTick = Math.min(a.actionLockUntilTick, this.tick);
    b.actionLockUntilTick = Math.min(b.actionLockUntilTick, this.tick);
    this.pairCooldowns.delete(cooldownKey);

    const distanceBefore = Math.sqrt(distanceSquared(a, b));
    const triggerRange =
      timing.context === "X"
        ? TUNING.combatRange
        : timing.context === "Y"
          ? TUNING.supportRange
          : null;
    const repositioned =
      triggerRange !== null && distanceBefore > triggerRange
        ? this.positionPairWithinRange(a, b, triggerRange)
        : false;
    const distanceAfter = Math.sqrt(distanceSquared(a, b));
    if (
      this.isDown(a) ||
      this.isDown(b) ||
      !this.isActionAvailable(a) ||
      !this.isActionAvailable(b) ||
      !this.isPairAvailable(a.id, b.id, timing.context) ||
      (triggerRange !== null && distanceAfter > triggerRange)
    ) {
      throw new Error(
        "Spotlight scheduler failed to create an eligible fallback.",
      );
    }

    this.record<SpotlightFallbackPreparedEvent>({
      ...this.allocateBase(),
      type: "SPOTLIGHT_FALLBACK_PREPARED",
      ...timing,
      actionLockUntilTicksBefore,
      pairCooldownUntilTickBefore,
      membersAvailableAfter: [true, true],
      membersDown: [false, false],
      triggerRange,
      distanceBefore,
      distanceAfter,
      repositioned,
      qualifyingReason:
        timing.context === "X"
          ? "peck-range"
          : timing.context === "Y"
            ? "scheduled-protection-pressure"
            : "movement-decision",
    });
    return true;
  }

  private positionPairWithinRange(
    a: RuntimeChicken,
    b: RuntimeChicken,
    triggerRange: number,
  ): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const directionX =
      length > 0.001 ? dx / length : a.qubit < b.qubit ? 1 : -1;
    const directionY = length > 0.001 ? dy / length : 0;
    const targetDistance = triggerRange * 0.72;
    const halfX = Math.abs(directionX) * targetDistance * 0.5;
    const halfY = Math.abs(directionY) * targetDistance * 0.5;
    const minimumY = TUNING.arenaPadding + 30;
    const midpointX = clamp(
      (a.x + b.x) * 0.5,
      TUNING.arenaPadding + halfX,
      TUNING.arenaWidth - TUNING.arenaPadding - halfX,
    );
    const midpointY = clamp(
      (a.y + b.y) * 0.5,
      minimumY + halfY,
      TUNING.arenaHeight - TUNING.arenaPadding - halfY,
    );
    a.x = midpointX - directionX * targetDistance * 0.5;
    a.y = midpointY - directionY * targetDistance * 0.5;
    b.x = midpointX + directionX * targetDistance * 0.5;
    b.y = midpointY + directionY * targetDistance * 0.5;
    return true;
  }

  private resolveInteraction(
    orderedPair: [ChickenId, ChickenId],
    context: Context,
    reason: InteractionReason,
  ): InteractionResolvedEvent {
    const distribution = this.resolver.getPairDistribution(
      this.activeCheckpointId,
      orderedPair,
      context,
      this.resolverMode,
    );
    const draw = this.outcomeRng.next();
    const outcome = selectOutcome(distribution.probabilities, draw);
    const plan = resolveJointOutcome(context, outcome, orderedPair);
    const interactionEventId = this.nextEventId();
    this.lockInteraction(orderedPair, context);
    const roleModifiers: RoleModifierApplication[] = [];

    const shields: ShieldConsequence[] = [];
    for (const planned of plan.shields) {
      const sourceRole = this.roleStates[planned.sourceId];
      const target = this.requireChicken(planned.targetId);
      if (this.isDown(target)) continue;
      const availableCapacity = Math.max(
        0,
        TUNING.supportShield * 2 - target.shield,
      );
      const baseAppliedAmount = Math.min(planned.amount, availableCapacity);
      const modifierAmount = Math.min(
        sourceRole.modifiers.shieldBonus,
        Math.max(0, availableCapacity - baseAppliedAmount),
      );
      const appliedAmount = baseAppliedAmount + modifierAmount;
      target.shield += appliedAmount;
      target.shieldUntilTick = this.tick + TUNING.shieldTicks;
      if (appliedAmount > 0) {
        target.shieldGrants.push({
          sourceId: planned.sourceId,
          sourceInteractionEventId: interactionEventId,
          remainingAmount: appliedAmount,
          remainingBaseAmount: baseAppliedAmount,
        });
      }
      shields.push({
        sourceId: planned.sourceId,
        targetId: planned.targetId,
        amount: appliedAmount,
        baseAmount: planned.amount,
        modifierAmount,
        baseAppliedAmount,
        appliedAmount,
        shieldAfter: target.shield,
      });
      if (modifierAmount > 0) {
        roleModifiers.push(
          this.roleModifierApplication(
            planned.sourceId,
            "shield",
            planned.amount,
            modifierAmount,
            planned.amount + modifierAmount,
          ),
        );
      }
      const lockReduction = sourceRole.modifiers.coverActionLockReductionTicks;
      if (lockReduction > 0) {
        const source = this.requireChicken(planned.sourceId);
        const before = source.actionLockUntilTick;
        source.actionLockUntilTick = Math.max(
          this.tick,
          source.actionLockUntilTick - lockReduction,
        );
        roleModifiers.push(
          this.roleModifierApplication(
            planned.sourceId,
            "cover-action-lock",
            before - this.tick,
            -lockReduction,
            source.actionLockUntilTick - this.tick,
          ),
        );
      }
    }

    const movement: MovementConsequence[] = [];
    for (let index = 0; index < plan.movement.length; index += 1) {
      const planned = plan.movement[index];
      if (!planned) continue;
      const chicken = this.requireChicken(planned.chickenId);
      if (this.isDown(chicken)) continue;
      chicken.movementMode = planned.mode;
      chicken.movementTargetId = planned.targetId;
      chicken.movementUntilTick = this.tick + TUNING.movementIntentTicks;
      const role = this.roleStates[planned.chickenId];
      const otherAction = index === 0 ? plan.actions.b : plan.actions.a;
      const multiplier =
        planned.mode === "withdraw"
          ? role.modifiers.withdrawSpeedMultiplier
          : otherAction === "withdraw"
            ? role.modifiers.approachSpeedMultiplier
            : 1;
      const roleModifier =
        multiplier > 1
          ? (() => {
              const baseSpeed =
                TUNING.baseSpeed * (planned.mode === "withdraw" ? 1.12 : 1);
              return this.roleModifierApplication(
                planned.chickenId,
                planned.mode === "withdraw"
                  ? "withdraw-speed"
                  : "approach-speed",
                baseSpeed,
                baseSpeed * (multiplier - 1),
                baseSpeed * multiplier,
              );
            })()
          : null;
      if (roleModifier) roleModifiers.push(roleModifier);
      movement.push({
        chickenId: planned.chickenId,
        targetId: planned.targetId,
        mode: planned.mode,
        untilTick: chicken.movementUntilTick,
        roleModifier,
      });
    }

    const applied = this.applyDamageBatch(plan.damage);
    roleModifiers.push(...applied.roleModifiers);
    const spotlight = this.resolveSpotlightSelection(
      orderedPair,
      context,
      outcome,
      reason,
    );
    const consequences: InteractionConsequences = {
      damage: applied.damage,
      shields,
      movement,
      knockdowns: applied.knockdowns,
      roleModifiers,
    };
    const event: InteractionResolvedEvent = {
      ...this.baseForReservedId(interactionEventId),
      type: "INTERACTION_RESOLVED",
      checkpointId: distribution.checkpointId,
      orderedPair: [...orderedPair],
      qubits: [...distribution.qubits],
      canonicalEdge: [...distribution.canonicalEdge],
      context,
      reason,
      probabilities: { ...distribution.probabilities },
      prngDraw: draw,
      jointOutcome: outcome,
      actions: plan.actions,
      animationIntents: [...plan.animationIntents, ...applied.extraAnimations],
      consequences,
      scoreChanges: applied.scoreChanges,
      spotlight,
      resolverMode: this.resolverMode,
      acquisitionSource: distribution.acquisitionSource,
      shotsPerCircuit: distribution.shotsPerCircuit,
    };
    const immutableEvent = this.record(event);
    this.latestInteraction = immutableEvent;
    this.roundInteractions.push(immutableEvent);
    this.allInteractions.push(immutableEvent);

    if (reason === "spotlight-fallback" && spotlight.selected) {
      this.record<SpotlightFallbackUsedEvent>({
        ...this.allocateBase(),
        type: "SPOTLIGHT_FALLBACK_USED",
        ...this.spotlightTiming(),
        sourceInteractionEventId: immutableEvent.eventId,
      });
    }

    let resolverEvent: InteractionResolvedEvent | null = null;
    if (
      spotlight.selected &&
      spotlight.branchLabel &&
      spotlight.pendingChildId
    ) {
      resolverEvent = immutableEvent;
      this.branchHistory.push({
        afterRound: this.round as 1 | 2 | 3,
        parentCheckpointId: this.activeCheckpointId,
        childCheckpointId: spotlight.pendingChildId,
        branchLabel: spotlight.branchLabel,
        outcome,
        sourceInteractionEventId: interactionEventId,
        resolverEvent,
      });
    }

    for (const knockdown of applied.knockdowns) {
      const source = this.requireChicken(knockdown.sourceId);
      this.record<KnockdownEvent>({
        ...this.allocateBase(),
        type: "KNOCKDOWN",
        sourceInteractionEventId: interactionEventId,
        sourceId: knockdown.sourceId,
        targetId: knockdown.targetId,
        scoreAfter: source.knockdowns,
      });
    }
    if (
      spotlight.selected &&
      spotlight.branchLabel &&
      spotlight.pendingChildId
    ) {
      if (!resolverEvent)
        throw new Error(
          "Selected branch is missing its resolver event record.",
        );
      this.record<CheckpointSelectedEvent>({
        ...this.allocateBase(),
        type: "CHECKPOINT_SELECTED",
        sourceInteractionEventId: interactionEventId,
        parentCheckpointId: this.activeCheckpointId,
        childCheckpointId: spotlight.pendingChildId,
        branchLabel: spotlight.branchLabel,
        jointOutcome: outcome,
        resolverEvent,
      });
    }
    const commentary =
      this.commentaryDirector.considerInteraction(immutableEvent);
    if (commentary) this.emitCommentary(commentary);
    return immutableEvent;
  }

  private applyDamageBatch(
    plans: readonly PlannedDamage[],
  ): AppliedDamageBatch {
    const result: AppliedDamageBatch = {
      damage: [],
      knockdowns: [],
      scoreChanges: [],
      extraAnimations: [],
      roleModifiers: [],
    };
    for (const planned of plans) {
      const source = this.requireChicken(planned.sourceId);
      const target = this.requireChicken(planned.targetId);
      const sourceRole = this.roleStates[source.id];
      const modifierAmount = sourceRole.modifiers.attackDamageBonus;
      const requestedDamage = planned.amount + modifierAmount;
      let ignoredReason: "down" | "invulnerable" | null = null;
      if (this.isDown(target)) ignoredReason = "down";
      else if (this.isInvulnerable(target)) ignoredReason = "invulnerable";
      const targetHealthBefore = target.health;
      const shieldConsumption = ignoredReason
        ? { amount: 0, baseAmount: 0, credits: [] as ShieldAbsorptionCredit[] }
        : this.consumeShield(target, Math.max(0, requestedDamage));
      const shieldAbsorbed = shieldConsumption.amount;
      const damageAfterShield = Math.max(0, requestedDamage - shieldAbsorbed);
      const actualDamage = ignoredReason
        ? 0
        : Math.min(target.health, damageAfterShield);
      const baseActualDamage = ignoredReason
        ? 0
        : Math.min(
            targetHealthBefore,
            Math.max(0, planned.amount - shieldConsumption.baseAmount),
          );
      if (!ignoredReason) {
        target.health = Math.max(0, target.health - actualDamage);
        if (actualDamage > 0) {
          target.lastDamagerId = source.id;
          source.damageDealt += actualDamage;
          result.extraAnimations.push({
            chickenId: target.id,
            action: "hit",
            targetId: source.id,
          });
        }
      }
      const savingSourceIds =
        !ignoredReason &&
        planned.amount >= targetHealthBefore &&
        actualDamage < targetHealthBefore
          ? [
              ...new Set(
                shieldConsumption.credits
                  .filter((credit) => credit.baseAmount > 0)
                  .map((credit) => credit.sourceId),
              ),
            ]
          : [];
      result.damage.push({
        sourceId: source.id,
        targetId: target.id,
        requestedDamage,
        baseRequestedDamage: planned.amount,
        modifierAmount,
        shieldAbsorbed,
        baseShieldAbsorbed: shieldConsumption.baseAmount,
        shieldCredits: shieldConsumption.credits,
        savingSourceIds,
        actualDamage,
        baseActualDamage,
        targetHealthBefore,
        targetHealthAfter: target.health,
        ignoredReason,
      });
      if (modifierAmount > 0) {
        result.roleModifiers.push(
          this.roleModifierApplication(
            source.id,
            "attack-damage",
            planned.amount,
            modifierAmount,
            requestedDamage,
          ),
        );
      }
      if (
        !ignoredReason &&
        actualDamage > 0 &&
        target.health <= 0 &&
        target.downUntilTick === 0
      ) {
        const reduction =
          this.roleStates[target.id].modifiers.knockdownReductionTicks;
        const appliedDurationTicks = Math.max(
          1,
          TUNING.knockdownTicks - reduction,
        );
        target.downUntilTick = this.tick + appliedDurationTicks;
        target.vx = 0;
        target.vy = 0;
        target.shield = 0;
        target.shieldUntilTick = 0;
        target.shieldGrants = [];
        source.knockdowns += 1;
        result.knockdowns.push({
          sourceId: source.id,
          targetId: target.id,
          pointAwarded: 1,
          baseDurationTicks: TUNING.knockdownTicks,
          appliedDurationTicks,
          downUntilTick: target.downUntilTick,
          roleModifier:
            reduction > 0
              ? this.roleModifierApplication(
                  target.id,
                  "knockdown-duration",
                  TUNING.knockdownTicks,
                  -reduction,
                  appliedDurationTicks,
                )
              : null,
        });
        if (reduction > 0) {
          result.roleModifiers.push(
            this.roleModifierApplication(
              target.id,
              "knockdown-duration",
              TUNING.knockdownTicks,
              -reduction,
              appliedDurationTicks,
            ),
          );
        }
        result.scoreChanges.push({
          chickenId: source.id,
          delta: 1,
          scoreAfter: source.knockdowns,
        });
        result.extraAnimations.push({
          chickenId: target.id,
          action: "knockdown",
          targetId: source.id,
        });
      }
    }
    return result;
  }

  private consumeShield(
    target: RuntimeChicken,
    requestedAmount: number,
  ): {
    amount: number;
    baseAmount: number;
    credits: ShieldAbsorptionCredit[];
  } {
    let remaining = Math.min(target.shield, requestedAmount);
    let amount = 0;
    let baseAmount = 0;
    const credits: ShieldAbsorptionCredit[] = [];
    while (remaining > 0.000_001 && target.shieldGrants.length > 0) {
      const grant = target.shieldGrants[0];
      if (!grant) break;
      const consumed = Math.min(grant.remainingAmount, remaining);
      const consumedBase = Math.min(grant.remainingBaseAmount, consumed);
      grant.remainingAmount -= consumed;
      grant.remainingBaseAmount -= consumedBase;
      remaining -= consumed;
      amount += consumed;
      baseAmount += consumedBase;
      credits.push({
        sourceId: grant.sourceId,
        sourceInteractionEventId: grant.sourceInteractionEventId,
        amount: consumed,
        baseAmount: consumedBase,
      });
      if (grant.remainingAmount <= 0.000_001) target.shieldGrants.shift();
    }
    target.shield = Math.max(0, target.shield - amount);
    if (target.shield <= 0.000_001) {
      target.shield = 0;
      target.shieldUntilTick = 0;
      target.shieldGrants = [];
    }
    return { amount, baseAmount, credits };
  }

  private roleModifierApplication(
    chickenId: ChickenId,
    kind: RoleModifierApplication["kind"],
    baseValue: number,
    modifier: number,
    appliedValue: number,
  ): RoleModifierApplication {
    const sourceRoleEvaluationEventId =
      this.roleEvaluationEventIds[chickenId] ?? 0;
    if (sourceRoleEvaluationEventId <= 0) {
      throw new Error(
        `Role modifier ${kind} for ${chickenId} lacks a role evaluation event.`,
      );
    }
    return {
      chickenId,
      roleIdentityId: this.roleStates[chickenId].identity.id,
      kind,
      baseValue,
      modifier,
      appliedValue,
      sourceRoleEvaluationEventId,
    };
  }

  private emitCommentary(draft: CommentaryDraft): CommentaryEvent {
    const event = this.record<CommentaryEvent>({
      ...this.allocateBase(),
      type: "COMMENTARY_EMITTED",
      speaker: draft.speaker,
      category: draft.category,
      priority: draft.priority,
      templateId: draft.templateId,
      sourceEventIds: [...draft.sourceEventIds],
      slots: { ...draft.slots },
      text: draft.text,
    });
    this.commentary.push(event);
    return event;
  }

  private resolveSpotlightSelection(
    orderedPair: readonly [ChickenId, ChickenId],
    context: Context,
    outcome: OutcomeKey,
    reason: InteractionReason,
  ): InteractionResolvedEvent["spotlight"] {
    if (this.spotlightResolved || this.round === 4) {
      return {
        eligible: false,
        selected: false,
        branchLabel: null,
        pendingChildId: null,
      };
    }
    const checkpoint = this.resolver.getCheckpoint(this.activeCheckpointId);
    const [spotlightA, spotlightB] = checkpoint.spotlight.orderedPair.map(
      (qubit) => this.resolver.chickenForQubit(qubit),
    ) as [ChickenId, ChickenId];
    const windowTick = Math.round(
      checkpoint.spotlight.windowOpensAtSeconds * TUNING.ticksPerSecond,
    );
    const deadlineTick = Math.round(
      checkpoint.spotlight.fallbackDeadlineSeconds * TUNING.ticksPerSecond,
    );
    const exactPair =
      orderedPair[0] === spotlightA && orderedPair[1] === spotlightB;
    const inWindow =
      this.roundTick >= windowTick && this.roundTick <= deadlineTick;
    const eligible =
      exactPair &&
      context === checkpoint.spotlight.context &&
      (inWindow ||
        (reason === "spotlight-fallback" && this.roundTick >= deadlineTick));
    if (!eligible) {
      return {
        eligible: false,
        selected: false,
        branchLabel: null,
        pendingChildId: null,
      };
    }
    const branchLabel: BranchLabel =
      this.bank.branchRule.MATCHED_ACTION.includes(outcome)
        ? "MATCHED_ACTION"
        : "SPLIT_ACTION";
    const pendingChildId = checkpoint.children[branchLabel];
    if (!pendingChildId)
      throw new Error(
        `Checkpoint ${checkpoint.checkpointId} has no ${branchLabel} child.`,
      );
    this.spotlightResolved = true;
    this.pendingCheckpointId = pendingChildId;
    return { eligible: true, selected: true, branchLabel, pendingChildId };
  }

  private moveBodies(): void {
    const seconds = TUNING.fixedStepSeconds;
    for (const chicken of this.chickens) {
      if (this.isDown(chicken)) {
        chicken.vx = 0;
        chicken.vy = 0;
        continue;
      }
      if (chicken.movementUntilTick <= this.tick) {
        chicken.movementMode = "wander";
        chicken.movementTargetId = null;
        if (isMovementDecisionTick(this.roundTick)) {
          chicken.wanderAngle += (this.navigationRng.next() - 0.5) * 1.4;
        }
      }
      let directionX = Math.cos(chicken.wanderAngle);
      let directionY = Math.sin(chicken.wanderAngle);
      let speed = TUNING.baseSpeed * 0.42;
      if (chicken.movementTargetId && chicken.movementMode !== "wander") {
        const target = this.requireChicken(chicken.movementTargetId);
        const dx = target.x - chicken.x;
        const dy = target.y - chicken.y;
        const length = Math.hypot(dx, dy) || 1;
        const sign = chicken.movementMode === "approach" ? 1 : -1;
        directionX = (dx / length) * sign;
        directionY = (dy / length) * sign;
        speed =
          TUNING.baseSpeed * (chicken.movementMode === "withdraw" ? 1.12 : 1);
        const role = this.roleStates[chicken.id];
        if (chicken.movementMode === "withdraw") {
          speed *= role.modifiers.withdrawSpeedMultiplier;
        } else if (
          target.movementMode === "withdraw" &&
          target.movementTargetId === chicken.id
        ) {
          speed *= role.modifiers.approachSpeedMultiplier;
        }
      }
      chicken.vx = directionX * speed;
      chicken.vy = directionY * speed;
      if (Math.abs(chicken.vx) > 0.01)
        chicken.facing = chicken.vx >= 0 ? 1 : -1;
      chicken.x += chicken.vx * seconds;
      chicken.y += chicken.vy * seconds;
      const minimumX = TUNING.arenaPadding;
      const maximumX = TUNING.arenaWidth - TUNING.arenaPadding;
      const minimumY = TUNING.arenaPadding + 30;
      const maximumY = TUNING.arenaHeight - TUNING.arenaPadding;
      if (chicken.x <= minimumX || chicken.x >= maximumX) {
        chicken.x = clamp(chicken.x, minimumX, maximumX);
        chicken.wanderAngle = Math.PI - chicken.wanderAngle;
      }
      if (chicken.y <= minimumY || chicken.y >= maximumY) {
        chicken.y = clamp(chicken.y, minimumY, maximumY);
        chicken.wanderAngle = -chicken.wanderAngle;
      }
    }
    this.separateBodies();
  }

  private separateBodies(): void {
    const minimumDistance = TUNING.chickenRadius * 1.35;
    for (let left = 0; left < this.chickens.length; left += 1) {
      for (let right = left + 1; right < this.chickens.length; right += 1) {
        const a = this.chickens[left];
        const b = this.chickens[right];
        if (!a || !b || this.isDown(a) || this.isDown(b)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minimumDistance || distance === 0) continue;
        const overlap = (minimumDistance - distance) / 2;
        const nx = dx / distance;
        const ny = dy / distance;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
      }
    }
  }

  private endRound(): void {
    this.record<RoundEvent>({
      ...this.allocateBase(),
      type: "ROUND_ENDED",
      checkpointId: this.activeCheckpointId,
    });
    if (this.round === 4) {
      this.evaluateFinalMatchRoles();
      this.finishMatch();
      return;
    }
    this.roundInteractions = [];
    if (!this.pendingCheckpointId) {
      throw new Error(
        `Round ${this.round} ended without a sampled spotlight branch.`,
      );
    }
    const parentCheckpointId = this.activeCheckpointId;
    this.activeCheckpointId = this.pendingCheckpointId;
    this.pendingCheckpointId = null;
    this.record<CheckpointActivatedEvent>({
      ...this.allocateBase(),
      type: "CHECKPOINT_ACTIVATED",
      checkpointId: this.activeCheckpointId,
      parentCheckpointId,
    });
    this.phase = "intermission";
    const afterRound = this.round;
    this.record<IntermissionEvent>({
      ...this.allocateBase(),
      type: "INTERMISSION_STARTED",
      afterRound,
      checkpointId: this.activeCheckpointId,
    });
  }

  private evaluateFinalMatchRoles(): void {
    const endHealth = Object.fromEntries(
      this.chickens.map((chicken) => [chicken.id, chicken.health]),
    ) as Record<ChickenId, number>;
    const evaluations = evaluateRoleRound(
      this.round,
      this.allInteractions,
      endHealth,
      this.roleStates,
      { finalOnly: true },
    );
    for (const evaluation of evaluations) {
      const draft = evaluation.historyEntry;
      const event = this.record<RoleEvaluatedEvent>({
        ...this.allocateBase(),
        type: "ROLE_EVALUATED",
        chickenId: evaluation.state.chickenId,
        previousIdentity: draft.previousIdentity,
        identity: draft.identity,
        transition: draft.transition,
        evidence: draft.evidence,
        scores: draft.scores,
        trace: draft.trace,
        modifiers: draft.modifiers,
        publicName: evaluation.state.publicName,
      });
      const historyEntry: RoleHistoryEntry = {
        ...draft,
        evaluationEventId: event.eventId,
      };
      const previous = this.roleStates[evaluation.state.chickenId];
      this.roleStates[evaluation.state.chickenId] = {
        ...evaluation.state,
        history: [...previous.history, historyEntry],
      };
      this.roleEvaluationEventIds[evaluation.state.chickenId] = event.eventId;
      if (event.transition !== "stable") {
        this.record<RoleTransitionedEvent>({
          ...this.allocateBase(),
          type: "ROLE_TRANSITIONED",
          chickenId: event.chickenId,
          evaluationEventId: event.eventId,
          previousIdentity: event.previousIdentity,
          identity: event.identity,
          transition: event.transition,
          publicName: event.publicName,
        });
      }
    }
    this.roundInteractions = [];
  }

  private finishMatch(): void {
    const ordered = [...this.chickens].sort(
      (left, right) =>
        right.knockdowns - left.knockdowns ||
        right.damageDealt - left.damageDealt ||
        right.health - left.health ||
        left.qubit - right.qubit,
    );
    const winner = ordered[0];
    if (!winner) throw new Error("Cannot finish a match without chickens.");
    this.ranking = ordered.map((chicken) => chicken.id);
    this.winnerId = winner.id;
    this.phase = "finished";
    this.paused = false;
    const settled = this.ledger.settle(winner.id);
    this.record<MatchFinishedEvent>({
      ...this.allocateBase(),
      type: "MATCH_FINISHED",
      winnerId: winner.id,
      ranking: [...this.ranking],
      finalPoints: settled.finalPoints ?? settled.remainingPoints,
    });
    const knockdowns = Object.fromEntries(
      this.chickens.map((chicken) => [chicken.id, chicken.knockdowns]),
    ) as Record<ChickenId, number>;
    this.interviews = [];
    for (const profile of buildCharacterProfiles(
      this.seed,
      this.ranking,
      knockdowns,
      this.roleStates,
      this.allInteractions,
    )) {
      const event = this.record<InterviewProfileCreatedEvent>({
        ...this.allocateBase(),
        type: "INTERVIEW_PROFILE_CREATED",
        profile,
      });
      this.interviews.push(event.profile);
    }
  }

  private resetRoundBodies(upcomingRound: 1 | 2 | 3 | 4): void {
    const radiusX = 250;
    const radiusY = 195;
    const phaseOffset = (upcomingRound - 1) * 0.19;
    for (const chicken of this.chickens) {
      const angle =
        (chicken.qubit / this.chickens.length) * Math.PI * 2 + phaseOffset;
      chicken.x = TUNING.arenaWidth / 2 + Math.cos(angle) * radiusX;
      chicken.y = TUNING.arenaHeight / 2 + Math.sin(angle) * radiusY;
      chicken.vx = 0;
      chicken.vy = 0;
      chicken.facing = Math.cos(angle) < 0 ? 1 : -1;
      chicken.health = TUNING.maxHealth;
      chicken.shield = 0;
      chicken.shieldUntilTick = 0;
      chicken.shieldGrants = [];
      chicken.downUntilTick = 0;
      chicken.invulnerableUntilTick = 0;
      chicken.lastDamagerId = null;
      chicken.movementMode = "wander";
      chicken.movementTargetId = null;
      chicken.movementUntilTick = 0;
      chicken.wanderAngle =
        angle + Math.PI + (this.navigationRng.next() - 0.5) * 0.5;
      chicken.actionLockUntilTick = 0;
    }
    this.pairCooldowns.clear();
  }

  private createSnapshot(): MatchSnapshot {
    const chickens: ChickenSnapshot[] = this.chickens.map((chicken) => ({
      id: chicken.id,
      qubit: chicken.qubit,
      x: chicken.x,
      y: chicken.y,
      vx: chicken.vx,
      vy: chicken.vy,
      facing: chicken.facing,
      health: chicken.health,
      maxHealth: TUNING.maxHealth,
      shield: chicken.shield,
      isDown: this.isDown(chicken),
      isInvulnerable: this.isInvulnerable(chicken),
      knockdowns: chicken.knockdowns,
      damageDealt: chicken.damageDealt,
      movementMode: chicken.movementMode,
      movementTargetId: chicken.movementTargetId,
      publicName: this.roleStates[chicken.id].publicName,
      role: this.roleStates[chicken.id],
    }));
    return deepFreeze({
      seed: this.seed,
      resolverMode: this.resolverMode,
      speed: this.speed,
      paused: this.paused,
      phase: this.phase,
      round: this.round,
      roundTick: this.roundTick,
      roundTicks: TUNING.roundTicks,
      tick: this.tick,
      simulationSeconds: this.tick / TUNING.ticksPerSecond,
      activeCheckpointId: this.activeCheckpointId,
      pendingCheckpointId: this.pendingCheckpointId,
      branchHistory: this.branchHistory.map((entry) => ({ ...entry })),
      spotlightResolved: this.spotlightResolved,
      chickens,
      bets: this.ledger.snapshot(),
      winnerId: this.winnerId,
      ranking: [...this.ranking],
      latestInteraction: this.latestInteraction,
      roleStates: { ...this.roleStates },
      commentary: [...this.commentary],
      interviews: [...this.interviews],
      auditHistory: [...this.history],
    });
  }

  private record<T extends MatchEvent>(event: T): T {
    const immutable = deepFreeze(event);
    this.history.push(immutable);
    this.outgoingEvents.push(immutable);
    return immutable;
  }

  private allocateBase(): Omit<RoundEvent, "type" | "checkpointId"> {
    return this.baseForReservedId(this.nextEventId());
  }

  private baseForReservedId(
    eventId: number,
  ): Omit<RoundEvent, "type" | "checkpointId"> {
    return {
      eventId,
      tick: this.tick,
      round: this.round,
      roundTick: this.roundTick,
      simulationSeconds: this.tick / TUNING.ticksPerSecond,
    };
  }

  private nextEventId(): number {
    this.eventCounter += 1;
    return this.eventCounter;
  }

  private requireIntermission(): 1 | 2 | 3 {
    if (this.phase !== "intermission" || !isIntermissionRound(this.round)) {
      throw new Error(
        "Betting is only available during intermissions after Rounds 1–3.",
      );
    }
    return this.round;
  }

  private requireChicken(id: ChickenId): RuntimeChicken {
    const chicken = this.chickens.find((candidate) => candidate.id === id);
    if (!chicken || !CHICKEN_BY_ID.has(id))
      throw new Error(`Unknown chicken ${id}.`);
    return chicken;
  }

  private isDown(chicken: RuntimeChicken): boolean {
    return chicken.downUntilTick > this.tick;
  }

  private isInvulnerable(chicken: RuntimeChicken): boolean {
    return chicken.invulnerableUntilTick > this.tick;
  }

  private isActionAvailable(chicken: RuntimeChicken): boolean {
    return chicken.actionLockUntilTick <= this.tick;
  }

  private isSpotlightReservedChicken(chickenId: ChickenId): boolean {
    if (this.spotlightResolved || this.round === 4) return false;
    const timing = this.spotlightTiming();
    return (
      this.roundTick >= timing.reservationStartsAtRoundTick &&
      timing.orderedPair.includes(chickenId)
    );
  }

  private reservedSpotlightOpportunity(
    context: Context,
  ): SpotlightTiming | null {
    if (this.spotlightResolved || this.round === 4) return null;
    const timing = this.spotlightTiming();
    if (
      this.roundTick < timing.reservationStartsAtRoundTick ||
      timing.context !== context
    ) {
      return null;
    }
    return timing;
  }

  private isSupportOpportunityTarget(chicken: RuntimeChicken): boolean {
    return (
      chicken.health <= TUNING.supportHealthThreshold &&
      chicken.shield < TUNING.supportShield * 2
    );
  }

  private pairCooldownKey(
    a: ChickenId,
    b: ChickenId,
    context: Context,
  ): string {
    const first = this.requireChicken(a);
    const second = this.requireChicken(b);
    const lo = Math.min(first.qubit, second.qubit);
    const hi = Math.max(first.qubit, second.qubit);
    return `${context}:${lo}-${hi}`;
  }

  private isPairAvailable(
    a: ChickenId,
    b: ChickenId,
    context: Context,
  ): boolean {
    return (
      (this.pairCooldowns.get(this.pairCooldownKey(a, b, context)) ?? 0) <=
      this.tick
    );
  }

  private lockInteraction(
    orderedPair: readonly [ChickenId, ChickenId],
    context: Context,
  ): void {
    const actionLockTicks =
      context === "X"
        ? TUNING.combatActionLockTicks
        : context === "Y"
          ? TUNING.supportActionLockTicks
          : TUNING.movementActionLockTicks;
    const pairCooldownTicks =
      context === "X"
        ? TUNING.combatCooldownTicks
        : context === "Y"
          ? TUNING.supportCooldownTicks
          : TUNING.movementPairCooldownTicks;
    for (const id of orderedPair) {
      const chicken = this.requireChicken(id);
      chicken.actionLockUntilTick = Math.max(
        chicken.actionLockUntilTick,
        this.tick + actionLockTicks,
      );
    }
    this.pairCooldowns.set(
      this.pairCooldownKey(orderedPair[0], orderedPair[1], context),
      this.tick + pairCooldownTicks,
    );
  }
}

export function canonicalConsequentialLog(
  events: readonly MatchEvent[],
): unknown[] {
  return events.map((event) => {
    if (event.type !== "INTERACTION_RESOLVED") return event;
    return {
      ...event,
      probabilities: { ...event.probabilities },
      animationIntents: [...event.animationIntents],
      consequences: {
        damage: [...event.consequences.damage],
        shields: [...event.consequences.shields],
        movement: [...event.consequences.movement],
        knockdowns: [...event.consequences.knockdowns],
      },
    };
  });
}
