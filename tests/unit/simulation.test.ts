import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TUNING, type MatchSpeed } from "../../src/config/tuning";
import type { ChickenId } from "../../src/content/chickens";
import type { FixtureBank, OutcomeKey } from "../../src/fixtures/types";
import { QuantumRoyaleSimulation } from "../../src/simulation/QuantumRoyaleSimulation";
import { resolveJointOutcome } from "../../src/simulation/resolveJointOutcome";
import type {
  FramePacket,
  InteractionResolvedEvent,
  MatchEvent,
  MatchSnapshot,
} from "../../src/simulation/types";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../fixtures/quantum-royale-aer-v1.json", import.meta.url),
    "utf8",
  ),
) as FixtureBank;

interface CompletedRun {
  snapshot: MatchSnapshot;
  events: MatchEvent[];
}

function append(packet: FramePacket, events: MatchEvent[]): MatchSnapshot {
  events.push(...packet.events);
  return packet.snapshot;
}

function runMatch(
  speed: MatchSpeed,
  framePattern: readonly number[] = [0.011, 0.037, 0.081, 0.019],
  betOn: ChickenId | null = null,
  seed = 260817,
): CompletedRun {
  const simulation = new QuantumRoyaleSimulation(FIXTURE, seed);
  const events: MatchEvent[] = [];
  let snapshot = append(simulation.drainFramePacket(), events);
  simulation.setSpeed(speed);
  let frame = 0;
  while (snapshot.phase !== "finished") {
    if (snapshot.phase === "round") {
      snapshot = append(
        simulation.updateFrame(
          framePattern[frame % framePattern.length] ?? 0.05,
        ),
        events,
      );
      frame += 1;
    } else {
      if (betOn && snapshot.bets.remainingPoints >= 1)
        simulation.placeBet(betOn, 1);
      else simulation.skipBet();
      simulation.continueFromIntermission();
      snapshot = append(simulation.drainFramePacket(), events);
    }
  }
  return { snapshot, events };
}

function logicalProjection(events: readonly MatchEvent[]): unknown[] {
  return events
    .filter(
      (event) => event.type !== "BET_PLACED" && event.type !== "BET_SKIPPED",
    )
    .map((event) => {
      if (event.type === "MATCH_FINISHED") {
        const { finalPoints: _finalPoints, ...logical } = event;
        return logical;
      }
      return event;
    });
}

describe("joint X/Y/Z meanings", () => {
  const pair = ["velvet-talon", "cornfield-comet"] as const;
  const outcomes: readonly OutcomeKey[] = ["pp", "pm", "mp", "mm"];

  it("maps all four X outcomes to attack/guard without a second point system", () => {
    expect(
      outcomes.map(
        (outcome) => resolveJointOutcome("X", outcome, pair).actions,
      ),
    ).toEqual([
      { a: "attack", b: "attack" },
      { a: "attack", b: "guard" },
      { a: "guard", b: "attack" },
      { a: "guard", b: "guard" },
    ]);
  });

  it("maps Y plus to covering the other chicken", () => {
    const plusMinus = resolveJointOutcome("Y", "pm", pair);
    const minusPlus = resolveJointOutcome("Y", "mp", pair);
    expect(plusMinus.actions).toEqual({ a: "cover", b: "ignore" });
    expect(plusMinus.shields).toEqual([
      { sourceId: pair[0], targetId: pair[1], amount: TUNING.supportShield },
    ]);
    expect(minusPlus.shields).toEqual([
      { sourceId: pair[1], targetId: pair[0], amount: TUNING.supportShield },
    ]);
  });

  it("maps all four Z outcomes to approach/withdraw", () => {
    expect(
      outcomes.map(
        (outcome) => resolveJointOutcome("Z", outcome, pair).actions,
      ),
    ).toEqual([
      { a: "approach", b: "approach" },
      { a: "approach", b: "withdraw" },
      { a: "withdraw", b: "approach" },
      { a: "withdraw", b: "withdraw" },
    ]);
  });
});

describe("deterministic match runtime", () => {
  it("finishes four continuous rounds with three sampled branches and no elimination", () => {
    const run = runMatch(4);
    const interactions = run.events.filter(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED",
    );

    expect(run.snapshot.round).toBe(4);
    expect(run.snapshot.tick).toBe(TUNING.roundTicks * 4);
    expect(run.snapshot.branchHistory).toHaveLength(3);
    expect(run.snapshot.activeCheckpointId).toMatch(/^round-4-/);
    expect(run.snapshot.winnerId).not.toBeNull();
    expect(run.snapshot.ranking).toHaveLength(6);
    expect(run.snapshot.chickens).toHaveLength(6);
    expect(interactions.some((event) => event.context === "X")).toBe(true);
    expect(
      interactions.some(
        (event) => event.context === "Y" && event.reason === "injury-proximity",
      ),
    ).toBe(true);
    expect(interactions.some((event) => event.context === "Z")).toBe(true);
    expect(run.events.some((event) => event.type === "KNOCKDOWN")).toBe(true);
    expect(run.events.some((event) => event.type === "RECOVERED")).toBe(true);
  });

  it("produces the same logical match at 1x, 2x, and 4x", () => {
    const one = runMatch(1);
    const two = runMatch(2);
    const four = runMatch(4);

    expect(logicalProjection(two.events)).toEqual(
      logicalProjection(one.events),
    );
    expect(logicalProjection(four.events)).toEqual(
      logicalProjection(one.events),
    );
    expect(two.snapshot.winnerId).toBe(one.snapshot.winnerId);
    expect(four.snapshot.winnerId).toBe(one.snapshot.winnerId);
  });

  it("produces one identical final-only role reading at 1x, 2x, and 4x", () => {
    const one = runMatch(1, [0.011, 0.037, 0.081, 0.019], null, 5);
    const two = runMatch(2, [0.011, 0.037, 0.081, 0.019], null, 5);
    const four = runMatch(4, [0.011, 0.037, 0.081, 0.019], null, 5);
    expect(logicalProjection(two.events)).toEqual(
      logicalProjection(one.events),
    );
    expect(logicalProjection(four.events)).toEqual(
      logicalProjection(one.events),
    );
    const scarlet = one.snapshot.roleStates["scarlet-bantam"];
    expect(scarlet.history).toHaveLength(1);
    expect(scarlet.publicName).toBe(scarlet.canonicalName);
    expect(two.snapshot.roleStates["scarlet-bantam"]).toEqual(scarlet);
    expect(four.snapshot.roleStates["scarlet-bantam"]).toEqual(scarlet);
  });

  it("is invariant to irregular render partitions and mid-round speed changes", () => {
    const baseline = runMatch(1, [TUNING.fixedStepSeconds]);
    const irregular = runMatch(1, [0.003, 0.121, 0.017, 0.067, 0.009]);
    expect(logicalProjection(irregular.events)).toEqual(
      logicalProjection(baseline.events),
    );

    const simulation = new QuantumRoyaleSimulation(FIXTURE, 260817);
    const events: MatchEvent[] = [];
    let snapshot = append(simulation.drainFramePacket(), events);
    let frame = 0;
    while (snapshot.phase !== "finished") {
      if (snapshot.phase === "round") {
        const cycle = [1, 4, 2, 1] as const;
        const speed =
          cycle[Math.floor(snapshot.roundTick / 137) % cycle.length] ?? 1;
        simulation.setSpeed(speed);
        snapshot = append(simulation.updateFrame(0.025), events);
        frame += 1;
        if (frame > 100_000)
          throw new Error("Mixed-speed run did not converge.");
      } else {
        simulation.skipBet();
        simulation.continueFromIntermission();
        snapshot = append(simulation.drainFramePacket(), events);
      }
    }
    expect(logicalProjection(events)).toEqual(
      logicalProjection(baseline.events),
    );
  });

  it("freezes tick, PRNG-driven history, and round state during intermissions and pause", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, 9);
    simulation.drainFramePacket();
    let packet = simulation.advanceTicks(TUNING.roundTicks);
    expect(packet.snapshot.phase).toBe("intermission");
    const frozen = JSON.stringify(packet.snapshot);
    packet = simulation.updateFrame(50_000);
    expect(JSON.stringify(packet.snapshot)).toBe(frozen);
    expect(packet.events).toHaveLength(0);

    simulation.skipBet();
    simulation.continueFromIntermission();
    simulation.drainFramePacket();
    simulation.setPaused(true);
    const paused = simulation.getSnapshot();
    packet = simulation.updateFrame(2_000);
    expect(packet.snapshot.tick).toBe(paused.tick);
    expect(packet.snapshot.roundTick).toBe(paused.roundTick);
    expect(packet.events).toHaveLength(0);
  });

  it("keeps betting outside simulation logic and diagnostics outside the primary ledger", () => {
    const skipped = runMatch(4, [0.08]);
    const bet = runMatch(4, [0.08], "silver-drumstick");
    expect(logicalProjection(bet.events)).toEqual(
      logicalProjection(skipped.events),
    );

    const simulation = new QuantumRoyaleSimulation(FIXTURE, 260817);
    simulation.drainFramePacket();
    const before = simulation.getSnapshot().bets;
    const diagnostic = simulation.runProductControlDiagnostic();
    expect(diagnostic.label).toBe("CLASSICAL PRODUCT-OF-MARGINALS CONTROL");
    expect(diagnostic.ranking).toHaveLength(6);
    expect(diagnostic.primaryRanking).toHaveLength(6);
    expect(diagnostic.primaryBranchPath).toHaveLength(3);
    expect(diagnostic.branchPath).toHaveLength(3);
    expect(Object.keys(diagnostic.primaryFinalRoles)).toHaveLength(6);
    expect(Object.keys(diagnostic.finalRoles)).toHaveLength(6);
    expect(
      Object.values(diagnostic.primaryRoleTrajectories).every(
        (trajectory) => trajectory.length === 1,
      ),
    ).toBe(true);
    expect(
      Object.values(diagnostic.roleTrajectories).every(
        (trajectory) => trajectory.length === 1,
      ),
    ).toBe(true);
    expect(Array.isArray(diagnostic.pairNarrativeDifferences)).toBe(true);
    expect(simulation.getSnapshot().bets).toEqual(before);
  });

  it("publishes the exact same immutable interaction object to packet and audit history", () => {
    const simulation = new QuantumRoyaleSimulation(FIXTURE, 260817);
    simulation.drainFramePacket();
    const packet = simulation.advanceTicks(1);
    const interaction = packet.events.find(
      (event): event is InteractionResolvedEvent =>
        event.type === "INTERACTION_RESOLVED",
    );
    expect(interaction).toBeDefined();
    const audited = packet.snapshot.auditHistory.find(
      (event) => event.eventId === interaction?.eventId,
    );
    expect(audited).toBe(interaction);
    expect(Object.isFrozen(interaction)).toBe(true);
    expect(Object.isFrozen(interaction?.probabilities)).toBe(true);
  });
});
