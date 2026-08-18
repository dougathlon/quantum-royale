import { CHICKENS, CHICKEN_IDS, isChickenId } from "../content/chickens";
import type {
  AcquisitionFailureRecord,
  BranchLabel,
  Context,
  FixtureAcquisitionRecord,
  FixtureBank,
  FixtureCheckpoint,
  FixtureOperation,
  OutcomeKey,
  PairRecord,
  ProbabilityVector,
  QuantumAcquisitionSource,
} from "./types";

const OUTCOMES: readonly OutcomeKey[] = ["pp", "pm", "mp", "mm"];
const CONTEXTS: readonly Context[] = ["X", "Y", "Z"];
const BRANCHES: readonly BranchLabel[] = ["MATCHED_ACTION", "SPLIT_ACTION"];
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;

function sameOperation(
  left: FixtureOperation,
  right: FixtureOperation,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.sourceRound === right.sourceRound &&
    left.trigger === right.trigger &&
    left.gate === right.gate &&
    left.angleRadians === right.angleRadians &&
    left.orderedPair[0] === right.orderedPair[0] &&
    left.orderedPair[1] === right.orderedPair[1] &&
    left.requestedMeaning === right.requestedMeaning &&
    left.parentCircuitSha256 === right.parentCircuitSha256 &&
    left.resultCircuitSha256 === right.resultCircuitSha256
  );
}

function fail(message: string): never {
  throw new Error(`Invalid Quantum Royale fixture: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a non-empty string.`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum)
    fail(`${label} must be an integer >= ${minimum}.`);
  return value as number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${label} must be a finite number.`);
  return value;
}

function hash(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!SHA256.test(candidate))
    fail(`${label} must be a lowercase SHA-256 digest.`);
  return candidate;
}

function gitOid(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!GIT_OID.test(candidate))
    fail(`${label} must be a full lowercase Git object ID.`);
  return candidate;
}

function utcTimestamp(value: unknown, label: string): number {
  const candidate = string(value, label);
  if (!/(?:Z|\+00:00)$/.test(candidate))
    fail(`${label} must identify a UTC instant.`);
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO timestamp.`);
  return timestamp;
}

function hashArray(value: unknown, label: string, length: number): string[] {
  const values = array(value, label);
  if (values.length !== length) fail(`${label} must contain ${length} hashes.`);
  return values.map((item, index) => hash(item, `${label}[${index}]`));
}

function acquisitionFailure(
  value: unknown,
  label: string,
): AcquisitionFailureRecord | null {
  if (value === null) return null;
  const record = object(value, label);
  string(record.providerName, `${label}.providerName`);
  string(record.backendName, `${label}.backendName`);
  if (typeof record.mothApi !== "boolean")
    fail(`${label}.mothApi must be boolean.`);
  string(record.stage, `${label}.stage`);
  utcTimestamp(record.occurredAtUtc, `${label}.occurredAtUtc`);
  string(record.reason, `${label}.reason`);
  if (record.jobId !== null) string(record.jobId, `${label}.jobId`);
  return record as unknown as AcquisitionFailureRecord;
}

function validateAcquisition(
  value: unknown,
  expectedSource: QuantumAcquisitionSource,
  label: string,
): FixtureAcquisitionRecord {
  const record = object(value, label);
  string(record.backendClass, `${label}.backendClass`);
  string(record.backendName, `${label}.backendName`);
  string(record.providerName, `${label}.providerName`);
  string(record.jobId, `${label}.jobId`);
  if (typeof record.mothApi !== "boolean")
    fail(`${label}.mothApi must be boolean.`);
  const shots = integer(
    record.shotsPerCircuit,
    `${label}.shotsPerCircuit`,
    128,
  );
  const circuitCount = integer(
    record.tomographyCircuitCount,
    `${label}.tomographyCircuitCount`,
  );
  if (circuitCount !== 15) fail(`${label} did not use 15 tomography circuits.`);
  const totalShots = integer(record.totalShots, `${label}.totalShots`, 1);
  if (totalShots !== shots * circuitCount)
    fail(`${label}.totalShots does not match shots × circuits.`);
  hashArray(
    record.logicalMeasurementCircuitSha256,
    `${label}.logicalMeasurementCircuitSha256`,
    15,
  );
  hash(record.rawCountsSha256, `${label}.rawCountsSha256`);
  acquisitionFailure(record.fallbackFrom, `${label}.fallbackFrom`);

  if (record.providerMode === "local-aer") {
    if (expectedSource !== "finite-shot-aer")
      fail(`${label} mixes local Aer into a hardware fixture.`);
    if (
      record.backendClass !== "AerSimulator" ||
      record.backendName !== "aer_simulator" ||
      record.providerName !== "qiskit-aer" ||
      record.mothApi !== false ||
      record.durableProviderResult !== false ||
      record.hardwareLayout !== null ||
      record.backendCalibration !== null
    )
      fail(`${label} mislabels local Aer acquisition.`);
    integer(record.simulatorSeed, `${label}.simulatorSeed`);
    integer(record.transpilerSeed, `${label}.transpilerSeed`);
    hashArray(
      record.transpiledAerCircuitSha256,
      `${label}.transpiledAerCircuitSha256`,
      15,
    );
    return record as unknown as FixtureAcquisitionRecord;
  }

  if (record.providerMode !== "batched-hardware")
    fail(`${label} has an unknown providerMode.`);
  if (expectedSource !== "finite-shot-hardware")
    fail(`${label} mixes batched hardware into an Aer fixture.`);
  if (record.durableProviderResult !== true)
    fail(`${label} hardware result is not durable.`);
  if (record.simulatorSeed !== null)
    fail(`${label} hardware record claims a simulator seed.`);
  string(record.resultId, `${label}.resultId`);
  const submitted = utcTimestamp(
    record.submittedAtUtc,
    `${label}.submittedAtUtc`,
  );
  const completed = utcTimestamp(
    record.completedAtUtc,
    `${label}.completedAtUtc`,
  );
  const retrieved = utcTimestamp(
    record.retrievedAtUtc,
    `${label}.retrievedAtUtc`,
  );
  if (!(submitted <= completed && completed <= retrieved))
    fail(`${label} hardware timestamps are out of order.`);

  const transpilation = object(record.transpilation, `${label}.transpilation`);
  string(transpilation.toolName, `${label}.transpilation.toolName`);
  string(transpilation.toolVersion, `${label}.transpilation.toolVersion`);
  integer(transpilation.seed, `${label}.transpilation.seed`);
  object(transpilation.settings, `${label}.transpilation.settings`);
  hashArray(
    transpilation.isaCircuitSha256,
    `${label}.transpilation.isaCircuitSha256`,
    15,
  );

  const layout = object(record.hardwareLayout, `${label}.hardwareLayout`);
  const physical = array(
    layout.logicalToPhysical,
    `${label}.hardwareLayout.logicalToPhysical`,
  ).map((item, index) =>
    integer(item, `${label}.hardwareLayout.logicalToPhysical[${index}]`),
  );
  if (physical.length !== 6 || new Set(physical).size !== 6)
    fail(`${label} hardware layout must map six distinct physical qubits.`);
  string(layout.targetName, `${label}.hardwareLayout.targetName`);
  hash(
    layout.targetSnapshotSha256,
    `${label}.hardwareLayout.targetSnapshotSha256`,
  );

  const calibration = object(
    record.backendCalibration,
    `${label}.backendCalibration`,
  );
  string(
    calibration.calibrationId,
    `${label}.backendCalibration.calibrationId`,
  );
  utcTimestamp(
    calibration.timestampUtc,
    `${label}.backendCalibration.timestampUtc`,
  );
  hash(calibration.sha256, `${label}.backendCalibration.sha256`);
  return record as unknown as FixtureAcquisitionRecord;
}

function edge(value: unknown, label: string): [number, number] {
  const values = array(value, label);
  if (values.length !== 2) fail(`${label} must contain two qubits.`);
  const lo = integer(values[0], `${label}[0]`);
  const hi = integer(values[1], `${label}[1]`);
  if (lo >= hi || hi >= 6)
    fail(`${label} must be canonical and inside six qubits.`);
  return [lo, hi];
}

function probabilityVector(value: unknown, label: string): ProbabilityVector {
  const record = object(value, label);
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...OUTCOMES].sort().join(","))
    fail(`${label} has unexpected outcome keys.`);
  let total = 0;
  for (const outcome of OUTCOMES) {
    const probability = record[outcome];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      fail(`${label}.${outcome} is not a valid probability.`);
    }
    total += probability;
  }
  if (Math.abs(total - 1) > 1e-8) fail(`${label} sums to ${total}, not 1.`);
  return record as unknown as ProbabilityVector;
}

function pairRecord(
  value: unknown,
  expectedEdge: [number, number],
  label: string,
): PairRecord {
  const record = object(value, label);
  const actualEdge = edge(record.canonicalEdge, `${label}.canonicalEdge`);
  if (actualEdge[0] !== expectedEdge[0] || actualEdge[1] !== expectedEdge[1])
    fail(`${label} edge does not match its key.`);
  if (record.matrixOrder !== "hi-tensor-lo")
    fail(`${label} has wrong matrix order.`);
  for (const collectionName of [
    "distributions",
    "productMarginalsControl",
  ] as const) {
    const collection = object(
      record[collectionName],
      `${label}.${collectionName}`,
    );
    for (const context of CONTEXTS)
      probabilityVector(
        collection[context],
        `${label}.${collectionName}.${context}`,
      );
  }
  object(record.pauliExpectations, `${label}.pauliExpectations`);
  array(record.densityMatrix, `${label}.densityMatrix`);
  return record as unknown as PairRecord;
}

function expectedEdges(): string[] {
  const keys: string[] = [];
  for (let lo = 0; lo < 5; lo += 1)
    for (let hi = lo + 1; hi < 6; hi += 1) keys.push(`${lo}-${hi}`);
  return keys;
}

function validateCheckpoint(
  value: unknown,
  checkpointId: string,
  allIds: Set<string>,
  configuredEdges: Set<string>,
  acquisitionSource: QuantumAcquisitionSource,
): FixtureCheckpoint {
  const checkpoint = object(value, `checkpoint ${checkpointId}`);
  if (checkpoint.checkpointId !== checkpointId)
    fail(`${checkpointId} repeats a different ID.`);
  const round = integer(checkpoint.round, `${checkpointId}.round`, 1);
  if (round > 4) fail(`${checkpointId} round exceeds 4.`);
  const path = checkpoint.path;
  if (
    typeof path !== "string" ||
    !/^[MS]*$/.test(path) ||
    path.length !== round - 1
  )
    fail(`${checkpointId} has an invalid path.`);
  const parentId = checkpoint.parentId;
  if (
    round === 1
      ? parentId !== null
      : typeof parentId !== "string" || !allIds.has(parentId)
  )
    fail(`${checkpointId} has an invalid parent.`);

  const children = object(checkpoint.children, `${checkpointId}.children`);
  if (round < 4) {
    if (
      Object.keys(children).sort().join(",") !== [...BRANCHES].sort().join(",")
    )
      fail(`${checkpointId} needs two branch children.`);
    if (children.MATCHED_ACTION === children.SPLIT_ACTION)
      fail(`${checkpointId} reuses a child.`);
    for (const branch of BRANCHES)
      if (
        typeof children[branch] !== "string" ||
        !allIds.has(children[branch] as string)
      )
        fail(`${checkpointId} has an unknown ${branch} child.`);
  } else if (Object.keys(children).length !== 0)
    fail(`${checkpointId} is a leaf with children.`);

  const spotlight = object(checkpoint.spotlight, `${checkpointId}.spotlight`);
  const spotlightEdge = edge(
    spotlight.orderedPair,
    `${checkpointId}.spotlight.orderedPair`,
  );
  if (!configuredEdges.has(spotlightEdge.join("-")))
    fail(`${checkpointId} spotlight is not configured.`);
  if (!CONTEXTS.includes(spotlight.context as Context))
    fail(`${checkpointId} has an unknown spotlight context.`);
  const windowOpens = finiteNumber(
    spotlight.windowOpensAtSeconds,
    `${checkpointId}.spotlight.windowOpensAtSeconds`,
  );
  const fallbackDeadline = finiteNumber(
    spotlight.fallbackDeadlineSeconds,
    `${checkpointId}.spotlight.fallbackDeadlineSeconds`,
  );
  if (
    windowOpens < 0 ||
    fallbackDeadline > 45 ||
    windowOpens > fallbackDeadline
  )
    fail(`${checkpointId} has an invalid spotlight timing window.`);

  const circuit = object(checkpoint.circuit, `${checkpointId}.circuit`);
  hash(circuit.sha256, `${checkpointId}.circuit.sha256`);
  string(circuit.serialization, `${checkpointId}.circuit.serialization`);
  validateAcquisition(
    checkpoint.acquisition,
    acquisitionSource,
    `${checkpointId}.acquisition`,
  );
  const derivation = object(
    checkpoint.derivation,
    `${checkpointId}.derivation`,
  );
  if (
    derivation.method !== "lstsq-psd" ||
    derivation.matrixOrder !== "hi-tensor-lo"
  )
    fail(`${checkpointId} has wrong derivation provenance.`);

  const pairMap = object(checkpoint.pairs, `${checkpointId}.pairs`);
  if (
    Object.keys(pairMap).sort().join(",") !== expectedEdges().sort().join(",")
  )
    fail(`${checkpointId} does not contain all 15 direct pair records.`);
  for (const pairKey of expectedEdges()) {
    const [lo, hi] = pairKey.split("-").map(Number) as [number, number];
    pairRecord(pairMap[pairKey], [lo, hi], `${checkpointId}.pairs.${pairKey}`);
  }

  const history = array(
    checkpoint.operationHistory,
    `${checkpointId}.operationHistory`,
  );
  if (history.length !== round - 1)
    fail(`${checkpointId} has the wrong operation-history length.`);
  for (const [index, item] of history.entries()) {
    const operation = object(
      item,
      `${checkpointId}.operationHistory[${index}]`,
    );
    const sourceRound = integer(
      operation.sourceRound,
      `${checkpointId}.operationSourceRound`,
      1,
    );
    if (sourceRound !== index + 1 || sourceRound > 3)
      fail(`${checkpointId} has an operation at the wrong source round.`);
    if (!BRANCHES.includes(operation.trigger as BranchLabel))
      fail(`${checkpointId} has an unknown operation trigger.`);
    const trigger = operation.trigger as BranchLabel;
    const expectedTrigger =
      path[index] === "M" ? "MATCHED_ACTION" : "SPLIT_ACTION";
    if (trigger !== expectedTrigger)
      fail(`${checkpointId} operation trigger does not match its branch path.`);
    const expectedGate = sourceRound === 1 ? "CRY" : "RZX";
    if (operation.gate !== expectedGate)
      fail(`${checkpointId} has an unallowlisted operation recipe.`);
    const expectedEdge: [number, number] =
      sourceRound === 1 ? [0, 1] : sourceRound === 2 ? [2, 3] : [4, 5];
    const operationEdge = edge(
      operation.orderedPair,
      `${checkpointId}.operationEdge`,
    );
    if (
      operationEdge[0] !== expectedEdge[0] ||
      operationEdge[1] !== expectedEdge[1]
    )
      fail(`${checkpointId} operation targets the wrong spotlight pair.`);
    const angleMagnitude = sourceRound === 1 ? Math.PI : Math.PI / 2;
    const expectedAngle =
      trigger === "MATCHED_ACTION" ? angleMagnitude : -angleMagnitude;
    if (
      Math.abs(
        finiteNumber(operation.angleRadians, `${checkpointId}.operationAngle`) -
          expectedAngle,
      ) > 1e-12
    )
      fail(`${checkpointId} operation uses the wrong branch angle.`);
    const expectedOperationId = `round-${sourceRound}-${expectedGate.toLowerCase()}-${trigger.toLowerCase()}`;
    if (operation.operationId !== expectedOperationId)
      fail(`${checkpointId} has an unknown operation ID.`);
    hash(operation.parentCircuitSha256, `${checkpointId}.operationParentHash`);
    hash(operation.resultCircuitSha256, `${checkpointId}.operationResultHash`);
    if (operation.requestedMeaning !== null)
      fail(`${checkpointId} operation invents semantic meaning.`);
  }
  if (history.length > 0) {
    const last = object(history.at(-1), `${checkpointId}.lastOperation`);
    if (last.resultCircuitSha256 !== circuit.sha256)
      fail(`${checkpointId} circuit does not match its last operation.`);
  }
  return checkpoint as unknown as FixtureCheckpoint;
}

export function validateFixtureBank(input: unknown): FixtureBank {
  const bank = object(input, "bank");
  if (bank.schemaVersion !== "quantum-royale-fixture-bank-v1")
    fail("unknown schemaVersion.");
  const acquisitionSource = bank.acquisitionSource;
  if (
    bank.deliveryMode !== "committed-fixture" ||
    (acquisitionSource !== "finite-shot-aer" &&
      acquisitionSource !== "finite-shot-hardware") ||
    bank.derivationMethod !== "lstsq-psd"
  ) {
    fail("delivery/acquisition/derivation provenance is inconsistent.");
  }
  const provenance = object(bank.provenance, "provenance");
  if (acquisitionSource === "finite-shot-aer") {
    if (
      provenance.qpu !== false ||
      provenance.remoteService !== false ||
      provenance.mothApi !== false
    )
      fail("local fixture claims remote or hardware execution.");
  } else if (
    provenance.qpu !== true ||
    provenance.remoteService !== true ||
    typeof provenance.mothApi !== "boolean"
  ) {
    fail("hardware fixture lacks explicit remote/QPU provenance.");
  }
  gitOid(provenance.quantumGraphCommit, "quantumGraphCommit");
  gitOid(provenance.pairwiseTomographyCommit, "pairwiseTomographyCommit");

  const branchRule = object(bank.branchRule, "branchRule");
  if (
    Object.keys(branchRule).sort().join(",") !== [...BRANCHES].sort().join(",")
  )
    fail("branchRule must define exactly MATCHED_ACTION and SPLIT_ACTION.");
  const matched = array(branchRule.MATCHED_ACTION, "branchRule.MATCHED_ACTION");
  const split = array(branchRule.SPLIT_ACTION, "branchRule.SPLIT_ACTION");
  if (matched.join(",") !== "pp,mm" || split.join(",") !== "pm,mp")
    fail("branchRule does not match the admitted joint-outcome reduction.");

  const model = object(bank.model, "model");
  if (
    model.numQubits !== 6 ||
    model.topologyKind !== "complete-k6-gameplay-relationship-graph"
  )
    fail("model is not the admitted K6 game model.");
  const mapping = array(model.qubitMap, "model.qubitMap");
  if (mapping.length !== 6) fail("qubitMap must have six chickens.");
  for (const [index, raw] of mapping.entries()) {
    const item = object(raw, `qubitMap[${index}]`);
    if (
      item.qubit !== index ||
      !isChickenId(item.chickenId) ||
      item.chickenId !== CHICKEN_IDS[index]
    )
      fail(`qubitMap[${index}] does not match the stable cast.`);
    if (item.displayName !== CHICKENS[index]?.name)
      fail(`qubitMap[${index}] has the wrong display name.`);
  }
  const configured = array(model.configuredEdges, "configuredEdges").map(
    (item, index) => edge(item, `configuredEdges[${index}]`),
  );
  const configuredKeys = new Set(configured.map((item) => item.join("-")));
  if (
    configuredKeys.size !== 15 ||
    expectedEdges().some((item) => !configuredKeys.has(item))
  )
    fail("configuredEdges is not complete K6.");

  const checkpointMap = object(bank.checkpoints, "checkpoints");
  const ids = new Set(Object.keys(checkpointMap));
  if (ids.size !== 15) fail(`expected 15 checkpoints, found ${ids.size}.`);
  const checkpoints = new Map<string, FixtureCheckpoint>();
  for (const [checkpointId, value] of Object.entries(checkpointMap))
    checkpoints.set(
      checkpointId,
      validateCheckpoint(
        value,
        checkpointId,
        ids,
        configuredKeys,
        acquisitionSource,
      ),
    );
  const levelCounts = [1, 2, 3, 4].map(
    (round) =>
      [...checkpoints.values()].filter((item) => item.round === round).length,
  );
  if (levelCounts.join(",") !== "1,2,4,8")
    fail(`wrong branch level counts: ${levelCounts.join(",")}.`);
  const roots = [...checkpoints.values()].filter(
    (item) => item.parentId === null,
  );
  if (roots.length !== 1 || roots[0]?.checkpointId !== "round-1-root")
    fail("tree must have one canonical root.");
  const root = roots[0];
  if (!root) fail("tree has no root checkpoint.");
  const initialCircuit = object(model.initialCircuit, "model.initialCircuit");
  if (
    initialCircuit.sha256 !== root.circuit.sha256 ||
    initialCircuit.serialization !== root.circuit.serialization
  )
    fail("model initial circuit does not match the root checkpoint.");

  const reached = new Set<string>();
  const visit = (id: string, stack: Set<string>): void => {
    if (stack.has(id)) fail(`branch cycle at ${id}.`);
    if (reached.has(id)) fail(`checkpoint ${id} has multiple parents.`);
    const checkpoint = checkpoints.get(id);
    if (!checkpoint) fail(`missing checkpoint ${id}.`);
    reached.add(id);
    const nextStack = new Set(stack).add(id);
    for (const childId of Object.values(checkpoint.children))
      if (childId) visit(childId, nextStack);
  };
  visit("round-1-root", new Set());
  if (reached.size !== 15) fail("tree contains orphan checkpoints.");

  for (const checkpoint of checkpoints.values()) {
    if (checkpoint.parentId === null) continue;
    const parent = checkpoints.get(checkpoint.parentId);
    if (!parent) fail(`${checkpoint.checkpointId} has no validated parent.`);
    const branch = BRANCHES.find(
      (candidate) => parent.children[candidate] === checkpoint.checkpointId,
    );
    if (!branch)
      fail(`${checkpoint.checkpointId} is not linked by its declared parent.`);
    const latestOperation = checkpoint.operationHistory.at(-1);
    if (!latestOperation)
      fail(`${checkpoint.checkpointId} has no branch operation.`);
    if (
      latestOperation.trigger !== branch ||
      latestOperation.parentCircuitSha256 !== parent.circuit.sha256
    )
      fail(
        `${checkpoint.checkpointId} operation does not extend its parent branch.`,
      );
    if (
      parent.operationHistory.length + 1 !==
      checkpoint.operationHistory.length
    )
      fail(
        `${checkpoint.checkpointId} does not extend its parent history once.`,
      );
    for (const [index, parentOperation] of parent.operationHistory.entries()) {
      const childOperation = checkpoint.operationHistory[index];
      if (!childOperation || !sameOperation(childOperation, parentOperation))
        fail(
          `${checkpoint.checkpointId} rewrites inherited operation history.`,
        );
    }
    for (
      let index = 0;
      index < checkpoint.operationHistory.length - 1;
      index += 1
    ) {
      const current = checkpoint.operationHistory[index];
      const next = checkpoint.operationHistory[index + 1];
      if (
        !current ||
        !next ||
        current.resultCircuitSha256 !== next.parentCircuitSha256
      )
        fail(
          `${checkpoint.checkpointId} has a broken circuit-history hash chain.`,
        );
    }
  }
  for (const checkpoint of checkpoints.values()) {
    if (!checkpoint.parentId) continue;
    const parent = checkpoints.get(checkpoint.parentId);
    if (!parent || checkpoint.round !== parent.round + 1)
      fail(`${checkpoint.checkpointId} has an invalid round jump.`);
    const lastOperation = checkpoint.operationHistory.at(-1);
    if (
      !lastOperation ||
      lastOperation.parentCircuitSha256 !== parent.circuit.sha256
    )
      fail(`${checkpoint.checkpointId} does not extend its parent's circuit.`);
    if (
      lastOperation.orderedPair.join("-") !==
      parent.spotlight.orderedPair.join("-")
    )
      fail(
        `${checkpoint.checkpointId} operation misses the parent spotlight edge.`,
      );
  }
  return bank as unknown as FixtureBank;
}
