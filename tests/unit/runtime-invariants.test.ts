import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TUNING, type MatchSpeed } from "../../src/config/tuning";
import type { ChickenId } from "../../src/content/chickens";
import type { Context, FixtureBank } from "../../src/fixtures/types";
import { QuantumRoyaleSimulation } from "../../src/simulation/QuantumRoyaleSimulation";
import type {
  FramePacket,
  InteractionResolvedEvent,
  KnockdownEvent,
  MatchEvent,
  MatchSnapshot,
} from "../../src/simulation/types";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../fixtures/quantum-royale-aer-v1.json", import.meta.url),
    "utf8",
  ),
) as FixtureBank;
const SEED = 260817;

interface MutableRuntimeChicken {
  id: ChickenId;
  qubit: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  health: number;
  shield: number;
  shieldUntilTick: number;
  downUntilTick: number;
  invulnerableUntilTick: number;
  movementMode: "wander" | "approach" | "withdraw";
  movementTargetId: ChickenId | null;
  movementUntilTick: number;
  wanderAngle: number;
  actionLockUntilTick: number;
}

interface MutableSimulationState {
  chickens: MutableRuntimeChicken[];
  pairCooldowns: Map<string, number>;
  spotlightResolved: boolean;
}

function mutableState(
  simulation: QuantumRoyaleSimulation,
): MutableSimulationState {
  return simulation as unknown as MutableSimulationState;
}

function cloneFixture(): FixtureBank {
  return structuredClone(FIXTURE);
}

function configureRootSpotlight(
  bank: FixtureBank,
  orderedPair: [number, number],
  context: Context,
  windowTick: number,
  deadlineTick: number,
): void {
  const root = bank.checkpoints["round-1-root"];
  if (!root)
    throw new Error("The test fixture has no Round 1 root checkpoint.");
  root.spotlight = {
    orderedPair,
    context,
    windowOpensAtSeconds: windowTick / TUNING.ticksPerSecond,
    fallbackDeadlineSeconds: deadlineTick / TUNING.ticksPerSecond,
  };
}

function append(packet: FramePacket, events: MatchEvent[]): MatchSnapshot {
  events.push(...packet.events);
  return packet.snapshot;
}

function finishMatch(seed = SEED): {
  snapshot: MatchSnapshot;
  events: MatchEvent[];
} {
  const simulation = new QuantumRoyaleSimulation(FIXTURE, seed);
  const events: MatchEvent[] = [];
  let snapshot = append(simulation.drainFramePacket(), events);

  while (snapshot.phase !== "finished") {
    if (snapshot.phase === "round") {
      snapshot = append(simulation.advanceTicks(TUNING.roundTicks + 1), events);
    } else {
      simulation.skipBet();
      simulation.continueFromIntermission();
      snapshot = append(simulation.drainFramePacket(), events);
    }
  }

  return { snapshot, events };
}

function interactionEvents(
  events: readonly MatchEvent[],
): InteractionResolvedEvent[] {
  return events.filter(
    (event): event is InteractionResolvedEvent =>
      event.type === "INTERACTION_RESOLVED",
  );
}

describe("spotlight branch invariants", () => {
  it("selects the fallback at the exact deadline tick and never selects a second branch", () => {
    const bank = cloneFixture();
    configureRootSpotlight(bank, [0, 1], "X", 2, 3);
    const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
      validateFixtures: false,
    });
    const initial = simulation.drainFramePacket();
    expect(
      initial.events.filter(
        (event) => event.type === "SPOTLIGHT_FALLBACK_SCHEDULED",
      ),
    ).toEqual([
      expect.objectContaining({
        tick: 0,
        roundTick: 0,
        checkpointId: "round-1-root",
        orderedPair: ["velvet-talon", "cornfield-comet"],
        qubits: [0, 1],
        context: "X",
        windowOpensAtRoundTick: 2,
        fallbackDeadlineRoundTick: 3,
      }),
    ]);

    const beforeDeadline = simulation.advanceTicks(2);
    expect(beforeDeadline.snapshot).toMatchObject({
      roundTick: 2,
      spotlightResolved: false,
      pendingCheckpointId: null,
    });
    expect(
      beforeDeadline.events.some(
        (event) => event.type === "CHECKPOINT_SELECTED",
      ),
    ).toBe(false);
    expect(
      beforeDeadline.events.filter(
        (event) => event.type === "SPOTLIGHT_WINDOW_OPENED",
      ),
    ).toEqual([
      expect.objectContaining({
        tick: 2,
        roundTick: 2,
        windowOpensAtRoundTick: 2,
        fallbackDeadlineRoundTick: 3,
      }),
    ]);

    const atDeadline = simulation.advanceTicks(1);
    const selectedInteraction = interactionEvents(atDeadline.events).find(
      (event) => event.spotlight.selected,
    );
    const selection = atDeadline.events.find(
      (event) => event.type === "CHECKPOINT_SELECTED",
    );
    const fallbackUsed = atDeadline.events.find(
      (event) => event.type === "SPOTLIGHT_FALLBACK_USED",
    );
    if (!selectedInteraction || !selection || !fallbackUsed) {
      throw new Error("Deadline fallback did not publish its causal events.");
    }

    expect(selectedInteraction).toMatchObject({
      tick: 3,
      roundTick: 3,
      reason: "spotlight-fallback",
      spotlight: { eligible: true, selected: true },
    });
    expect(selection).toMatchObject({
      sourceInteractionEventId: selectedInteraction.eventId,
      childCheckpointId: selectedInteraction.spotlight.pendingChildId,
      branchLabel: selectedInteraction.spotlight.branchLabel,
      jointOutcome: selectedInteraction.jointOutcome,
    });
    expect(fallbackUsed).toMatchObject({
      tick: 3,
      roundTick: 3,
      sourceInteractionEventId: selectedInteraction.eventId,
      checkpointId: selectedInteraction.checkpointId,
      orderedPair: selectedInteraction.orderedPair,
      qubits: selectedInteraction.qubits,
      context: selectedInteraction.context,
      windowOpensAtRoundTick: 2,
      fallbackDeadlineRoundTick: 3,
    });
    expect(atDeadline.events.map((event) => event.type)).toEqual([
      "SPOTLIGHT_FALLBACK_PREPARED",
      "INTERACTION_RESOLVED",
      "SPOTLIGHT_FALLBACK_USED",
      "CHECKPOINT_SELECTED",
    ]);
    expect(selection.resolverEvent).toBe(selectedInteraction);
    const branch = atDeadline.snapshot.branchHistory.at(-1);
    expect(branch?.resolverEvent).toBe(selectedInteraction);
    expect(branch?.sourceInteractionEventId).toBe(selectedInteraction.eventId);
    expect(branch?.outcome).toBe(selectedInteraction.jointOutcome);
    expect({
      sourceInteractionEventId: selectedInteraction.eventId,
      checkpointId: selection.resolverEvent.checkpointId,
      orderedPair: selection.resolverEvent.orderedPair,
      context: selection.resolverEvent.context,
      probabilities: selection.resolverEvent.probabilities,
      prngDraw: selection.resolverEvent.prngDraw,
      jointOutcome: selection.resolverEvent.jointOutcome,
      actions: selection.resolverEvent.actions,
    }).toEqual({
      sourceInteractionEventId: selectedInteraction.eventId,
      checkpointId: selectedInteraction.checkpointId,
      orderedPair: selectedInteraction.orderedPair,
      context: selectedInteraction.context,
      probabilities: selectedInteraction.probabilities,
      prngDraw: selectedInteraction.prngDraw,
      jointOutcome: selectedInteraction.jointOutcome,
      actions: selectedInteraction.actions,
    });
    expect(Object.isFrozen(selection.resolverEvent)).toBe(true);
    expect(Object.isFrozen(selection.resolverEvent.probabilities)).toBe(true);
    expect(atDeadline.snapshot).toMatchObject({
      activeCheckpointId: "round-1-root",
      pendingCheckpointId: selectedInteraction.spotlight.pendingChildId,
      spotlightResolved: true,
    });

    const atBoundary = simulation.advanceTicks(TUNING.roundTicks);
    const selectedAcrossRound = interactionEvents(
      atBoundary.snapshot.auditHistory,
    ).filter((event) => event.spotlight.selected);
    expect(selectedAcrossRound).toHaveLength(1);
    expect(
      interactionEvents(atBoundary.snapshot.auditHistory).filter(
        (event) => event.reason === "spotlight-fallback",
      ),
    ).toHaveLength(1);
    expect(
      atBoundary.snapshot.auditHistory.filter(
        (event) => event.type === "CHECKPOINT_SELECTED",
      ),
    ).toHaveLength(1);
    for (const type of [
      "SPOTLIGHT_FALLBACK_SCHEDULED",
      "SPOTLIGHT_FALLBACK_RESERVATION_STARTED",
      "SPOTLIGHT_WINDOW_OPENED",
      "SPOTLIGHT_FALLBACK_PREPARED",
      "SPOTLIGHT_FALLBACK_USED",
    ] as const) {
      expect(
        atBoundary.snapshot.auditHistory.filter((event) => event.type === type),
      ).toHaveLength(1);
    }
    const auditSource = atBoundary.snapshot.auditHistory.find(
      (event) => event.eventId === selectedInteraction.eventId,
    );
    const intermissionBranch = atBoundary.snapshot.branchHistory.at(-1);
    const intermissionSelection = atBoundary.snapshot.auditHistory.find(
      (event) => event.type === "CHECKPOINT_SELECTED",
    );
    expect(auditSource).toBe(selectedInteraction);
    expect(intermissionBranch?.resolverEvent).toBe(selectedInteraction);
    expect(intermissionSelection?.resolverEvent).toBe(selectedInteraction);
    expect(atBoundary.snapshot).toMatchObject({
      phase: "intermission",
      round: 1,
      roundTick: TUNING.roundTicks,
      activeCheckpointId: selectedInteraction.spotlight.pendingChildId,
      pendingCheckpointId: null,
    });
  });

  it("allows the first naturally eligible interaction at window opening to suppress fallback", () => {
    const probe = new QuantumRoyaleSimulation(FIXTURE, SEED);
    probe.drainFramePacket();
    const firstTick = probe.advanceTicks(1);
    const firstMovement = interactionEvents(firstTick.events).find(
      (event) => event.context === "Z" && event.reason === "movement-decision",
    );
    if (!firstMovement)
      throw new Error(
        "The deterministic first tick produced no movement interaction.",
      );

    const bank = cloneFixture();
    configureRootSpotlight(bank, [...firstMovement.qubits], "Z", 1, 70);
    const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
      validateFixtures: false,
    });
    const initial = simulation.drainFramePacket();
    expect(
      initial.events.filter(
        (event) => event.type === "SPOTLIGHT_FALLBACK_SCHEDULED",
      ),
    ).toHaveLength(1);

    const selectedPacket = simulation.advanceTicks(1);
    const selected = interactionEvents(selectedPacket.events).filter(
      (event) => event.spotlight.selected,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      tick: 1,
      roundTick: 1,
      reason: "movement-decision",
      orderedPair: firstMovement.orderedPair,
      context: "Z",
    });
    const windowEventIndex = selectedPacket.events.findIndex(
      (event) => event.type === "SPOTLIGHT_WINDOW_OPENED",
    );
    const selectedEventIndex = selectedPacket.events.findIndex(
      (event) => event.eventId === selected[0]?.eventId,
    );
    expect(windowEventIndex).toBeGreaterThanOrEqual(0);
    expect(windowEventIndex).toBeLessThan(selectedEventIndex);

    const boundary = simulation.advanceTicks(TUNING.roundTicks);
    expect(
      interactionEvents(boundary.snapshot.auditHistory).filter(
        (event) => event.spotlight.selected,
      ),
    ).toHaveLength(1);
    expect(
      interactionEvents(boundary.snapshot.auditHistory).some(
        (event) => event.reason === "spotlight-fallback",
      ),
    ).toBe(false);
    expect(boundary.snapshot.branchHistory).toHaveLength(1);
    expect(boundary.snapshot.branchHistory[0]?.resolverEvent).toBe(selected[0]);
    expect(
      boundary.snapshot.auditHistory.filter(
        (event) => event.type === "SPOTLIGHT_FALLBACK_SCHEDULED",
      ),
    ).toHaveLength(1);
    expect(
      boundary.snapshot.auditHistory.filter(
        (event) => event.type === "SPOTLIGHT_WINDOW_OPENED",
      ),
    ).toHaveLength(1);
    expect(
      boundary.snapshot.auditHistory.filter(
        (event) => event.type === "SPOTLIGHT_FALLBACK_USED",
      ),
    ).toHaveLength(0);
  });

  it("allows the reserved spotlight pair to qualify naturally before the deadline", () => {
    const probe = new QuantumRoyaleSimulation(FIXTURE, SEED);
    probe.drainFramePacket();
    const firstTick = probe.advanceTicks(1);
    const firstMovement = interactionEvents(firstTick.events).find(
      (event) => event.context === "Z" && event.reason === "movement-decision",
    );
    if (!firstMovement)
      throw new Error(
        "The deterministic first tick produced no movement interaction.",
      );

    const bank = cloneFixture();
    configureRootSpotlight(bank, [...firstMovement.qubits], "Z", 20, 70);
    const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
      validateFixtures: false,
    });
    simulation.drainFramePacket();

    const throughSelection = simulation.advanceTicks(49);
    const reservation = throughSelection.events.find(
      (event) => event.type === "SPOTLIGHT_FALLBACK_RESERVATION_STARTED",
    );
    const selected = interactionEvents(throughSelection.events).filter(
      (event) => event.spotlight.selected,
    );
    expect(reservation).toMatchObject({
      roundTick: 6,
      reservationStartsAtRoundTick: 6,
      fallbackDeadlineRoundTick: 70,
      orderedPair: firstMovement.orderedPair,
      context: "Z",
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      roundTick: 49,
      orderedPair: firstMovement.orderedPair,
      context: "Z",
      reason: "movement-decision",
    });

    const reservedIds = new Set(firstMovement.orderedPair);
    expect(
      interactionEvents(throughSelection.events).filter(
        (event) =>
          event.reason === "movement-decision" &&
          event.roundTick >= 6 &&
          event.roundTick <= 49 &&
          event.orderedPair.some((id) => reservedIds.has(id)),
      ),
    ).toEqual(selected);

    const throughDeadline = simulation.advanceTicks(21);
    expect(throughDeadline.snapshot).toMatchObject({
      roundTick: 70,
      spotlightResolved: true,
    });
    expect(
      throughDeadline.snapshot.auditHistory.filter(
        (event) =>
          event.type === "SPOTLIGHT_FALLBACK_PREPARED" ||
          event.type === "SPOTLIGHT_FALLBACK_USED",
      ),
    ).toEqual([]);
  });

  it("logs each spotlight timing transition once across frame partitions and speed changes", () => {
    const run = (
      speeds: readonly MatchSpeed[],
      framePattern: readonly number[],
    ): MatchEvent[] => {
      const bank = cloneFixture();
      configureRootSpotlight(bank, [0, 1], "X", 2, 3);
      const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
        validateFixtures: false,
      });
      const events: MatchEvent[] = [];
      let snapshot = append(simulation.drainFramePacket(), events);
      let frame = 0;
      while (snapshot.roundTick < 5) {
        simulation.setSpeed(speeds[frame % speeds.length] ?? 1);
        snapshot = append(
          simulation.updateFrame(
            framePattern[frame % framePattern.length] ??
              TUNING.fixedStepSeconds,
          ),
          events,
        );
        frame += 1;
        if (frame > 10_000)
          throw new Error("Spotlight timing audit did not converge.");
      }
      return events.filter(
        (event) =>
          event.type === "SPOTLIGHT_FALLBACK_SCHEDULED" ||
          event.type === "SPOTLIGHT_FALLBACK_RESERVATION_STARTED" ||
          event.type === "SPOTLIGHT_WINDOW_OPENED" ||
          event.type === "SPOTLIGHT_FALLBACK_PREPARED" ||
          event.type === "SPOTLIGHT_FALLBACK_USED",
      );
    };

    const baseline = run([1], [TUNING.fixedStepSeconds]);
    expect(baseline.map((event) => event.type)).toEqual([
      "SPOTLIGHT_FALLBACK_SCHEDULED",
      "SPOTLIGHT_FALLBACK_RESERVATION_STARTED",
      "SPOTLIGHT_WINDOW_OPENED",
      "SPOTLIGHT_FALLBACK_PREPARED",
      "SPOTLIGHT_FALLBACK_USED",
    ]);
    expect(baseline.map((event) => event.roundTick)).toEqual([0, 0, 2, 3, 3]);
    expect(run([4], [0.003, 0.019, 0.007])).toEqual(baseline);
    expect(run([1, 4, 2], [0.005, 0.027, 0.011, 0.002])).toEqual(baseline);
  });

  it("stops an arbitrarily large rendered frame at the first intermission boundary", () => {
    const bank = cloneFixture();
    configureRootSpotlight(bank, [0, 1], "X", 2, 3);
    const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
      validateFixtures: false,
    });
    simulation.drainFramePacket();
    simulation.setSpeed(4);

    const packet = simulation.updateFrame(10_000);
    expect(packet.snapshot).toMatchObject({
      phase: "intermission",
      round: 1,
      roundTick: TUNING.roundTicks,
      tick: TUNING.roundTicks,
      speed: 4,
      pendingCheckpointId: null,
    });
    const roundEndedIndex = packet.events.findIndex(
      (event) => event.type === "ROUND_ENDED",
    );
    const activatedIndex = packet.events.findIndex(
      (event) => event.type === "CHECKPOINT_ACTIVATED",
    );
    const intermissionIndex = packet.events.findIndex(
      (event) => event.type === "INTERMISSION_STARTED",
    );
    expect(roundEndedIndex).toBeGreaterThanOrEqual(0);
    expect(activatedIndex).toBeGreaterThan(roundEndedIndex);
    expect(intermissionIndex).toBe(activatedIndex + 1);
    expect(
      packet.events
        .slice(roundEndedIndex + 1, activatedIndex)
        .filter((event) => event.type === "ROLE_EVALUATED")
        .map((event) => event.chickenId),
    ).toEqual([]);
    expect(packet.snapshot.branchHistory).toHaveLength(1);
  });

  it("reserves and prepares a genuinely eligible fallback at the real tick-720 deadline", () => {
    const bank = cloneFixture();
    configureRootSpotlight(bank, [0, 1], "X", 720, 720);
    const simulation = new QuantumRoyaleSimulation(bank, SEED, "quantum", {
      validateFixtures: false,
    });
    simulation.drainFramePacket();

    const beforeDeadline = simulation.advanceTicks(719);
    const state = mutableState(simulation);
    const a = state.chickens.find((chicken) => chicken.qubit === 0);
    const b = state.chickens.find((chicken) => chicken.qubit === 1);
    if (!a || !b) throw new Error("The fallback pair is missing.");
    a.x = 180;
    a.y = 220;
    b.x = 760;
    b.y = 420;

    const atDeadline = simulation.advanceTicks(1);
    const events = [...beforeDeadline.events, ...atDeadline.events];
    const reservation = events.find(
      (event) => event.type === "SPOTLIGHT_FALLBACK_RESERVATION_STARTED",
    );
    const prepared = events.find(
      (event) => event.type === "SPOTLIGHT_FALLBACK_PREPARED",
    );
    const selected = interactionEvents(events).find(
      (event) => event.spotlight.selected,
    );
    if (!reservation || !prepared || !selected) {
      throw new Error("The real fallback lifecycle was not fully recorded.");
    }

    expect(reservation).toMatchObject({
      round: 1,
      roundTick: 656,
      reservationStartsAtRoundTick: 656,
      fallbackDeadlineRoundTick: 720,
      orderedPair: ["velvet-talon", "cornfield-comet"],
      context: "X",
    });
    expect(prepared).toMatchObject({
      roundTick: 720,
      membersAvailableAfter: [true, true],
      membersDown: [false, false],
      triggerRange: TUNING.combatRange,
      repositioned: true,
      qualifyingReason: "peck-range",
    });
    expect(prepared.actionLockUntilTicksBefore).toHaveLength(2);
    expect(prepared.actionLockUntilTicksBefore.every(Number.isFinite)).toBe(
      true,
    );
    expect(prepared.pairCooldownUntilTickBefore).toBeGreaterThanOrEqual(0);
    expect(prepared.distanceBefore).toBeGreaterThan(TUNING.combatRange);
    expect(prepared.distanceAfter).toBeLessThanOrEqual(TUNING.combatRange);
    expect(selected).toMatchObject({
      roundTick: 720,
      reason: "spotlight-fallback",
      orderedPair: prepared.orderedPair,
      context: prepared.context,
    });

    const reservedIds = new Set(prepared.orderedPair);
    const contradictory = interactionEvents(events).filter(
      (event) =>
        event.reason !== "spotlight-fallback" &&
        event.roundTick >= reservation.roundTick &&
        event.roundTick <= prepared.roundTick &&
        event.orderedPair.some((id) => reservedIds.has(id)) &&
        !(
          event.context === prepared.context &&
          event.orderedPair[0] === prepared.orderedPair[0] &&
          event.orderedPair[1] === prepared.orderedPair[1]
        ),
    );
    expect(contradictory).toEqual([]);
    const preparedIndex = events.indexOf(prepared);
    const selectedIndex = events.indexOf(selected);
    const firstOrdinaryAtDeadline = events.findIndex(
      (event) =>
        event.type === "INTERACTION_RESOLVED" &&
        event.roundTick === 720 &&
        event.reason !== "spotlight-fallback",
    );
    expect(preparedIndex).toBeGreaterThanOrEqual(0);
    expect(selectedIndex).toBeGreaterThan(preparedIndex);
    if (firstOrdinaryAtDeadline >= 0) {
      expect(selectedIndex).toBeLessThan(firstOrdinaryAtDeadline);
    }
  });
});

describe("round, history, scoring, and restart invariants", () => {
  it("resets transient bodies for the next round while preserving match records", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, SEED);
    simulation.drainFramePacket();
    const intermission = simulation.advanceTicks(TUNING.roundTicks);
    expect(intermission.snapshot.phase).toBe("intermission");

    const persistentScores = Object.fromEntries(
      intermission.snapshot.chickens.map((chicken) => [
        chicken.id,
        { knockdowns: chicken.knockdowns, damageDealt: chicken.damageDealt },
      ]),
    );
    const branchHistory = intermission.snapshot.branchHistory;
    const activeCheckpointId = intermission.snapshot.activeCheckpointId;
    const historyIds = intermission.snapshot.auditHistory.map(
      (event) => event.eventId,
    );
    const oldPositions = new Map(
      intermission.snapshot.chickens.map((chicken) => [
        chicken.id,
        [chicken.x, chicken.y],
      ]),
    );

    simulation.placeBet("velvet-talon", 5);
    simulation.continueFromIntermission();
    const nextRound = simulation.drainFramePacket();

    expect(nextRound.events.slice(-4).map((event) => event.type)).toEqual([
      "BET_PLACED",
      "INTERMISSION_ENDED",
      "ROUND_STARTED",
      "SPOTLIGHT_FALLBACK_SCHEDULED",
    ]);
    expect(nextRound.snapshot).toMatchObject({
      phase: "round",
      round: 2,
      roundTick: 0,
      tick: TUNING.roundTicks,
      activeCheckpointId,
      pendingCheckpointId: null,
      spotlightResolved: false,
      branchHistory,
      bets: {
        remainingPoints: 95,
        tickets: [{ afterRound: 1, chickenId: "velvet-talon", stake: 5 }],
      },
    });
    expect(
      nextRound.snapshot.auditHistory
        .slice(0, historyIds.length)
        .map((event) => event.eventId),
    ).toEqual(historyIds);
    expect(
      nextRound.snapshot.chickens.map((chicken) => [
        chicken.id,
        { knockdowns: chicken.knockdowns, damageDealt: chicken.damageDealt },
      ]),
    ).toEqual(Object.entries(persistentScores));
    expect(
      nextRound.snapshot.chickens.every(
        (chicken) =>
          chicken.health === TUNING.maxHealth &&
          chicken.shield === 0 &&
          !chicken.isDown &&
          !chicken.isInvulnerable &&
          chicken.vx === 0 &&
          chicken.vy === 0 &&
          chicken.movementMode === "wander" &&
          chicken.movementTargetId === null,
      ),
    ).toBe(true);
    expect(
      nextRound.snapshot.chickens.some((chicken) => {
        const oldPosition = oldPositions.get(chicken.id);
        return oldPosition?.[0] !== chicken.x || oldPosition[1] !== chicken.y;
      }),
    ).toBe(true);
  });

  it("keeps drained packet events and audit history in one gapless event-ID sequence", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, SEED);
    const drained: MatchEvent[] = [];
    append(simulation.drainFramePacket(), drained);
    append(simulation.advanceTicks(TUNING.roundTicks), drained);
    simulation.skipBet();
    simulation.continueFromIntermission();
    const snapshot = append(simulation.drainFramePacket(), drained);
    const afterMoreTicks = append(simulation.advanceTicks(120), drained);

    const expectedIds = Array.from(
      { length: drained.length },
      (_, index) => index + 1,
    );
    expect(drained.map((event) => event.eventId)).toEqual(expectedIds);
    expect(afterMoreTicks.auditHistory.map((event) => event.eventId)).toEqual(
      expectedIds,
    );
    expect(
      afterMoreTicks.auditHistory.slice(0, snapshot.auditHistory.length),
    ).toEqual(snapshot.auditHistory);
    for (const event of drained) {
      expect(
        afterMoreTicks.auditHistory.find(
          (candidate) => candidate.eventId === event.eventId,
        ),
      ).toBe(event);
    }
  });

  it("exposes one score increment and one KNOCKDOWN event for every knockdown consequence", () => {
    const run = finishMatch();
    const interactions = new Map(
      interactionEvents(run.events).map((interaction) => [
        interaction.eventId,
        interaction,
      ]),
    );
    const knockdowns = run.events.filter(
      (event): event is KnockdownEvent => event.type === "KNOCKDOWN",
    );
    expect(knockdowns.length).toBeGreaterThan(0);

    const runningScores = new Map<ChickenId, number>();
    const targetTransitions = new Set<string>();
    for (const event of knockdowns) {
      const interaction = interactions.get(event.sourceInteractionEventId);
      expect(interaction).toBeDefined();
      const consequence = interaction?.consequences.knockdowns.find(
        (candidate) =>
          candidate.sourceId === event.sourceId &&
          candidate.targetId === event.targetId,
      );
      expect(consequence).toMatchObject({
        sourceId: event.sourceId,
        targetId: event.targetId,
        pointAwarded: 1,
        baseDurationTicks: TUNING.knockdownTicks,
      });
      expect(consequence?.appliedDurationTicks).toBeLessThanOrEqual(
        consequence?.baseDurationTicks ?? 0,
      );
      expect(consequence?.downUntilTick).toBe(
        (interaction?.tick ?? 0) + (consequence?.appliedDurationTicks ?? 0),
      );
      expect(interaction?.scoreChanges).toContainEqual({
        chickenId: event.sourceId,
        delta: 1,
        scoreAfter: event.scoreAfter,
      });
      expect(
        interaction?.consequences.damage.some(
          (damage) =>
            damage.sourceId === event.sourceId &&
            damage.targetId === event.targetId &&
            damage.actualDamage > 0 &&
            damage.targetHealthAfter === 0 &&
            damage.ignoredReason === null,
        ),
      ).toBe(true);

      const previousScore = runningScores.get(event.sourceId) ?? 0;
      expect(event.scoreAfter).toBe(previousScore + 1);
      runningScores.set(event.sourceId, event.scoreAfter);
      const transitionKey = `${event.sourceInteractionEventId}:${event.targetId}`;
      expect(targetTransitions.has(transitionKey)).toBe(false);
      targetTransitions.add(transitionKey);
    }

    expect(
      interactionEvents(run.events).reduce(
        (count, interaction) =>
          count + interaction.consequences.knockdowns.length,
        0,
      ),
    ).toBe(knockdowns.length);
    for (const chicken of run.snapshot.chickens) {
      expect(chicken.knockdowns).toBe(runningScores.get(chicken.id) ?? 0);
    }
  });

  it("publishes a final ranking using knockdowns, damage, health, then stable qubit identity", () => {
    const run = finishMatch();
    const expectedRanking = [...run.snapshot.chickens]
      .sort(
        (left, right) =>
          right.knockdowns - left.knockdowns ||
          right.damageDealt - left.damageDealt ||
          right.health - left.health ||
          left.qubit - right.qubit,
      )
      .map((chicken) => chicken.id);
    const finished = run.events.find(
      (event) => event.type === "MATCH_FINISHED",
    );

    expect(run.snapshot.ranking).toEqual(expectedRanking);
    expect(run.snapshot.winnerId).toBe(expectedRanking[0]);
    expect(finished).toMatchObject({
      winnerId: expectedRanking[0],
      ranking: expectedRanking,
    });
  });

  it("restart clears prior state and reproduces a fresh run with the same seed", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, SEED);
    simulation.drainFramePacket();
    simulation.advanceTicks(TUNING.roundTicks);
    simulation.placeBet("velvet-talon", 20);
    simulation.setSpeed(4);
    simulation.setPaused(true);

    const restarted = simulation.restart();
    const fresh = new QuantumRoyaleSimulation(FIXTURE, SEED);
    const freshStart = fresh.drainFramePacket();

    expect(restarted).toEqual(freshStart);
    expect(
      restarted.events.map((event) => [event.eventId, event.type]),
    ).toEqual([
      [1, "MATCH_STARTED"],
      [2, "ROUND_STARTED"],
      [3, "SPOTLIGHT_FALLBACK_SCHEDULED"],
    ]);
    expect(restarted.snapshot).toMatchObject({
      seed: SEED,
      speed: 1,
      paused: false,
      phase: "round",
      round: 1,
      roundTick: 0,
      tick: 0,
      activeCheckpointId: "round-1-root",
      pendingCheckpointId: null,
      branchHistory: [],
      spotlightResolved: false,
      bets: { remainingPoints: 100, tickets: [], skippedAfterRounds: [] },
      winnerId: null,
      ranking: [],
    });

    expect(simulation.advanceTicks(180)).toEqual(fresh.advanceTicks(180));
  });
});
