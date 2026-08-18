import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TUNING } from "../../src/config/tuning";
import type { ChickenId } from "../../src/content/chickens";
import type { FixtureBank } from "../../src/fixtures/types";
import { NEUTRAL_ROLE_MODIFIERS } from "../../src/roles/roleTypes";
import { QuantumRoyaleSimulation } from "../../src/simulation/QuantumRoyaleSimulation";
import type {
  CommentaryEvent,
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

function completed(seed = 260817): {
  snapshot: MatchSnapshot;
  events: readonly MatchEvent[];
} {
  const simulation = new QuantumRoyaleSimulation(FIXTURE, seed);
  simulation.drainFramePacket();
  let snapshot = simulation.getSnapshot();
  while (snapshot.phase !== "finished") {
    if (snapshot.phase === "round") {
      snapshot = simulation.advanceTicks(TUNING.roundTicks + 1).snapshot;
    } else {
      simulation.skipBet();
      simulation.continueFromIntermission();
      snapshot = simulation.drainFramePacket().snapshot;
    }
  }
  return { snapshot, events: snapshot.auditHistory };
}

function interactions(
  events: readonly MatchEvent[],
): InteractionResolvedEvent[] {
  return events.filter(
    (event): event is InteractionResolvedEvent =>
      event.type === "INTERACTION_RESOLVED",
  );
}

describe("role integration and provenance", () => {
  it("evaluates all six chickens once after Round 4 and before the finale", () => {
    const { events, snapshot } = completed();
    const evaluations = events.filter(
      (event) => event.type === "ROLE_EVALUATED",
    );
    expect(evaluations).toHaveLength(6);
    expect(evaluations.map((event) => event.chickenId)).toEqual([
      "velvet-talon",
      "cornfield-comet",
      "scarlet-bantam",
      "midnight-rooster",
      "buttercup-blitz",
      "silver-drumstick",
    ]);
    expect(evaluations.every((event) => event.round === 4)).toBe(true);
    const finalRoundEnded = events.findIndex(
      (event) => event.type === "ROUND_ENDED" && event.round === 4,
    );
    const firstEvaluation = events.findIndex(
      (event) => event.type === "ROLE_EVALUATED",
    );
    const matchFinished = events.findIndex(
      (event) => event.type === "MATCH_FINISHED",
    );
    expect(firstEvaluation).toBeGreaterThan(finalRoundEnded);
    expect(matchFinished).toBeGreaterThan(firstEvaluation);
    expect(snapshot.interviews).toHaveLength(6);
    expect(
      snapshot.chickens.every(
        (chicken) => chicken.publicName === chicken.role.canonicalName,
      ),
    ).toBe(true);
    for (const state of Object.values(snapshot.roleStates)) {
      expect(state.modifiers).toEqual(NEUTRAL_ROLE_MODIFIERS);
      expect(state.history).toHaveLength(1);
      expect(state.history[0]?.modifiers).toEqual(NEUTRAL_ROLE_MODIFIERS);
    }
  });

  it("retains FIFO shield attribution and separates base from applied values", () => {
    const run = completed();
    const allDamage = interactions(run.events).flatMap(
      (event) => event.consequences.damage,
    );
    const credited = allDamage.filter(
      (damage) => damage.shieldCredits.length > 0,
    );
    expect(credited.length).toBeGreaterThan(0);
    const lastGrantByTarget = new Map<ChickenId, number>();
    for (const damage of credited) {
      expect(
        damage.shieldCredits.reduce((sum, credit) => sum + credit.amount, 0),
      ).toBeCloseTo(damage.shieldAbsorbed, 8);
      expect(
        damage.shieldCredits.reduce(
          (sum, credit) => sum + credit.baseAmount,
          0,
        ),
      ).toBeCloseTo(damage.baseShieldAbsorbed, 8);
      for (const credit of damage.shieldCredits) {
        expect(credit.sourceInteractionEventId).toBeGreaterThanOrEqual(
          lastGrantByTarget.get(damage.targetId) ?? 0,
        );
        lastGrantByTarget.set(damage.targetId, credit.sourceInteractionEventId);
      }
      expect(damage.baseRequestedDamage + damage.modifierAmount).toBe(
        damage.requestedDamage,
      );
      expect(damage.baseActualDamage).toBeGreaterThanOrEqual(0);
      expect(damage.actualDamage).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps every interaction role-neutral and never changes stored probabilities", () => {
    const run = completed(5);
    const byId = new Map(run.events.map((event) => [event.eventId, event]));
    const fixtureProbabilities = new Map<string, unknown>();
    for (const checkpoint of Object.values(FIXTURE.checkpoints)) {
      for (const [edge, pair] of Object.entries(checkpoint.pairs)) {
        for (const [context, distribution] of Object.entries(
          pair.distributions,
        )) {
          fixtureProbabilities.set(
            `${checkpoint.checkpointId}|${edge}|${context}`,
            distribution,
          );
        }
      }
    }
    for (const interaction of interactions(run.events)) {
      const key = `${interaction.checkpointId}|${interaction.canonicalEdge.join("-")}|${interaction.context}`;
      const stored = fixtureProbabilities.get(key) as
        InteractionResolvedEvent["probabilities"] | undefined;
      const fixtureDistribution =
        stored && interaction.qubits[0] > interaction.qubits[1]
          ? { pp: stored.pp, pm: stored.mp, mp: stored.pm, mm: stored.mm }
          : stored;
      expect(interaction.probabilities).toEqual(fixtureDistribution);
      for (const modifier of interaction.consequences.roleModifiers) {
        expect(byId.has(modifier.sourceRoleEvaluationEventId)).toBe(false);
      }
      expect(interaction.consequences.roleModifiers).toEqual([]);
    }
  });
});

describe("deterministic desk and interviews", () => {
  it("caps expanded commentary at ten per round, uses one line per tick, and preserves source IDs", () => {
    const run = completed();
    const byId = new Map(run.events.map((event) => [event.eventId, event]));
    const commentary = run.events.filter(
      (event): event is CommentaryEvent => event.type === "COMMENTARY_EMITTED",
    );
    for (const round of [1, 2, 3, 4]) {
      const lines = commentary.filter((event) => event.round === round);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(new Set(lines.map((event) => event.tick)).size).toBe(lines.length);
      const ordinary = lines.filter(
        (event) => event.category !== "role" && event.category !== "emerging",
      );
      for (let index = 1; index < ordinary.length; index += 1) {
        expect(
          (ordinary[index]?.tick ?? 0) - (ordinary[index - 1]?.tick ?? 0),
        ).toBeGreaterThanOrEqual(60);
      }
      for (const line of lines) {
        expect(line.templateId).toMatch(/-\d+$/);
        expect(line.sourceEventIds.length).toBeGreaterThan(0);
        for (const sourceId of line.sourceEventIds) {
          expect(sourceId).toBeLessThan(line.eventId);
          expect(byId.has(sourceId)).toBe(true);
        }
      }
    }
    expect(completed().snapshot.commentary).toEqual(run.snapshot.commentary);
  });

  it("creates six rank-ordered, fact-bound interview profiles", () => {
    const run = completed();
    const interactionIds = new Set(
      interactions(run.events).map((event) => event.eventId),
    );
    expect(run.snapshot.interviews.map((profile) => profile.rank)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(run.snapshot.interviews.map((profile) => profile.chickenId)).toEqual(
      run.snapshot.ranking,
    );
    for (const profile of run.snapshot.interviews) {
      expect(profile.publicName).toBe(
        run.snapshot.roleStates[profile.chickenId].publicName,
      );
      expect(profile.finalIdentity).toEqual(
        run.snapshot.roleStates[profile.chickenId].identity,
      );
      expect(profile.interviewLines).toHaveLength(4);
      expect(profile.matchSummary.totalInteractions).toBeGreaterThan(0);
      for (const sourceId of profile.strongestPair?.sourceEventIds ?? []) {
        expect(interactionIds.has(sourceId)).toBe(true);
      }
    }
  });
});
