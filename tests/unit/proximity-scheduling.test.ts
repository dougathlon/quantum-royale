import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TUNING } from "../../src/config/tuning";
import type { ChickenId } from "../../src/content/chickens";
import type {
  Context,
  FixtureBank,
  OutcomeKey,
} from "../../src/fixtures/types";
import { QuantumRoyaleSimulation } from "../../src/simulation/QuantumRoyaleSimulation";
import type {
  InteractionResolvedEvent,
  MatchEvent,
} from "../../src/simulation/types";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../fixtures/quantum-royale-aer-v1.json", import.meta.url),
    "utf8",
  ),
) as FixtureBank;

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

const OUTCOMES: readonly OutcomeKey[] = ["pp", "pm", "mp", "mm"];
const PARKING_POSITIONS = [
  [100, 520],
  [250, 520],
  [400, 520],
  [550, 520],
  [700, 520],
  [850, 520],
] as const;

function cloneFixtureWithOutcome(
  context: Context,
  outcome: OutcomeKey,
): FixtureBank {
  const bank = structuredClone(FIXTURE);
  for (const checkpoint of Object.values(bank.checkpoints)) {
    for (const pair of Object.values(checkpoint.pairs)) {
      for (const key of OUTCOMES) {
        pair.distributions[context][key] = key === outcome ? 1 : 0;
      }
    }
  }
  return bank;
}

function mutableState(
  simulation: QuantumRoyaleSimulation,
): MutableSimulationState {
  return simulation as unknown as MutableSimulationState;
}

function interactions(
  events: readonly MatchEvent[],
): InteractionResolvedEvent[] {
  return events.filter(
    (event): event is InteractionResolvedEvent =>
      event.type === "INTERACTION_RESOLVED",
  );
}

function prepareControlledArena(bank: FixtureBank = FIXTURE): {
  simulation: QuantumRoyaleSimulation;
  state: MutableSimulationState;
} {
  const simulation = new QuantumRoyaleSimulation(bank, 260817, "quantum", {
    validateFixtures: false,
  });
  simulation.drainFramePacket();
  simulation.advanceTicks(1);
  const state = mutableState(simulation);
  state.spotlightResolved = true;
  state.pairCooldowns.clear();
  state.chickens.forEach((chicken, index) => {
    const position = PARKING_POSITIONS[index];
    if (!position) throw new Error(`Missing parking position ${index}.`);
    chicken.x = position[0];
    chicken.y = position[1];
    chicken.vx = 0;
    chicken.vy = 0;
    chicken.health = TUNING.maxHealth;
    chicken.shield = 0;
    chicken.shieldUntilTick = 0;
    chicken.downUntilTick = 0;
    chicken.invulnerableUntilTick = 0;
    chicken.movementMode = "wander";
    chicken.movementTargetId = null;
    chicken.movementUntilTick = 0;
    chicken.wanderAngle = 0;
    chicken.actionLockUntilTick = 0;
  });
  return { simulation, state };
}

function chicken(
  state: MutableSimulationState,
  qubit: number,
): MutableRuntimeChicken {
  const match = state.chickens.find((candidate) => candidate.qubit === qubit);
  if (!match) throw new Error(`Missing q${qubit}.`);
  return match;
}

function place(
  state: MutableSimulationState,
  qubit: number,
  x: number,
  y: number,
): MutableRuntimeChicken {
  const match = chicken(state, qubit);
  match.x = x;
  match.y = y;
  return match;
}

describe("deliberate movement pacing", () => {
  it("uses the 41 px/s base speed for approach movement", () => {
    const bank = cloneFixtureWithOutcome("Z", "pp");
    const simulation = new QuantumRoyaleSimulation(bank, 260817, "quantum", {
      validateFixtures: false,
    });
    const before = simulation.drainFramePacket().snapshot;
    const after = simulation.advanceTicks(1);

    expect(TUNING.baseSpeed).toBe(41);
    expect(
      interactions(after.events).filter(
        (event) =>
          event.context === "Z" && event.reason === "movement-decision",
      ),
    ).toHaveLength(3);
    for (const current of after.snapshot.chickens) {
      const prior = before.chickens.find((entry) => entry.id === current.id);
      if (!prior) throw new Error(`Missing ${current.id} before movement.`);
      expect(Math.hypot(current.vx, current.vy)).toBeCloseTo(41, 8);
      expect(Math.hypot(current.x - prior.x, current.y - prior.y)).toBeCloseTo(
        41 * TUNING.fixedStepSeconds,
        8,
      );
    }
  });

  it("reassesses at ticks 1 and 49 while preserving the first intent through tick 48", () => {
    const bank = cloneFixtureWithOutcome("Z", "mm");
    const simulation = new QuantumRoyaleSimulation(bank, 260817, "quantum", {
      validateFixtures: false,
    });
    simulation.drainFramePacket();

    const first = simulation.advanceTicks(1);
    expect(
      interactions(first.events).filter((event) => event.context === "Z"),
    ).toHaveLength(3);
    expect(
      mutableState(simulation).chickens.every(
        (entry) =>
          entry.movementMode === "withdraw" && entry.movementUntilTick === 49,
      ),
    ).toBe(true);

    const throughTick48 = simulation.advanceTicks(47);
    expect(
      interactions(throughTick48.events).filter(
        (event) => event.context === "Z",
      ),
    ).toHaveLength(0);
    expect(
      throughTick48.snapshot.chickens.every(
        (entry) => entry.movementMode === "withdraw",
      ),
    ).toBe(true);

    const tick49 = simulation.advanceTicks(1);
    expect(
      interactions(tick49.events).filter(
        (event) =>
          event.context === "Z" &&
          event.reason === "movement-decision" &&
          event.roundTick === 49,
      ),
    ).toHaveLength(3);
  });

  it("still reflects at arena bounds and separates overlapping bodies", () => {
    const reflected = prepareControlledArena();
    const edge = place(reflected.state, 0, TUNING.arenaPadding, 300);
    edge.wanderAngle = Math.PI;
    reflected.simulation.advanceTicks(1);
    expect(edge.x).toBe(TUNING.arenaPadding);
    expect(Math.cos(edge.wanderAngle)).toBeCloseTo(1, 8);

    const separated = prepareControlledArena();
    place(separated.state, 0, 300, 300);
    place(separated.state, 1, 310, 300);
    separated.simulation.advanceTicks(1);
    const a = chicken(separated.state, 0);
    const b = chicken(separated.state, 1);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(
      TUNING.chickenRadius * 1.35,
      8,
    );
  });
});

describe("continuous proximity engagements", () => {
  it("triggers combat on the first in-range tick and again exactly at cooldown expiry", () => {
    const bank = cloneFixtureWithOutcome("X", "mm");
    const { simulation, state } = prepareControlledArena(bank);
    place(state, 0, 200, 220);
    place(state, 1, 257, 220);

    const first = simulation.advanceTicks(1);
    const firstCombat = interactions(first.events).filter(
      (event) => event.context === "X",
    );
    expect(firstCombat).toEqual([
      expect.objectContaining({
        tick: 2,
        reason: "combat-proximity",
        orderedPair: [chicken(state, 0).id, chicken(state, 1).id],
      }),
    ]);

    expect(
      interactions(simulation.advanceTicks(15).events).filter(
        (event) => event.context === "X",
      ),
    ).toHaveLength(0);
    expect(
      interactions(simulation.advanceTicks(1).events).filter(
        (event) => event.context === "X" && event.tick === 18,
      ),
    ).toHaveLength(1);
  });

  it("does not trigger combat outside the 58 px range", () => {
    const { simulation, state } = prepareControlledArena();
    place(state, 0, 200, 220);
    place(state, 1, 259, 220);
    expect(
      interactions(simulation.advanceTicks(1).events).filter(
        (event) => event.context === "X",
      ),
    ).toHaveLength(0);
  });

  it("triggers support immediately after injury or entry into support range", () => {
    const bank = cloneFixtureWithOutcome("Y", "mm");
    const injuryCase = prepareControlledArena(bank);
    const injuredLater = place(injuryCase.state, 0, 200, 220);
    place(injuryCase.state, 1, 300, 220);
    expect(
      interactions(injuryCase.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y",
      ),
    ).toHaveLength(0);
    injuredLater.health = TUNING.supportHealthThreshold;
    expect(
      interactions(injuryCase.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y" && event.reason === "injury-proximity",
      ),
    ).toHaveLength(1);

    const rangeCase = prepareControlledArena(bank);
    place(rangeCase.state, 0, 200, 220).health = TUNING.supportHealthThreshold;
    const helper = place(rangeCase.state, 1, 371, 220);
    expect(
      interactions(rangeCase.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y",
      ),
    ).toHaveLength(0);
    helper.x = 369;
    expect(
      interactions(rangeCase.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y",
      ),
    ).toHaveLength(1);
  });

  it("rejects healthy, distant, down, locked, and fully shielded support targets", () => {
    const bank = cloneFixtureWithOutcome("Y", "mm");
    const cases = ["healthy", "distant", "down", "locked", "shielded"] as const;
    for (const blockedCase of cases) {
      const { simulation, state } = prepareControlledArena(bank);
      const target = place(state, 0, 200, 220);
      const helper = place(state, 1, 300, 220);
      target.health = TUNING.supportHealthThreshold;
      if (blockedCase === "healthy") target.health = TUNING.maxHealth;
      if (blockedCase === "distant") helper.x = 371;
      if (blockedCase === "down") target.downUntilTick = 100;
      if (blockedCase === "locked") target.actionLockUntilTick = 100;
      if (blockedCase === "shielded") {
        target.shield = TUNING.supportShield * 2;
        target.shieldUntilTick = 100;
      }
      expect(
        interactions(simulation.advanceTicks(1).events).filter(
          (event) => event.context === "Y",
        ),
        blockedCase,
      ).toHaveLength(0);
    }
  });

  it("resolves protection before combat and permits support again after 30 ticks", () => {
    const bank = cloneFixtureWithOutcome("Y", "mm");
    const priority = prepareControlledArena(bank);
    place(priority.state, 0, 200, 220).health = TUNING.supportHealthThreshold;
    place(priority.state, 1, 250, 220);
    const priorityEvents = interactions(
      priority.simulation.advanceTicks(1).events,
    );
    expect(
      priorityEvents.filter((event) => event.context === "Y"),
    ).toHaveLength(1);
    expect(
      priorityEvents.filter((event) => event.context === "X"),
    ).toHaveLength(0);

    const cooldown = prepareControlledArena(bank);
    place(cooldown.state, 0, 200, 220).health = TUNING.supportHealthThreshold;
    place(cooldown.state, 1, 300, 220);
    expect(
      interactions(cooldown.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y" && event.tick === 2,
      ),
    ).toHaveLength(1);
    expect(
      interactions(cooldown.simulation.advanceTicks(29).events).filter(
        (event) => event.context === "Y",
      ),
    ).toHaveLength(0);
    expect(
      interactions(cooldown.simulation.advanceTicks(1).events).filter(
        (event) => event.context === "Y" && event.tick === 32,
      ),
    ).toHaveLength(1);
  });

  it("uses lowest health, nearest helper, closest combat pair, and qubit tie-breaks", () => {
    const supportBank = cloneFixtureWithOutcome("Y", "mm");
    const support = prepareControlledArena(supportBank);
    place(support.state, 0, 200, 220).health = 6;
    place(support.state, 1, 400, 220).health = 9;
    place(support.state, 2, 280, 220);
    place(support.state, 3, 260, 220);
    place(support.state, 4, 480, 220);
    place(support.state, 5, 760, 220);
    const supportEvents = interactions(
      support.simulation.advanceTicks(1).events,
    ).filter((event) => event.context === "Y");
    expect(supportEvents.map((event) => event.orderedPair)).toEqual([
      [chicken(support.state, 3).id, chicken(support.state, 0).id],
      [chicken(support.state, 4).id, chicken(support.state, 1).id],
    ]);

    const combatBank = cloneFixtureWithOutcome("X", "mm");
    const combat = prepareControlledArena(combatBank);
    place(combat.state, 0, 200, 220);
    place(combat.state, 1, 250, 220);
    place(combat.state, 2, 500, 220);
    place(combat.state, 3, 556, 220);
    const combatEvents = interactions(
      combat.simulation.advanceTicks(1).events,
    ).filter((event) => event.context === "X");
    expect(combatEvents.map((event) => event.orderedPair)).toEqual([
      [chicken(combat.state, 0).id, chicken(combat.state, 1).id],
      [chicken(combat.state, 2).id, chicken(combat.state, 3).id],
    ]);
  });
});
