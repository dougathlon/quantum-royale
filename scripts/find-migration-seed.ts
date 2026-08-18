import fixtureBankJson from "../fixtures/quantum-royale-aer-v1.json";
import { TUNING } from "../src/config/tuning";
import type { FixtureBank } from "../src/fixtures/types";
import { QuantumRoyaleSimulation } from "../src/simulation/QuantumRoyaleSimulation";
import type { RoleHistoryEntry } from "../src/roles/roleTypes";

const maximumSeed = Number(process.argv[2] ?? 10_000);
if (!Number.isInteger(maximumSeed) || maximumSeed < 1) {
  throw new Error("Maximum seed must be a positive integer.");
}

const bank = fixtureBankJson as FixtureBank;

function isEstablishedChange(
  previous: RoleHistoryEntry,
  current: RoleHistoryEntry,
): boolean {
  return (
    previous.round >= 2 &&
    current.round > previous.round &&
    previous.identity.stage === "established" &&
    current.identity.stage === "established" &&
    previous.identity.id !== current.identity.id
  );
}

let result: Record<string, unknown> | null = null;
for (let seed = 1; seed <= maximumSeed; seed += 1) {
  const simulation = new QuantumRoyaleSimulation(bank, seed, "quantum", {
    validateFixtures: false,
  });
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
  for (const role of Object.values(snapshot.roleStates)) {
    for (let index = 1; index < role.history.length; index += 1) {
      const previous = role.history[index - 1];
      const current = role.history[index];
      if (!previous || !current || !isEstablishedChange(previous, current))
        continue;
      result = {
        seed,
        chickenId: role.chickenId,
        canonicalName: role.canonicalName,
        fromRound: previous.round,
        fromIdentity: previous.identity.label,
        fromScores: previous.scores,
        toRound: current.round,
        toIdentity: current.identity.label,
        toScores: current.scores,
        branchPath: snapshot.branchHistory.map(
          (entry) => entry.childCheckpointId,
        ),
        finalRanking: snapshot.ranking,
      };
      break;
    }
    if (result) break;
  }
  if (result) break;
}

process.stdout.write(
  `${JSON.stringify(
    result ?? {
      result: "none",
      searchedSeeds: [1, maximumSeed],
      criterion:
        "same chicken changes between two established base or hybrid identities after Round 2",
    },
    null,
    2,
  )}\n`,
);
