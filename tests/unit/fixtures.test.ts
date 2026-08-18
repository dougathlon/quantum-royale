import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  FixtureResolver,
  selectOutcome,
} from "../../src/fixtures/FixtureResolver";
import type { ChickenId } from "../../src/content/chickens";
import type {
  BatchedHardwareAcquisitionRecord,
  Context,
  FixtureBank,
  LocalAerAcquisitionRecord,
  ProbabilityVector,
} from "../../src/fixtures/types";
import { validateFixtureBank } from "../../src/fixtures/validateFixtureBank";

const FIXTURE_TEXT = readFileSync(
  new URL("../../fixtures/quantum-royale-aer-v1.json", import.meta.url),
  "utf8",
);
const SCHEMA_TEXT = readFileSync(
  new URL(
    "../../schemas/quantum-royale-fixture-bank-v1.schema.json",
    import.meta.url,
  ),
  "utf8",
);
const CONTEXTS = ["X", "Y", "Z"] as const satisfies readonly Context[];
const FIXTURE_SCHEMA = JSON.parse(SCHEMA_TEXT) as object;

function freshBank(): FixtureBank {
  return JSON.parse(FIXTURE_TEXT) as FixtureBank;
}

function root(bank: FixtureBank) {
  const checkpoint = bank.checkpoints["round-1-root"];
  if (!checkpoint) throw new Error("Fixture is missing its canonical root.");
  return checkpoint;
}

function mockHardwareAcquisition(
  local: LocalAerAcquisitionRecord,
): BatchedHardwareAcquisitionRecord {
  return {
    backendClass: "MockProviderBackend",
    backendName: "mock-qpu",
    providerMode: "batched-hardware",
    providerName: "mock-offline-provider",
    mothApi: false,
    jobId: `hardware-${local.jobId}`,
    resultId: `result-${local.jobId}`,
    submittedAtUtc: "2026-08-18T00:00:00+00:00",
    completedAtUtc: "2026-08-18T00:05:00+00:00",
    retrievedAtUtc: "2026-08-18T00:06:00+00:00",
    shotsPerCircuit: local.shotsPerCircuit,
    simulatorSeed: null,
    tomographyCircuitCount: 15,
    totalShots: local.totalShots,
    logicalMeasurementCircuitSha256: [...local.logicalMeasurementCircuitSha256],
    transpilation: {
      toolName: "mock-transpiler",
      toolVersion: "1.0.0",
      seed: local.transpilerSeed,
      settings: { optimizationLevel: 1 },
      isaCircuitSha256: [...local.transpiledAerCircuitSha256],
    },
    rawCountsSha256: local.rawCountsSha256,
    durableProviderResult: true,
    hardwareLayout: {
      logicalToPhysical: [5, 4, 3, 2, 1, 0],
      targetName: "mock-six-qubit-target",
      targetSnapshotSha256: "a".repeat(64),
    },
    backendCalibration: {
      calibrationId: "mock-calibration",
      timestampUtc: "2026-08-18T00:00:00+00:00",
      sha256: "b".repeat(64),
    },
    fallbackFrom: null,
  };
}

function mockHardwareBank(): FixtureBank {
  const bank = freshBank();
  bank.fixtureBankId = "quantum-royale-hardware-k6-v1";
  bank.acquisitionSource = "finite-shot-hardware";
  bank.provenance.qpu = true;
  bank.provenance.remoteService = true;
  bank.provenance.mothApi = false;
  for (const checkpoint of Object.values(bank.checkpoints)) {
    if (checkpoint.acquisition.providerMode !== "local-aer")
      throw new Error("Committed fixture contains a non-Aer checkpoint.");
    checkpoint.acquisition = mockHardwareAcquisition(checkpoint.acquisition);
  }
  const calibration = bank.calibration as {
    status: string;
    finiteShotRepeatDiagnostics: Array<{
      executions: Array<{
        acquisition:
          LocalAerAcquisitionRecord | BatchedHardwareAcquisitionRecord;
      }>;
    }>;
  };
  calibration.status = "accepted-for-hardware-prototype";
  for (const diagnostic of calibration.finiteShotRepeatDiagnostics) {
    for (const execution of diagnostic.executions) {
      if (execution.acquisition.providerMode !== "local-aer")
        throw new Error("Committed repeat contains a non-Aer acquisition.");
      execution.acquisition = mockHardwareAcquisition(execution.acquisition);
    }
  }
  return bank;
}

describe("fixture-bank contract", () => {
  it("pins the committed bank and compares the untouched V1 sibling when locally available", () => {
    const siblingUrl = new URL(
      "../../../quantum-royale-browser/fixtures/quantum-royale-aer-v1.json",
      import.meta.url,
    );
    const v2Bytes = Buffer.from(FIXTURE_TEXT, "utf8");
    const hash = (bytes: Uint8Array): string =>
      createHash("sha256").update(bytes).digest("hex");
    expect(hash(v2Bytes)).toBe(
      "f00d3123374cbc92600677845c1e7af0e98f93e5cb137d95016f62185dc049cc",
    );
    if (existsSync(siblingUrl)) {
      expect(v2Bytes.equals(readFileSync(siblingUrl))).toBe(true);
    }
  });

  it("accepts the committed finite-shot Aer bank", () => {
    const bank = validateFixtureBank(freshBank());

    expect(bank.schemaVersion).toBe("quantum-royale-fixture-bank-v1");
    expect(bank.acquisitionSource).toBe("finite-shot-aer");
    expect(Object.keys(bank.checkpoints)).toHaveLength(15);
  });

  it("ships a parseable schema for the same bank version and acquisition boundary", () => {
    const schema = FIXTURE_SCHEMA as {
      $schema?: unknown;
      $id?: unknown;
      properties?: Record<string, { const?: unknown; enum?: unknown }>;
      $defs?: Record<string, { pattern?: string }>;
    };

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("urn:quantum-royale:schema:fixture-bank:v1");
    expect(schema.properties?.schemaVersion?.const).toBe(
      "quantum-royale-fixture-bank-v1",
    );
    expect(schema.properties?.acquisitionSource?.enum).toEqual([
      "finite-shot-aer",
      "finite-shot-hardware",
    ]);
    const gitObjectIdPattern = schema.$defs?.gitObjectId?.pattern;
    expect(gitObjectIdPattern).toBeDefined();
    expect(freshBank().provenance.quantumGraphCommit).toMatch(
      new RegExp(gitObjectIdPattern ?? ""),
    );
    expect(freshBank().provenance.pairwiseTomographyCommit).toMatch(
      new RegExp(gitObjectIdPattern ?? ""),
    );
  });

  it("validates the committed bank with its declared Draft 2020-12 schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(FIXTURE_SCHEMA);
    const valid = validate(freshBank());

    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);

    const missingProvenance = freshBank();
    delete (missingProvenance.provenance as unknown as Record<string, unknown>)
      .quantumGraphCommit;
    expect(validate(missingProvenance)).toBe(false);

    const unknownOperation = freshBank();
    const operation =
      unknownOperation.checkpoints["round-2-M"]?.operationHistory[0];
    if (!operation) throw new Error("Fixture is missing round-2-M operation.");
    operation.operationId = "invented-operation";
    expect(validate(unknownOperation)).toBe(false);
  });

  it("rejects missing source provenance", () => {
    const bank = freshBank();
    delete (bank.provenance as unknown as Record<string, unknown>)
      .quantumGraphCommit;

    expect(() => validateFixtureBank(bank)).toThrow(/quantumGraphCommit/);
  });

  it("rejects incomplete hardware evidence in strict schema and runtime validation", () => {
    const bank = mockHardwareBank();
    const checkpoint = root(bank);
    delete (checkpoint.acquisition as unknown as Record<string, unknown>)
      .resultId;

    expect(() => validateFixtureBank(bank)).toThrow(/resultId/);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(FIXTURE_SCHEMA);
    expect(validate(bank)).toBe(false);
  });

  it("accepts a complete mock hardware provenance union without changing pair data", () => {
    const bank = mockHardwareBank();
    const validated = validateFixtureBank(bank);
    expect(validated.acquisitionSource).toBe("finite-shot-hardware");
    expect(root(validated).acquisition.providerMode).toBe("batched-hardware");

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(FIXTURE_SCHEMA);
    expect(validate(bank), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const resolver = new FixtureResolver(validated);
    const resolved = resolver.getPairDistribution(
      "round-1-root",
      ["velvet-talon", "cornfield-comet"],
      "X",
      "quantum",
    );
    expect(resolved.acquisitionSource).toBe("finite-shot-hardware");
  });

  it("rejects a hardware checkpoint mixed into an Aer bank in strict schema and runtime validation", () => {
    const bank = freshBank();
    const checkpoint = root(bank);
    if (checkpoint.acquisition.providerMode !== "local-aer")
      throw new Error("Fixture root is not local Aer.");
    checkpoint.acquisition = mockHardwareAcquisition(checkpoint.acquisition);

    expect(() => validateFixtureBank(bank)).toThrow(/mixes batched hardware/);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(FIXTURE_SCHEMA);
    expect(validate(bank)).toBe(false);
  });

  it("rejects a spotlight window after its fallback deadline", () => {
    const bank = freshBank();
    root(bank).spotlight.windowOpensAtSeconds = 37;
    root(bank).spotlight.fallbackDeadlineSeconds = 36;

    expect(() => validateFixtureBank(bank)).toThrow(
      /invalid spotlight timing window/,
    );
  });

  it("rejects a topology other than the admitted complete K6 graph", () => {
    const bank = freshBank();
    (bank.model as unknown as { topologyKind: string }).topologyKind = "line";

    expect(() => validateFixtureBank(bank)).toThrow(/admitted K6 game model/);
  });

  it("rejects an unknown chicken identity", () => {
    const bank = freshBank();
    const firstMapping = bank.model.qubitMap[0];
    if (!firstMapping) throw new Error("Fixture is missing q0.");
    (firstMapping as unknown as { chickenId: string }).chickenId =
      "unknown-chicken";

    expect(() => validateFixtureBank(bank)).toThrow(/stable cast/);
  });

  it("rejects invalid probabilities and matrix ordering", () => {
    const invalidProbability = freshBank();
    const invalidProbabilityPair = root(invalidProbability).pairs["0-1"];
    if (!invalidProbabilityPair)
      throw new Error("Fixture is missing pair 0-1.");
    invalidProbabilityPair.distributions.X.pp = 1.25;
    expect(() => validateFixtureBank(invalidProbability)).toThrow(
      /not a valid probability/,
    );

    const invalidSum = freshBank();
    const invalidSumPair = root(invalidSum).pairs["0-1"];
    if (!invalidSumPair) throw new Error("Fixture is missing pair 0-1.");
    invalidSumPair.distributions.X.pp = 0.5;
    expect(() => validateFixtureBank(invalidSum)).toThrow(/sums to .*not 1/);

    const invalidOrder = freshBank();
    const invalidOrderPair = root(invalidOrder).pairs["0-1"];
    if (!invalidOrderPair) throw new Error("Fixture is missing pair 0-1.");
    (invalidOrderPair as unknown as { matrixOrder: string }).matrixOrder =
      "lo-tensor-hi";
    expect(() => validateFixtureBank(invalidOrder)).toThrow(
      /wrong matrix order/,
    );
  });

  it("rejects unknown operations, missing branches, and branch cycles", () => {
    const invalidOperation = freshBank();
    const firstChild = invalidOperation.checkpoints["round-2-M"];
    const firstOperation = firstChild?.operationHistory[0];
    if (!firstOperation)
      throw new Error("Fixture is missing its first operation.");
    (firstOperation as unknown as { gate: string }).gate = "RZZ";
    expect(() => validateFixtureBank(invalidOperation)).toThrow(
      /unallowlisted operation recipe/,
    );

    const missingBranch = freshBank();
    delete root(missingBranch).children.MATCHED_ACTION;
    expect(() => validateFixtureBank(missingBranch)).toThrow(
      /needs two branch children/,
    );

    const cycle = freshBank();
    root(cycle).children.MATCHED_ACTION = "round-1-root";
    expect(() => validateFixtureBank(cycle)).toThrow(/branch cycle/);
  });

  it("rejects tampered branch reduction and operation identity, recipe, and chain", () => {
    const invalidRule = freshBank();
    invalidRule.branchRule.MATCHED_ACTION = ["pp", "pm"];
    expect(() => validateFixtureBank(invalidRule)).toThrow(
      /joint-outcome reduction/,
    );

    const invalidId = freshBank();
    const invalidIdOperation =
      invalidId.checkpoints["round-2-M"]?.operationHistory[0];
    if (!invalidIdOperation)
      throw new Error("Fixture is missing round-2-M operation.");
    invalidIdOperation.operationId = "invented-operation";
    expect(() => validateFixtureBank(invalidId)).toThrow(
      /unknown operation ID/,
    );

    const invalidSourceRound = freshBank();
    const invalidSourceOperation =
      invalidSourceRound.checkpoints["round-2-M"]?.operationHistory[0];
    if (!invalidSourceOperation)
      throw new Error("Fixture is missing round-2-M operation.");
    invalidSourceOperation.sourceRound = 2;
    expect(() => validateFixtureBank(invalidSourceRound)).toThrow(
      /wrong source round/,
    );

    const invalidAngle = freshBank();
    const invalidAngleOperation =
      invalidAngle.checkpoints["round-2-M"]?.operationHistory[0];
    if (!invalidAngleOperation)
      throw new Error("Fixture is missing round-2-M operation.");
    invalidAngleOperation.angleRadians = -Math.PI / 4;
    expect(() => validateFixtureBank(invalidAngle)).toThrow(
      /wrong branch angle/,
    );

    const invalidParentHash = freshBank();
    const invalidParentOperation =
      invalidParentHash.checkpoints["round-2-M"]?.operationHistory[0];
    const childCircuit =
      invalidParentHash.checkpoints["round-2-M"]?.circuit.sha256;
    if (!invalidParentOperation || !childCircuit)
      throw new Error("Fixture is missing round-2-M operation evidence.");
    invalidParentOperation.parentCircuitSha256 = childCircuit;
    expect(() => validateFixtureBank(invalidParentHash)).toThrow(
      /does not extend its parent branch/,
    );
  });

  it("reaches all 15 checkpoints with level counts 1, 2, 4, and 8", () => {
    const bank = validateFixtureBank(freshBank());
    const reached = new Set<string>();
    const pending = ["round-1-root"];

    while (pending.length > 0) {
      const checkpointId = pending.shift();
      if (!checkpointId || reached.has(checkpointId)) continue;
      reached.add(checkpointId);
      const checkpoint = bank.checkpoints[checkpointId];
      if (!checkpoint)
        throw new Error(`Missing reachable checkpoint ${checkpointId}.`);
      for (const childId of Object.values(checkpoint.children))
        if (childId) pending.push(childId);
    }

    const levelCounts = [1, 2, 3, 4].map(
      (roundNumber) =>
        [...reached].filter((id) => bank.checkpoints[id]?.round === roundNumber)
          .length,
    );
    expect(levelCounts).toEqual([1, 2, 4, 8]);
    expect(reached.size).toBe(15);
    for (const checkpointId of reached) {
      expect(
        Object.keys(bank.checkpoints[checkpointId]?.pairs ?? {}),
      ).toHaveLength(15);
    }
  });
});

describe("fixture resolver", () => {
  it("preserves direct pair order and swaps only asymmetric outcomes when reversed", () => {
    const bank = validateFixtureBank(freshBank());
    const resolver = new FixtureResolver(bank);
    const forwardPair: [ChickenId, ChickenId] = [
      "velvet-talon",
      "cornfield-comet",
    ];
    const reversePair: [ChickenId, ChickenId] = [
      "cornfield-comet",
      "velvet-talon",
    ];
    const forward = resolver.getPairDistribution(
      "round-1-root",
      forwardPair,
      "X",
      "quantum",
    );
    const reverse = resolver.getPairDistribution(
      "round-1-root",
      reversePair,
      "X",
      "quantum",
    );
    const source = root(bank).pairs["0-1"]?.distributions.X;

    expect(source).toBeDefined();
    expect(forward.probabilities).toEqual(source);
    expect(forward.canonicalEdge).toEqual([0, 1]);
    expect(forward.qubits).toEqual([0, 1]);
    expect(reverse.canonicalEdge).toEqual([0, 1]);
    expect(reverse.qubits).toEqual([1, 0]);
    expect(forward.probabilities.pm).not.toBeCloseTo(
      forward.probabilities.mp,
      10,
    );
    expect(reverse.probabilities).toEqual({
      pp: forward.probabilities.pp,
      pm: forward.probabilities.mp,
      mp: forward.probabilities.pm,
      mm: forward.probabilities.mm,
    });
  });

  it("uses the stored product control and preserves each individual action marginal", () => {
    const bank = validateFixtureBank(freshBank());

    for (const checkpoint of Object.values(bank.checkpoints)) {
      for (const pair of Object.values(checkpoint.pairs)) {
        for (const context of CONTEXTS) {
          const quantum = pair.distributions[context];
          const control = pair.productMarginalsControl[context];
          const leftPlus = quantum.pp + quantum.pm;
          const rightPlus = quantum.pp + quantum.mp;
          const expected = {
            pp: leftPlus * rightPlus,
            pm: leftPlus * (1 - rightPlus),
            mp: (1 - leftPlus) * rightPlus,
            mm: (1 - leftPlus) * (1 - rightPlus),
          };

          expect(control.pp).toBeCloseTo(expected.pp, 12);
          expect(control.pm).toBeCloseTo(expected.pm, 12);
          expect(control.mp).toBeCloseTo(expected.mp, 12);
          expect(control.mm).toBeCloseTo(expected.mm, 12);
          expect(control.pp + control.pm).toBeCloseTo(leftPlus, 12);
          expect(control.pp + control.mp).toBeCloseTo(rightPlus, 12);
        }
      }
    }

    const resolver = new FixtureResolver(bank);
    const resolved = resolver.getPairDistribution(
      "round-1-root",
      ["velvet-talon", "cornfield-comet"],
      "X",
      "product-control",
    );
    expect(resolved.mode).toBe("product-control");
    expect(resolved.acquisitionSource).toBe("classical-product-control");
    expect(resolved.probabilities).toEqual(
      root(bank).pairs["0-1"]?.productMarginalsControl.X,
    );
  });
});

describe("outcome sampling", () => {
  const vector: ProbabilityVector = {
    pp: 0.125,
    pm: 0.25,
    mp: 0.25,
    mm: 0.375,
  };

  it("assigns exact cumulative boundaries to the following outcome", () => {
    expect(selectOutcome(vector, 0)).toBe("pp");
    expect(selectOutcome(vector, 0.124999999)).toBe("pp");
    expect(selectOutcome(vector, 0.125)).toBe("pm");
    expect(selectOutcome(vector, 0.374999999)).toBe("pm");
    expect(selectOutcome(vector, 0.375)).toBe("mp");
    expect(selectOutcome(vector, 0.624999999)).toBe("mp");
    expect(selectOutcome(vector, 0.625)).toBe("mm");
    expect(selectOutcome(vector, 0.999999999)).toBe("mm");
  });

  it("rejects draws outside the half-open unit interval", () => {
    for (const draw of [-1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => selectOutcome(vector, draw)).toThrow(/\[0, 1\)/);
    }
  });
});
