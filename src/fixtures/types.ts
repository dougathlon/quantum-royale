import type { ChickenId } from "../content/chickens";

export type Context = "X" | "Y" | "Z";
export type OutcomeKey = "pp" | "pm" | "mp" | "mm";
export type BranchLabel = "MATCHED_ACTION" | "SPLIT_ACTION";
export type ResolverMode = "quantum" | "product-control";
export type QuantumAcquisitionSource =
  "finite-shot-aer" | "finite-shot-hardware";

export interface ProbabilityVector {
  pp: number;
  pm: number;
  mp: number;
  mm: number;
}

export interface PairRecord {
  canonicalEdge: [number, number];
  matrixOrder: "hi-tensor-lo";
  densityMatrix: unknown;
  pauliExpectations: Record<string, number>;
  distributions: Record<Context, ProbabilityVector>;
  productMarginalsControl: Record<Context, ProbabilityVector>;
}

export interface FixtureOperation {
  operationId: string;
  sourceRound: number;
  trigger: BranchLabel;
  gate: "CRY" | "RZX";
  angleRadians: number;
  orderedPair: [number, number];
  requestedMeaning: null;
  parentCircuitSha256: string;
  resultCircuitSha256: string;
}

export interface AcquisitionFailureRecord {
  providerName: string;
  backendName: string;
  mothApi: boolean;
  stage: string;
  occurredAtUtc: string;
  reason: string;
  jobId: string | null;
}

export interface LocalAerAcquisitionRecord {
  backendClass: "AerSimulator";
  backendName: "aer_simulator";
  providerMode: "local-aer";
  providerName: "qiskit-aer";
  mothApi: false;
  jobId: string;
  shotsPerCircuit: number;
  simulatorSeed: number;
  transpilerSeed: number;
  tomographyCircuitCount: 15;
  totalShots: number;
  logicalMeasurementCircuitSha256: string[];
  transpiledAerCircuitSha256: string[];
  rawCountsSha256: string;
  durableProviderResult: false;
  hardwareLayout: null;
  backendCalibration: null;
  fallbackFrom: AcquisitionFailureRecord | null;
}

export interface BatchedHardwareAcquisitionRecord {
  backendClass: string;
  backendName: string;
  providerMode: "batched-hardware";
  providerName: string;
  mothApi: boolean;
  jobId: string;
  resultId: string;
  submittedAtUtc: string;
  completedAtUtc: string;
  retrievedAtUtc: string;
  shotsPerCircuit: number;
  simulatorSeed: null;
  tomographyCircuitCount: 15;
  totalShots: number;
  logicalMeasurementCircuitSha256: string[];
  transpilation: {
    toolName: string;
    toolVersion: string;
    seed: number;
    settings: Record<string, unknown>;
    isaCircuitSha256: string[];
  };
  rawCountsSha256: string;
  durableProviderResult: true;
  hardwareLayout: {
    logicalToPhysical: [number, number, number, number, number, number];
    targetName: string;
    targetSnapshotSha256: string;
  };
  backendCalibration: {
    calibrationId: string;
    timestampUtc: string;
    sha256: string;
  };
  fallbackFrom: AcquisitionFailureRecord | null;
}

export type FixtureAcquisitionRecord =
  LocalAerAcquisitionRecord | BatchedHardwareAcquisitionRecord;

export interface FixtureCheckpoint {
  checkpointId: string;
  round: number;
  path: string;
  parentId: string | null;
  children: Partial<Record<BranchLabel, string>>;
  spotlight: {
    orderedPair: [number, number];
    context: Context;
    windowOpensAtSeconds: number;
    fallbackDeadlineSeconds: number;
  };
  circuit: {
    format: string;
    sha256: string;
    depth: number;
    twoQubitDepth: number;
    operationCounts: Record<string, number>;
    serialization: string;
  };
  operationHistory: FixtureOperation[];
  acquisition: FixtureAcquisitionRecord;
  derivation: {
    method: "lstsq-psd";
    matrixOrder: "hi-tensor-lo";
    probabilityProjectors: "Pi_hi tensor Pi_lo";
    maxFiniteVsExactTotalVariation: number;
  };
  pairs: Record<string, PairRecord>;
  exactStateDiagnostic: unknown;
}

export interface FixtureBank {
  schemaVersion: "quantum-royale-fixture-bank-v1";
  fixtureBankId: string;
  compiledAt: string;
  deliveryMode: "committed-fixture";
  acquisitionSource: QuantumAcquisitionSource;
  derivationMethod: "lstsq-psd";
  model: {
    modelId: string;
    numQubits: 6;
    qubitMap: Array<{
      qubit: number;
      chickenId: ChickenId;
      displayName: string;
    }>;
    configuredEdges: Array<[number, number]>;
    topologyKind: "complete-k6-gameplay-relationship-graph";
    initialCircuit: FixtureCheckpoint["circuit"];
  };
  provenance: {
    python: string;
    platform: string;
    packageVersions: Record<string, string>;
    quantumGraphCommit: string;
    pairwiseTomographyCommit: string;
    sourceRelationship: string;
    qpu: boolean;
    remoteService: boolean;
    mothApi: boolean;
  };
  costEstimate: {
    checkpointCount: 15;
    tomographyCircuitsPerCheckpoint: 15;
    totalCircuitExecutions: 225;
    shotsPerCircuit: number;
    totalShots: number;
  };
  branchRule: Record<BranchLabel, OutcomeKey[]>;
  checkpoints: Record<string, FixtureCheckpoint>;
  calibration: Record<string, unknown>;
}

export interface ResolvedDistribution {
  checkpointId: string;
  orderedPair: [ChickenId, ChickenId];
  qubits: [number, number];
  canonicalEdge: [number, number];
  context: Context;
  probabilities: ProbabilityVector;
  mode: ResolverMode;
  acquisitionSource: QuantumAcquisitionSource | "classical-product-control";
  shotsPerCircuit: number;
}
