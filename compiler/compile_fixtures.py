#!/usr/bin/env python3
"""Compile the immutable finite-shot Aer branch bank used by Quantum Royale.

This wrapper deliberately uses the pinned QuantumGraph construction and fitter,
but performs the transpile/run step explicitly so the compiled artifact can keep
the job, raw-count, circuit, and seed provenance that QuantumGraph's convenience
method discards.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from importlib import metadata
import json
import math
from pathlib import Path
import platform
import random
from typing import Any, Iterable, Literal, Protocol

import numpy as np
from qiskit import QuantumCircuit, qasm2, transpile
from qiskit.quantum_info import Statevector, partial_trace
from qiskit_aer import AerSimulator
from pairwise_tomography import (
    PairwiseStateTomographyFitter,
    pairwise_state_tomography_circuits,
)
from quantumgraph import ExpectationValue, QuantumGraph


SCHEMA_VERSION = "quantum-royale-fixture-bank-v1"
MODEL_ID = "quantum-royale-k6-ring-mixer-v1"
QUANTUMGRAPH_COMMIT = "6917364b9496bd324225e87e6dd986bce52ecefd"
PAIRWISE_TOMOGRAPHY_COMMIT = "dbab12513281bd8ca7828252cf2e98a1a5749761"
QUANTUMGRAPH_URL = "https://github.com/moth-quantum/QuantumGraph.git"
PAIRWISE_TOMOGRAPHY_URL = (
    "https://github.com/moth-quantum/pairwise-tomography.git"
)
NUM_QUBITS = 6
DEFAULT_SHOTS = 4096
DEFAULT_SEED = 260817
TOLERANCE = 1e-12
TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT = 15
EXACT_ACTIVE_CONTEXT_TV_THRESHOLD = 0.15
EXACT_OVERLAPPING_EDGE_TV_THRESHOLD = 0.05
FINITE_TO_PARENT_NOISE_MULTIPLIER = 3.0
REPEAT_COUNT_PER_PARENT = 3
REPEAT_SEED_OFFSET = 100_000

CHICKENS = (
    ("velvet-talon", "Velvet Talon"),
    ("cornfield-comet", "Cornfield Comet"),
    ("scarlet-bantam", "Scarlet Bantam"),
    ("midnight-rooster", "Midnight Rooster"),
    ("buttercup-blitz", "Buttercup Blitz"),
    ("silver-drumstick", "Silver Drumstick"),
)
EDGES = tuple(
    (lo, hi)
    for lo in range(NUM_QUBITS - 1)
    for hi in range(lo + 1, NUM_QUBITS)
)
PAULIS = {
    "I": np.eye(2, dtype=complex),
    "X": np.array([[0, 1], [1, 0]], dtype=complex),
    "Y": np.array([[0, -1j], [1j, 0]], dtype=complex),
    "Z": np.array([[1, 0], [0, -1]], dtype=complex),
}


@dataclass(frozen=True)
class Spotlight:
    pair: tuple[int, int]
    context: str
    gate: str | None
    theta: float | None


SPOTLIGHTS = {
    1: Spotlight((0, 1), "X", "cry", math.pi),
    2: Spotlight((2, 3), "Y", "rzx", math.pi / 2),
    3: Spotlight((4, 5), "Z", "rzx", math.pi / 2),
    4: Spotlight((0, 5), "X", None, None),
}


PINNED_VCS_SOURCES = {
    "quantumgraph": {
        "url": QUANTUMGRAPH_URL,
        "commit": QUANTUMGRAPH_COMMIT,
    },
    "pairwise-tomography": {
        "url": PAIRWISE_TOMOGRAPHY_URL,
        "commit": PAIRWISE_TOMOGRAPHY_COMMIT,
    },
}


@dataclass
class NodeSpec:
    checkpoint_id: str
    round_number: int
    path: str
    parent_id: str | None
    circuit: QuantumCircuit
    operation_history: list[dict[str, Any]]
    children: dict[str, str]


AcquisitionMode = Literal["local-aer", "batched-hardware"]
AcquisitionStatus = Literal["completed", "failed"]


@dataclass(frozen=True)
class AcquisitionRequest:
    """Logical tomography work handed to an offline acquisition adapter."""

    logical_circuits: tuple[QuantumCircuit, ...]
    shots_per_circuit: int
    simulator_seed: int | None
    transpiler_seed: int


@dataclass(frozen=True)
class CircuitCounts:
    """One logical circuit's immutable-by-contract integer shot counts."""

    name: str
    counts: dict[str, int]


@dataclass(frozen=True)
class AcquisitionFailure:
    """Relocatable failure evidence, also used to disclose a fallback source."""

    provider_name: str
    backend_name: str
    moth_api: bool
    stage: str
    occurred_at_utc: str
    reason: str
    job_id: str | None


@dataclass(frozen=True)
class HardwareTargetEvidence:
    """Provider-neutral minimum target and calibration record for hardware."""

    logical_to_physical: tuple[int, ...]
    target_name: str
    target_snapshot_sha256: str
    calibration_id: str
    calibration_timestamp_utc: str
    calibration_sha256: str


@dataclass(frozen=True)
class TranspilationEvidence:
    """The tool/settings identity and executable ISA circuit identities."""

    tool_name: str
    tool_version: str
    seed: int
    settings: dict[str, Any]
    isa_circuit_sha256: tuple[str, ...]


@dataclass(frozen=True)
class ExecutionEvidence:
    """Evidence that must validate before tomography fitting can begin.

    A future batched-hardware adapter must populate the durable result and UTC
    timestamps plus ``hardware_target``. A completed fallback keeps the current
    provider here and records the rejected attempt in ``fallback_from``.
    """

    provider_mode: AcquisitionMode
    provider_name: str
    backend_name: str
    backend_class: str
    moth_api: bool
    job_id: str | None
    result_id: str | None
    submitted_at_utc: str | None
    completed_at_utc: str | None
    retrieved_at_utc: str | None
    shots_per_circuit: int
    circuit_count: int
    total_shots: int
    simulator_seed: int | None
    logical_circuit_sha256: tuple[str, ...]
    transpilation: TranspilationEvidence
    raw_counts_sha256: str
    durable_provider_result: bool
    hardware_target: HardwareTargetEvidence | None
    status: AcquisitionStatus
    failure: AcquisitionFailure | None
    fallback_from: AcquisitionFailure | None


@dataclass(frozen=True)
class AcquisitionBatch:
    """Execution result plus the independent evidence needed to trust it."""

    result: Any | None
    isa_circuits: tuple[QuantumCircuit, ...]
    count_records: tuple[CircuitCounts, ...]
    evidence: ExecutionEvidence


class AcquisitionAdapter(Protocol):
    """Narrow offline seam; implementations must not characterize results."""

    provider_mode: AcquisitionMode

    def acquire(self, request: AcquisitionRequest) -> AcquisitionBatch:
        ...


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def verify_pinned_source_revisions() -> dict[str, dict[str, str]]:
    """Verify the installed VCS origins before emitting pinned-source claims."""

    verified: dict[str, dict[str, str]] = {}
    for package_name, expected in PINNED_VCS_SOURCES.items():
        try:
            distribution = metadata.distribution(package_name)
        except metadata.PackageNotFoundError as error:
            raise ValueError(
                f"Pinned dependency {package_name!r} is not installed."
            ) from error
        direct_url_text = distribution.read_text("direct_url.json")
        if not direct_url_text:
            raise ValueError(
                f"Pinned dependency {package_name!r} has no direct_url.json; "
                "its source revision cannot be verified."
            )
        try:
            direct_url = json.loads(direct_url_text)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"Pinned dependency {package_name!r} has invalid direct_url.json."
            ) from error
        if not isinstance(direct_url, dict) or not isinstance(
            direct_url.get("vcs_info"), dict
        ):
            raise ValueError(
                f"Pinned dependency {package_name!r} lacks VCS source evidence."
            )
        vcs_info = direct_url["vcs_info"]
        observed = {
            "url": direct_url.get("url"),
            "vcs": vcs_info.get("vcs"),
            "commit": vcs_info.get("commit_id"),
            "requestedRevision": vcs_info.get("requested_revision"),
        }
        required = {
            "url": expected["url"],
            "vcs": "git",
            "commit": expected["commit"],
            "requestedRevision": expected["commit"],
        }
        if observed != required:
            raise ValueError(
                f"Pinned dependency {package_name!r} source drift: "
                f"expected {stable_json(required)}, observed {stable_json(observed)}."
            )
        verified[package_name] = {
            "url": required["url"],
            "commit": required["commit"],
        }
    return verified


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def circuit_qasm(circuit: QuantumCircuit) -> str:
    return qasm2.dumps(circuit)


def circuit_identity(circuit: QuantumCircuit) -> dict[str, Any]:
    serialized = circuit_qasm(circuit)
    return {
        "format": "OPENQASM 2",
        "sha256": sha256_text(serialized),
        "depth": circuit.depth(),
        "twoQubitDepth": circuit.depth(lambda item: item.operation.num_qubits > 1),
        "operationCounts": dict(sorted(circuit.count_ops().items())),
        "serialization": serialized,
    }


def count_records_payload(
    records: tuple[CircuitCounts, ...],
) -> list[dict[str, Any]]:
    return [
        {"name": record.name, "counts": dict(sorted(record.counts.items()))}
        for record in records
    ]


def validate_acquisition_request(request: AcquisitionRequest) -> None:
    if not request.logical_circuits:
        raise ValueError("Acquisition request has no logical circuits.")
    if any(not isinstance(item, QuantumCircuit) for item in request.logical_circuits):
        raise ValueError("Acquisition request contains a non-circuit value.")
    if type(request.shots_per_circuit) is not int or request.shots_per_circuit < 1:
        raise ValueError("Acquisition shots per circuit must be a positive integer.")
    if type(request.transpiler_seed) is not int or request.transpiler_seed < 0:
        raise ValueError("Acquisition transpiler seed must be a non-negative integer.")
    if request.simulator_seed is not None and (
        type(request.simulator_seed) is not int or request.simulator_seed < 0
    ):
        raise ValueError("Acquisition simulator seed must be non-negative when set.")


def _required_text(value: str | None, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Acquisition evidence {label} must be a non-empty string.")
    return value


def _validate_sha256(value: str, label: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"Acquisition evidence {label} is not a lowercase SHA-256 digest.")


def _parse_utc(value: str | None, label: str) -> datetime:
    text = _required_text(value, label)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Acquisition evidence {label} is not an ISO timestamp.") from error
    offset = parsed.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise ValueError(f"Acquisition evidence {label} must identify a UTC instant.")
    return parsed


def _validate_failure(value: AcquisitionFailure, label: str) -> None:
    _required_text(value.provider_name, f"{label}.provider_name")
    _required_text(value.backend_name, f"{label}.backend_name")
    if type(value.moth_api) is not bool:
        raise ValueError(f"Acquisition evidence {label}.moth_api must be boolean.")
    _required_text(value.stage, f"{label}.stage")
    _required_text(value.reason, f"{label}.reason")
    _parse_utc(value.occurred_at_utc, f"{label}.occurred_at_utc")
    if value.job_id is not None:
        _required_text(value.job_id, f"{label}.job_id")


def _validate_hardware_target(value: HardwareTargetEvidence) -> None:
    if len(value.logical_to_physical) != NUM_QUBITS:
        raise ValueError("Hardware evidence must map all six logical qubits.")
    if (
        any(type(qubit) is not int or qubit < 0 for qubit in value.logical_to_physical)
        or len(set(value.logical_to_physical)) != NUM_QUBITS
    ):
        raise ValueError(
            "Hardware logical-to-physical layout must contain six distinct "
            "non-negative qubits."
        )
    _required_text(value.target_name, "hardware_target.target_name")
    _validate_sha256(
        value.target_snapshot_sha256,
        "hardware_target.target_snapshot_sha256",
    )
    _required_text(value.calibration_id, "hardware_target.calibration_id")
    _parse_utc(
        value.calibration_timestamp_utc,
        "hardware_target.calibration_timestamp_utc",
    )
    _validate_sha256(
        value.calibration_sha256,
        "hardware_target.calibration_sha256",
    )


def validate_acquisition_batch(
    request: AcquisitionRequest,
    batch: AcquisitionBatch,
) -> None:
    """Reject incomplete or internally inconsistent evidence before fitting."""

    validate_acquisition_request(request)
    evidence = batch.evidence
    if evidence.provider_mode not in ("local-aer", "batched-hardware"):
        raise ValueError(f"Unknown acquisition provider mode {evidence.provider_mode!r}.")
    _required_text(evidence.provider_name, "provider_name")
    _required_text(evidence.backend_name, "backend_name")
    _required_text(evidence.backend_class, "backend_class")
    if type(evidence.moth_api) is not bool:
        raise ValueError("Acquisition evidence moth_api must be boolean.")

    if evidence.status not in ("completed", "failed"):
        raise ValueError(f"Unknown acquisition status {evidence.status!r}.")
    if evidence.status == "failed":
        if evidence.failure is None:
            raise ValueError("Failed acquisition lacks failure provenance.")
        _validate_failure(evidence.failure, "failure")
        raise ValueError(
            f"Acquisition failed during {evidence.failure.stage}; refusing characterization."
        )
    if evidence.failure is not None:
        raise ValueError(
            "Completed acquisition must place prior failure evidence in fallback_from."
        )
    if batch.result is None:
        raise ValueError("Completed acquisition has no result object.")
    _required_text(evidence.job_id, "job_id")

    if evidence.shots_per_circuit != request.shots_per_circuit:
        raise ValueError("Acquisition evidence shot count does not match the request.")
    if evidence.circuit_count != len(request.logical_circuits):
        raise ValueError("Acquisition evidence circuit count does not match the request.")
    if evidence.total_shots != evidence.circuit_count * evidence.shots_per_circuit:
        raise ValueError("Acquisition evidence total shot count is inconsistent.")

    expected_logical_hashes = tuple(
        sha256_text(circuit_qasm(item)) for item in request.logical_circuits
    )
    if evidence.logical_circuit_sha256 != expected_logical_hashes:
        raise ValueError("Logical measurement circuit hashes do not match the request.")
    for index, digest in enumerate(evidence.logical_circuit_sha256):
        _validate_sha256(digest, f"logical_circuit_sha256[{index}]")

    transpilation = evidence.transpilation
    _required_text(transpilation.tool_name, "transpilation.tool_name")
    _required_text(transpilation.tool_version, "transpilation.tool_version")
    if type(transpilation.seed) is not int or transpilation.seed < 0:
        raise ValueError("Acquisition transpiler evidence needs a non-negative seed.")
    if transpilation.seed != request.transpiler_seed:
        raise ValueError("Acquisition transpiler seed does not match the request.")
    if not isinstance(transpilation.settings, dict):
        raise ValueError("Acquisition transpiler settings must be an object.")
    try:
        stable_json(transpilation.settings)
    except (TypeError, ValueError) as error:
        raise ValueError("Acquisition transpiler settings are not durable JSON.") from error
    if len(batch.isa_circuits) != evidence.circuit_count:
        raise ValueError("Acquisition ISA circuit count does not match the request.")
    expected_isa_hashes = tuple(
        sha256_text(circuit_qasm(item)) for item in batch.isa_circuits
    )
    if transpilation.isa_circuit_sha256 != expected_isa_hashes:
        raise ValueError("Transpiled ISA circuit hashes do not match the supplied circuits.")
    for index, digest in enumerate(transpilation.isa_circuit_sha256):
        _validate_sha256(digest, f"transpilation.isa_circuit_sha256[{index}]")

    if len(batch.count_records) != evidence.circuit_count:
        raise ValueError("Acquisition count-record total does not match the request.")
    for index, (record, logical_circuit) in enumerate(
        zip(batch.count_records, request.logical_circuits)
    ):
        if record.name != logical_circuit.name:
            raise ValueError(f"Count record {index} does not match its logical circuit.")
        if not record.counts:
            raise ValueError(f"Count record {index} is empty.")
        for bitstring, count in record.counts.items():
            if not isinstance(bitstring, str) or not bitstring:
                raise ValueError(f"Count record {index} has an invalid bitstring.")
            if type(count) is not int or count < 0:
                raise ValueError(f"Count record {index} has an invalid count.")
        if sum(record.counts.values()) != evidence.shots_per_circuit:
            raise ValueError(f"Count record {index} does not contain the declared shots.")
    _validate_sha256(evidence.raw_counts_sha256, "raw_counts_sha256")
    expected_raw_counts_hash = sha256_text(
        stable_json(count_records_payload(batch.count_records))
    )
    if evidence.raw_counts_sha256 != expected_raw_counts_hash:
        raise ValueError("Raw count digest does not match the supplied count records.")

    if evidence.fallback_from is not None:
        _validate_failure(evidence.fallback_from, "fallback_from")

    timestamps = (
        evidence.submitted_at_utc,
        evidence.completed_at_utc,
        evidence.retrieved_at_utc,
    )
    parsed_timestamps = [
        _parse_utc(value, label)
        for value, label in zip(
            timestamps,
            ("submitted_at_utc", "completed_at_utc", "retrieved_at_utc"),
        )
        if value is not None
    ]
    if len(parsed_timestamps) > 1 and parsed_timestamps != sorted(parsed_timestamps):
        raise ValueError("Acquisition timestamps are not in chronological order.")

    if evidence.provider_mode == "local-aer":
        if evidence.moth_api:
            raise ValueError("Local Aer evidence cannot claim Moth API acquisition.")
        if evidence.durable_provider_result:
            raise ValueError("Local Aer evidence cannot claim a durable provider result.")
        if evidence.hardware_target is not None:
            raise ValueError("Local Aer evidence cannot claim hardware target metadata.")
        if request.simulator_seed is None or evidence.simulator_seed != request.simulator_seed:
            raise ValueError("Local Aer evidence must preserve the requested simulator seed.")
        return

    if not evidence.durable_provider_result:
        raise ValueError("Hardware evidence must identify a durable provider result.")
    _required_text(evidence.result_id, "result_id")
    if evidence.simulator_seed is not None:
        raise ValueError("Hardware evidence cannot claim a simulator seed.")
    if any(value is None for value in timestamps):
        raise ValueError(
            "Hardware evidence requires submission, completion, and retrieval timestamps."
        )
    if evidence.hardware_target is None:
        raise ValueError("Hardware evidence lacks layout, target, and calibration metadata.")
    _validate_hardware_target(evidence.hardware_target)


def local_aer_fixture_execution(evidence: ExecutionEvidence) -> dict[str, Any]:
    """Serialize the local-Aer variant of the v1 acquisition union.

    Hardware evidence deliberately cannot be relabelled as Aer; the separate
    hardware serializer preserves its distinct provider provenance instead.
    """

    if evidence.provider_mode != "local-aer":
        raise ValueError("Fixture bank v1 cannot serialize hardware evidence as local Aer.")
    if evidence.status != "completed" or evidence.failure is not None:
        raise ValueError("Fixture bank v1 cannot serialize failed acquisition evidence.")
    if evidence.job_id is None or evidence.simulator_seed is None:
        raise ValueError("Validated local Aer evidence is incomplete.")
    return {
        "backendClass": evidence.backend_class,
        "backendName": evidence.backend_name,
        "providerMode": "local-aer",
        "providerName": evidence.provider_name,
        "mothApi": evidence.moth_api,
        "jobId": evidence.job_id,
        "shotsPerCircuit": evidence.shots_per_circuit,
        "simulatorSeed": evidence.simulator_seed,
        "transpilerSeed": evidence.transpilation.seed,
        "tomographyCircuitCount": evidence.circuit_count,
        "totalShots": evidence.total_shots,
        "logicalMeasurementCircuitSha256": list(evidence.logical_circuit_sha256),
        "transpiledAerCircuitSha256": list(
            evidence.transpilation.isa_circuit_sha256
        ),
        "rawCountsSha256": evidence.raw_counts_sha256,
        "durableProviderResult": False,
        "hardwareLayout": None,
        "backendCalibration": None,
        "fallbackFrom": (
            None
            if evidence.fallback_from is None
            else _failure_artifact(evidence.fallback_from)
        ),
    }


def _failure_artifact(value: AcquisitionFailure) -> dict[str, Any]:
    return {
        "providerName": value.provider_name,
        "backendName": value.backend_name,
        "mothApi": value.moth_api,
        "stage": value.stage,
        "occurredAtUtc": value.occurred_at_utc,
        "reason": value.reason,
        "jobId": value.job_id,
    }


def hardware_fixture_execution(evidence: ExecutionEvidence) -> dict[str, Any]:
    """Serialize validated provider-neutral hardware evidence without inference."""

    if evidence.provider_mode != "batched-hardware":
        raise ValueError("Hardware serialization requires batched-hardware evidence.")
    if evidence.status != "completed" or evidence.failure is not None:
        raise ValueError("Hardware serialization requires a completed acquisition.")
    if (
        evidence.job_id is None
        or evidence.result_id is None
        or evidence.submitted_at_utc is None
        or evidence.completed_at_utc is None
        or evidence.retrieved_at_utc is None
        or evidence.hardware_target is None
        or not evidence.durable_provider_result
    ):
        raise ValueError("Validated hardware evidence is incomplete.")
    target = evidence.hardware_target
    return {
        "backendClass": evidence.backend_class,
        "backendName": evidence.backend_name,
        "providerMode": "batched-hardware",
        "providerName": evidence.provider_name,
        "mothApi": evidence.moth_api,
        "jobId": evidence.job_id,
        "resultId": evidence.result_id,
        "submittedAtUtc": evidence.submitted_at_utc,
        "completedAtUtc": evidence.completed_at_utc,
        "retrievedAtUtc": evidence.retrieved_at_utc,
        "shotsPerCircuit": evidence.shots_per_circuit,
        "simulatorSeed": None,
        "tomographyCircuitCount": evidence.circuit_count,
        "totalShots": evidence.total_shots,
        "logicalMeasurementCircuitSha256": list(
            evidence.logical_circuit_sha256
        ),
        "transpilation": {
            "toolName": evidence.transpilation.tool_name,
            "toolVersion": evidence.transpilation.tool_version,
            "seed": evidence.transpilation.seed,
            "settings": evidence.transpilation.settings,
            "isaCircuitSha256": list(
                evidence.transpilation.isa_circuit_sha256
            ),
        },
        "rawCountsSha256": evidence.raw_counts_sha256,
        "durableProviderResult": True,
        "hardwareLayout": {
            "logicalToPhysical": list(target.logical_to_physical),
            "targetName": target.target_name,
            "targetSnapshotSha256": target.target_snapshot_sha256,
        },
        "backendCalibration": {
            "calibrationId": target.calibration_id,
            "timestampUtc": target.calibration_timestamp_utc,
            "sha256": target.calibration_sha256,
        },
        "fallbackFrom": (
            None
            if evidence.fallback_from is None
            else _failure_artifact(evidence.fallback_from)
        ),
    }


def fixture_execution(evidence: ExecutionEvidence) -> dict[str, Any]:
    if evidence.provider_mode == "local-aer":
        return local_aer_fixture_execution(evidence)
    return hardware_fixture_execution(evidence)


class LocalAerAcquisition:
    """Current offline adapter; it performs no fitting or interpretation."""

    provider_mode: Literal["local-aer"] = "local-aer"

    def acquire(self, request: AcquisitionRequest) -> AcquisitionBatch:
        validate_acquisition_request(request)
        if request.simulator_seed is None:
            raise ValueError("Local Aer acquisition requires a simulator seed.")
        backend = AerSimulator(seed_simulator=request.simulator_seed)
        transpiled_value = transpile(
            list(request.logical_circuits),
            backend,
            seed_transpiler=request.transpiler_seed,
        )
        isa_circuits = (
            (transpiled_value,)
            if isinstance(transpiled_value, QuantumCircuit)
            else tuple(transpiled_value)
        )
        job = backend.run(
            list(isa_circuits),
            shots=request.shots_per_circuit,
            seed_simulator=request.simulator_seed,
        )
        result = job.result()
        count_records = tuple(
            CircuitCounts(
                name=item.name,
                counts={
                    key: int(value)
                    for key, value in sorted(result.get_counts(item).items())
                },
            )
            for item in request.logical_circuits
        )
        logical_hashes = tuple(
            sha256_text(circuit_qasm(item)) for item in request.logical_circuits
        )
        isa_hashes = tuple(
            sha256_text(circuit_qasm(item)) for item in isa_circuits
        )
        evidence = ExecutionEvidence(
            provider_mode="local-aer",
            provider_name="qiskit-aer",
            backend_name=backend.name,
            backend_class=type(backend).__name__,
            moth_api=False,
            job_id=job.job_id(),
            result_id=None,
            submitted_at_utc=None,
            completed_at_utc=None,
            retrieved_at_utc=None,
            shots_per_circuit=request.shots_per_circuit,
            circuit_count=len(request.logical_circuits),
            total_shots=(
                len(request.logical_circuits) * request.shots_per_circuit
            ),
            simulator_seed=request.simulator_seed,
            logical_circuit_sha256=logical_hashes,
            transpilation=TranspilationEvidence(
                tool_name="qiskit.transpile",
                tool_version=metadata.version("qiskit"),
                seed=request.transpiler_seed,
                settings={"backendName": backend.name},
                isa_circuit_sha256=isa_hashes,
            ),
            raw_counts_sha256=sha256_text(
                stable_json(count_records_payload(count_records))
            ),
            durable_provider_result=False,
            hardware_target=None,
            status="completed",
            failure=None,
            fallback_from=None,
        )
        return AcquisitionBatch(
            result=result,
            isa_circuits=isa_circuits,
            count_records=count_records,
            evidence=evidence,
        )


def initial_circuit() -> QuantumCircuit:
    """Reviewed shallow preparation selected by exact-state calibration."""

    circuit = QuantumCircuit(NUM_QUBITS, name=MODEL_ID)
    angles = (0.31, 0.67, 1.03, 1.39, 0.83, 1.21)
    for qubit, angle in enumerate(angles):
        circuit.ry(angle, qubit)
        circuit.rz(0.17 * (qubit + 1), qubit)
    for lo, hi in ((0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 0)):
        circuit.cx(lo, hi)
    for qubit in range(NUM_QUBITS):
        circuit.rx(0.11 * (qubit + 1), qubit)
    return circuit


def append_branch_operation(
    circuit: QuantumCircuit,
    *,
    round_number: int,
    branch: str,
) -> dict[str, Any]:
    spotlight = SPOTLIGHTS[round_number]
    if spotlight.gate is None or spotlight.theta is None:
        raise ValueError("Round 4 has no child operation.")
    sign = 1 if branch == "MATCHED_ACTION" else -1
    angle = sign * spotlight.theta
    before_hash = circuit_identity(circuit)["sha256"]
    gate_method = getattr(circuit, spotlight.gate)
    gate_method(angle, *spotlight.pair)
    after_hash = circuit_identity(circuit)["sha256"]
    return {
        "operationId": f"round-{round_number}-{spotlight.gate}-{branch.lower()}",
        "sourceRound": round_number,
        "trigger": branch,
        "gate": spotlight.gate.upper(),
        "angleRadians": angle,
        "orderedPair": list(spotlight.pair),
        "requestedMeaning": None,
        "parentCircuitSha256": before_hash,
        "resultCircuitSha256": after_hash,
    }


def build_tree() -> list[NodeSpec]:
    root = NodeSpec(
        checkpoint_id="round-1-root",
        round_number=1,
        path="",
        parent_id=None,
        circuit=initial_circuit(),
        operation_history=[],
        children={},
    )
    all_nodes = [root]
    parents = [root]
    tags = (("MATCHED_ACTION", "M"), ("SPLIT_ACTION", "S"))
    for round_number in range(1, 4):
        children: list[NodeSpec] = []
        for parent in parents:
            for branch, tag in tags:
                child_circuit = parent.circuit.copy()
                operation = append_branch_operation(
                    child_circuit,
                    round_number=round_number,
                    branch=branch,
                )
                path = parent.path + tag
                checkpoint_id = f"round-{round_number + 1}-{path}"
                child = NodeSpec(
                    checkpoint_id=checkpoint_id,
                    round_number=round_number + 1,
                    path=path,
                    parent_id=parent.checkpoint_id,
                    circuit=child_circuit,
                    operation_history=[*parent.operation_history, operation],
                    children={},
                )
                parent.children[branch] = checkpoint_id
                children.append(child)
                all_nodes.append(child)
        parents = children
    return all_nodes


def pair_density_exact(circuit: QuantumCircuit, edge: tuple[int, int]) -> np.ndarray:
    state = Statevector.from_instruction(circuit)
    traced = [qubit for qubit in range(NUM_QUBITS) if qubit not in edge]
    return np.asarray(partial_trace(state, traced).data)


def pair_probabilities(rho: np.ndarray, basis: str) -> dict[str, float]:
    values: dict[str, float] = {}
    outcomes = (("pp", 1, 1), ("pm", 1, -1), ("mp", -1, 1), ("mm", -1, -1))
    for label, sign_lo, sign_hi in outcomes:
        projector_lo = (PAULIS["I"] + sign_lo * PAULIS[basis]) / 2
        projector_hi = (PAULIS["I"] + sign_hi * PAULIS[basis]) / 2
        probability = np.trace(rho @ np.kron(projector_hi, projector_lo))
        if abs(float(probability.imag)) > 1e-10:
            raise ValueError(f"Material imaginary probability residue: {probability!r}")
        real = float(probability.real)
        if -TOLERANCE <= real < 0:
            real = 0.0
        elif 1 < real <= 1 + TOLERANCE:
            real = 1.0
        if not 0 <= real <= 1:
            raise ValueError(f"Invalid probability {real} for {basis}/{label}.")
        values[label] = real
    total = sum(values.values())
    if abs(total - 1) > 1e-8:
        raise ValueError(f"Probability vector sums to {total}, not 1.")
    if total != 1:
        values = {label: value / total for label, value in values.items()}
    return values


def pauli_expectations(rho: np.ndarray) -> dict[str, float]:
    result: dict[str, float] = {}
    for lo_pauli in "IXYZ":
        for hi_pauli in "IXYZ":
            if lo_pauli == hi_pauli == "I":
                continue
            value = np.trace(
                rho @ np.kron(PAULIS[hi_pauli], PAULIS[lo_pauli])
            )
            result[lo_pauli + hi_pauli] = float(value.real)
    return result


def serialize_density(rho: np.ndarray) -> list[list[list[float]]]:
    return [
        [[float(value.real), float(value.imag)] for value in row]
        for row in rho
    ]


def product_of_marginals(probabilities: dict[str, float]) -> dict[str, float]:
    a_plus = probabilities["pp"] + probabilities["pm"]
    b_plus = probabilities["pp"] + probabilities["mp"]
    return {
        "pp": a_plus * b_plus,
        "pm": a_plus * (1 - b_plus),
        "mp": (1 - a_plus) * b_plus,
        "mm": (1 - a_plus) * (1 - b_plus),
    }


def total_variation(left: dict[str, float], right: dict[str, float]) -> float:
    return 0.5 * sum(abs(left[key] - right[key]) for key in ("pp", "pm", "mp", "mm"))


def pair_artifact(rho: np.ndarray, edge: tuple[int, int]) -> dict[str, Any]:
    distributions = {basis: pair_probabilities(rho, basis) for basis in "XYZ"}
    return {
        "canonicalEdge": list(edge),
        "matrixOrder": "hi-tensor-lo",
        "densityMatrix": serialize_density(rho),
        "pauliExpectations": pauli_expectations(rho),
        "distributions": distributions,
        "productMarginalsControl": {
            basis: product_of_marginals(distribution)
            for basis, distribution in distributions.items()
        },
    }


def explicit_tomography(
    circuit: QuantumCircuit,
    *,
    shots: int,
    seed: int,
    adapter: AcquisitionAdapter | None = None,
) -> tuple[dict[tuple[int, int], np.ndarray], dict[str, Any]]:
    """Run the pinned pairwise tomography while retaining execution evidence."""

    edge_list = [list(edge) for edge in EDGES]
    expectation_backend = ExpectationValue(NUM_QUBITS, k=2, coupling_map=edge_list)
    graph = QuantumGraph(
        NUM_QUBITS,
        coupling_map=edge_list,
        backend=expectation_backend,
    )
    graph.qc = circuit.copy()
    circuits = pairwise_state_tomography_circuits(
        graph.qc,
        graph.qc.qregs[0],
        pairs_list=graph.coupling_map,
    )
    acquirer = adapter or LocalAerAcquisition()
    request = AcquisitionRequest(
        logical_circuits=tuple(circuits),
        shots_per_circuit=shots,
        simulator_seed=seed if acquirer.provider_mode == "local-aer" else None,
        transpiler_seed=seed,
    )
    batch = acquirer.acquire(request)
    validate_acquisition_batch(request, batch)
    fitter = PairwiseStateTomographyFitter(
        batch.result,
        circuits,
        graph.qc.qregs[0],
    )
    matrices = fitter.fit(
        method="lstsq",
        output="density_matrix",
        pairs_list=list(EDGES),
    )
    return matrices, fixture_execution(batch.evidence)


def characterize_node(
    node: NodeSpec,
    *,
    shots: int,
    seed: int,
    adapter: AcquisitionAdapter | None = None,
) -> dict[str, Any]:
    exact_pairs = {
        edge: pair_artifact(pair_density_exact(node.circuit, edge), edge)
        for edge in EDGES
    }
    finite_matrices, execution = explicit_tomography(
        node.circuit,
        shots=shots,
        seed=seed,
        adapter=adapter,
    )
    finite_pairs = {
        edge: pair_artifact(np.asarray(finite_matrices[edge]), edge)
        for edge in EDGES
    }
    max_fit_tv = max(
        total_variation(
            finite_pairs[edge]["distributions"][basis],
            exact_pairs[edge]["distributions"][basis],
        )
        for edge in EDGES
        for basis in "XYZ"
    )
    spotlight = SPOTLIGHTS[node.round_number]
    return {
        "checkpointId": node.checkpoint_id,
        "round": node.round_number,
        "path": node.path,
        "parentId": node.parent_id,
        "children": node.children,
        "spotlight": {
            "orderedPair": list(spotlight.pair),
            "context": spotlight.context,
            "windowOpensAtSeconds": 24,
            "fallbackDeadlineSeconds": 36,
        },
        "circuit": circuit_identity(node.circuit),
        "operationHistory": node.operation_history,
        "acquisition": execution,
        "derivation": {
            "method": "lstsq-psd",
            "matrixOrder": "hi-tensor-lo",
            "probabilityProjectors": "Pi_hi tensor Pi_lo",
            "maxFiniteVsExactTotalVariation": max_fit_tv,
        },
        "pairs": {
            f"{edge[0]}-{edge[1]}": finite_pairs[edge]
            for edge in EDGES
        },
        "exactStateDiagnostic": {
            "acquisitionSource": "exact-statevector",
            "pairs": {
                f"{edge[0]}-{edge[1]}": {
                    "distributions": exact_pairs[edge]["distributions"],
                    "pauliExpectations": exact_pairs[edge]["pauliExpectations"],
                }
                for edge in EDGES
            },
        },
    }


def operation_diagnostics(
    checkpoints: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Measure every child operation against the checkpoint it actually extends."""

    diagnostics: list[dict[str, Any]] = []
    for child in checkpoints.values():
        parent_id = child["parentId"]
        if parent_id is None:
            continue
        parent = checkpoints[parent_id]
        operation = child["operationHistory"][-1]
        edge = tuple(parent["spotlight"]["orderedPair"])
        basis = parent["spotlight"]["context"]
        edge_key = f"{edge[0]}-{edge[1]}"
        if tuple(operation["orderedPair"]) != edge:
            raise ValueError(
                f"Operation {operation['operationId']} does not target its "
                f"parent spotlight edge {edge_key}."
            )
        exact_parent = parent["exactStateDiagnostic"]["pairs"]
        exact_child = child["exactStateDiagnostic"]["pairs"]
        target_by_basis = {
            candidate: total_variation(
                exact_parent[edge_key]["distributions"][candidate],
                exact_child[edge_key]["distributions"][candidate],
            )
            for candidate in "XYZ"
        }
        overlapping_by_edge_basis = {
            (key, candidate): total_variation(
                exact_parent[key]["distributions"][candidate],
                exact_child[key]["distributions"][candidate],
            )
            for key in exact_parent
            for candidate in "XYZ"
            if key != edge_key and set(map(int, key.split("-"))) & set(edge)
        }
        max_overlapping_edge_basis = max(
            overlapping_by_edge_basis,
            key=overlapping_by_edge_basis.__getitem__,
        )
        finite_active_tv = total_variation(
            parent["pairs"][edge_key]["distributions"][basis],
            child["pairs"][edge_key]["distributions"][basis],
        )
        diagnostics.append(
            {
                "operationOccurrenceId": (
                    f"{parent['checkpointId']}->{child['checkpointId']}"
                ),
                "operationId": operation["operationId"],
                "parentId": parent["checkpointId"],
                "childId": child["checkpointId"],
                "trigger": operation["trigger"],
                "gate": operation["gate"],
                "angleRadians": operation["angleRadians"],
                "spotlightEdge": list(edge),
                "spotlightContext": basis,
                "exactActiveContextTotalVariation": target_by_basis[basis],
                "exactMaxTargetTotalVariation": max(target_by_basis.values()),
                "exactMaxTargetContext": max(
                    target_by_basis,
                    key=target_by_basis.__getitem__,
                ),
                "exactMaxOverlappingTotalVariation": (
                    overlapping_by_edge_basis[max_overlapping_edge_basis]
                ),
                "exactMaxOverlappingEdge": list(
                    map(int, max_overlapping_edge_basis[0].split("-"))
                ),
                "exactMaxOverlappingContext": max_overlapping_edge_basis[1],
                "finiteShotActiveContextTotalVariation": finite_active_tv,
            }
        )
    return diagnostics


def repeat_noise_diagnostic(
    checkpoint_id: str,
    circuit: QuantumCircuit,
    *,
    spotlight_edge: tuple[int, int],
    spotlight_context: str,
    shots: int,
    seeds: tuple[int, ...],
    adapter: AcquisitionAdapter | None = None,
) -> dict[str, Any]:
    if len(seeds) < 3:
        raise ValueError("Repeat-noise characterization requires at least three runs.")
    if len(set(seeds)) != len(seeds):
        raise ValueError("Repeat-noise characterization seeds must be unique.")
    repeats: list[dict[tuple[int, int], dict[str, Any]]] = []
    executions: list[dict[str, Any]] = []
    for repeat_seed in seeds:
        matrices, execution = explicit_tomography(
            circuit,
            shots=shots,
            seed=repeat_seed,
            adapter=adapter,
        )
        repeats.append(
            {
                edge: pair_artifact(np.asarray(matrices[edge]), edge)
                for edge in EDGES
            }
        )
        executions.append(
            {
                "acquisition": execution,
            }
        )
    comparisons: list[float] = []
    active_comparisons: list[float] = []
    for left_index in range(len(repeats) - 1):
        for right_index in range(left_index + 1, len(repeats)):
            comparisons.extend(
                total_variation(
                    repeats[left_index][edge]["distributions"][candidate],
                    repeats[right_index][edge]["distributions"][candidate],
                )
                for edge in EDGES
                for candidate in "XYZ"
            )
            active_comparisons.append(
                total_variation(
                    repeats[left_index][spotlight_edge]["distributions"][
                        spotlight_context
                    ],
                    repeats[right_index][spotlight_edge]["distributions"][
                        spotlight_context
                    ],
                )
            )
    return {
        "checkpointId": checkpoint_id,
        "spotlightEdge": list(spotlight_edge),
        "spotlightContext": spotlight_context,
        "shotsPerCircuit": shots,
        "repeatCount": len(seeds),
        "pairwiseRepeatComparisons": len(seeds) * (len(seeds) - 1) // 2,
        "additionalCircuitExecutions": (
            len(seeds) * TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT
        ),
        "additionalShots": (
            len(seeds) * TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT * shots
        ),
        "maxActiveContextTotalVariation": max(active_comparisons),
        "maxPairContextTotalVariation": max(comparisons),
        "meanPairContextTotalVariation": float(np.mean(comparisons)),
        "executions": executions,
    }


def package_versions() -> dict[str, str]:
    return {
        name: metadata.version(name)
        for name in (
            "quantumgraph",
            "pairwise-tomography",
            "qiskit",
            "qiskit-aer",
            "numpy",
            "scipy",
        )
    }


def validate_tree(nodes: Iterable[NodeSpec]) -> None:
    node_list = list(nodes)
    if len(node_list) != 15:
        raise ValueError(f"Expected 15 checkpoints, found {len(node_list)}.")
    ids = {node.checkpoint_id for node in node_list}
    if len(ids) != len(node_list):
        raise ValueError("Checkpoint IDs are not unique.")
    counts = {round_number: 0 for round_number in range(1, 5)}
    for node in node_list:
        counts[node.round_number] += 1
        if node.round_number < 4:
            if set(node.children) != {"MATCHED_ACTION", "SPLIT_ACTION"}:
                raise ValueError(f"{node.checkpoint_id} lacks two branch children.")
            if len(set(node.children.values())) != 2:
                raise ValueError(f"{node.checkpoint_id} reuses a branch child.")
            if not set(node.children.values()) <= ids:
                raise ValueError(f"{node.checkpoint_id} points outside the tree.")
        elif node.children:
            raise ValueError(f"Leaf {node.checkpoint_id} has children.")
    if counts != {1: 1, 2: 2, 3: 4, 4: 8}:
        raise ValueError(f"Unexpected level counts: {counts!r}")


def compiled_acquisition_summary(
    acquisition_records: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    records = list(acquisition_records)
    if not records:
        raise ValueError("Fixture compilation has no acquisition records.")
    acquisition_modes = {record.get("providerMode") for record in records}
    if len(acquisition_modes) != 1:
        raise ValueError(
            "Fixture compilation mixed acquisition modes across checkpoints "
            "or calibration repeats."
        )
    acquisition_mode = acquisition_modes.pop()
    if acquisition_mode == "local-aer":
        if any(record.get("mothApi") is not False for record in records):
            raise ValueError("Local Aer records cannot claim Moth API acquisition.")
        return {
            "acquisitionSource": "finite-shot-aer",
            "fixtureBankId": "quantum-royale-aer-k6-v1",
            "qpu": False,
            "remoteService": False,
            "mothApi": False,
            "calibrationStatus": "accepted-for-local-prototype",
        }
    if acquisition_mode == "batched-hardware":
        providers = {
            (
                record.get("providerName"),
                record.get("backendName"),
                record.get("mothApi"),
            )
            for record in records
        }
        if len(providers) != 1:
            raise ValueError(
                "Hardware fixture compilation requires one consistent named "
                "provider, backend, and Moth API disclosure."
            )
        provider_name, backend_name, moth_api = providers.pop()
        if (
            not isinstance(provider_name, str)
            or not provider_name
            or not isinstance(backend_name, str)
            or not backend_name
            or type(moth_api) is not bool
        ):
            raise ValueError(
                "Hardware fixture compilation lacks a named provider/backend "
                "or explicit Moth API disclosure."
            )
        return {
            "acquisitionSource": "finite-shot-hardware",
            "fixtureBankId": "quantum-royale-hardware-k6-v1",
            "qpu": True,
            "remoteService": True,
            "mothApi": moth_api,
            "calibrationStatus": "accepted-for-hardware-prototype",
        }
    raise ValueError(f"Unknown compiled acquisition mode {acquisition_mode!r}.")


def compile_bank(
    *,
    shots: int,
    seed: int,
    adapter: AcquisitionAdapter | None = None,
) -> tuple[dict[str, Any], str]:
    source_revisions = verify_pinned_source_revisions()
    nodes = build_tree()
    validate_tree(nodes)
    circuit_count = TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT
    estimate = {
        "checkpointCount": len(nodes),
        "tomographyCircuitsPerCheckpoint": circuit_count,
        "totalCircuitExecutions": len(nodes) * circuit_count,
        "shotsPerCircuit": shots,
        "totalShots": len(nodes) * circuit_count * shots,
    }
    print("Compilation estimate:", stable_json(estimate), flush=True)

    checkpoints: dict[str, dict[str, Any]] = {}
    for index, node in enumerate(nodes):
        node_seed = seed + index * 997
        print(
            f"[{index + 1:02d}/{len(nodes)}] {node.checkpoint_id} "
            f"({circuit_count * shots:,} shots)",
            flush=True,
        )
        checkpoints[node.checkpoint_id] = characterize_node(
            node,
            shots=shots,
            seed=node_seed,
            adapter=adapter,
        )

    diagnostics = operation_diagnostics(checkpoints)
    for diagnostic in diagnostics:
        if (
            diagnostic["exactActiveContextTotalVariation"]
            < EXACT_ACTIVE_CONTEXT_TV_THRESHOLD
        ):
            raise ValueError(
                f"Operation {diagnostic['operationOccurrenceId']} fell below "
                "the declared exact active-context legibility threshold."
            )
        if (
            diagnostic["exactMaxTargetTotalVariation"]
            < EXACT_ACTIVE_CONTEXT_TV_THRESHOLD
        ):
            raise ValueError(
                f"Operation {diagnostic['operationOccurrenceId']} fell below "
                "the declared exact target legibility threshold."
            )
        if (
            diagnostic["exactMaxOverlappingTotalVariation"]
            < EXACT_OVERLAPPING_EDGE_TV_THRESHOLD
        ):
            raise ValueError(
                f"Operation {diagnostic['operationOccurrenceId']} lacks the "
                "required exact overlapping-edge consequence."
            )

    parent_nodes = [node for node in nodes if node.children]
    print(
        "Running three repeat-noise characterizations for each of "
        f"{len(parent_nodes)} parent checkpoints.",
        flush=True,
    )
    repeat_diagnostics: list[dict[str, Any]] = []
    for parent_index, parent_node in enumerate(parent_nodes):
        repeat_seed_base = seed + REPEAT_SEED_OFFSET + parent_index * 10_000
        repeat_seeds = tuple(
            repeat_seed_base + repeat_index * 997
            for repeat_index in range(REPEAT_COUNT_PER_PARENT)
        )
        spotlight = SPOTLIGHTS[parent_node.round_number]
        repeat_diagnostics.append(
            repeat_noise_diagnostic(
                parent_node.checkpoint_id,
                parent_node.circuit,
                spotlight_edge=spotlight.pair,
                spotlight_context=spotlight.context,
                shots=shots,
                seeds=repeat_seeds,
                adapter=adapter,
            )
        )

    acquisition_records = [
        checkpoint["acquisition"] for checkpoint in checkpoints.values()
    ] + [
        execution["acquisition"]
        for diagnostic in repeat_diagnostics
        for execution in diagnostic["executions"]
    ]
    acquisition_summary = compiled_acquisition_summary(acquisition_records)

    repeat_by_parent = {
        item["checkpointId"]: item for item in repeat_diagnostics
    }
    for diagnostic in diagnostics:
        parent_noise = repeat_by_parent[diagnostic["parentId"]]
        max_parent_noise = parent_noise["maxPairContextTotalVariation"]
        if max_parent_noise <= 0:
            raise ValueError(
                f"Parent repeat envelope {diagnostic['parentId']} is zero; "
                "the finite-shot ratio is undefined."
            )
        diagnostic["parentRepeatMaxPairContextTotalVariation"] = max_parent_noise
        diagnostic["finiteToParentRepeatMaxRatio"] = (
            diagnostic["finiteShotActiveContextTotalVariation"] / max_parent_noise
        )
        if (
            diagnostic["finiteShotActiveContextTotalVariation"]
            <= FINITE_TO_PARENT_NOISE_MULTIPLIER * max_parent_noise
        ):
            raise ValueError(
                f"Operation {diagnostic['operationOccurrenceId']} finite-shot "
                "active-context change does not exceed three times its own "
                "parent checkpoint's repeat envelope."
            )

    additional_circuits = sum(
        item["additionalCircuitExecutions"] for item in repeat_diagnostics
    )
    additional_shots = sum(
        item["additionalShots"] for item in repeat_diagnostics
    )
    weakest_operation_ratio = min(
        item["finiteToParentRepeatMaxRatio"] for item in diagnostics
    )

    compiled_at = utc_now()
    bank = {
        "schemaVersion": SCHEMA_VERSION,
        "fixtureBankId": acquisition_summary["fixtureBankId"],
        "compiledAt": compiled_at,
        "deliveryMode": "committed-fixture",
        "acquisitionSource": acquisition_summary["acquisitionSource"],
        "derivationMethod": "lstsq-psd",
        "model": {
            "modelId": MODEL_ID,
            "numQubits": NUM_QUBITS,
            "qubitMap": [
                {"qubit": index, "chickenId": chicken_id, "displayName": name}
                for index, (chicken_id, name) in enumerate(CHICKENS)
            ],
            "configuredEdges": [list(edge) for edge in EDGES],
            "topologyKind": "complete-k6-gameplay-relationship-graph",
            "initialCircuit": circuit_identity(initial_circuit()),
        },
        "provenance": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "packageVersions": package_versions(),
            "quantumGraphCommit": source_revisions["quantumgraph"]["commit"],
            "pairwiseTomographyCommit": source_revisions[
                "pairwise-tomography"
            ]["commit"],
            "sourceRelationship": (
                "Installed distributions record the pinned public Git revisions "
                "in direct_url.json; installed file contents were not independently hashed."
            ),
            "qpu": acquisition_summary["qpu"],
            "remoteService": acquisition_summary["remoteService"],
            "mothApi": acquisition_summary["mothApi"],
        },
        "costEstimate": estimate,
        "branchRule": {
            "MATCHED_ACTION": ["pp", "mm"],
            "SPLIT_ACTION": ["pm", "mp"],
        },
        "checkpoints": checkpoints,
        "calibration": {
            "status": acquisition_summary["calibrationStatus"],
            "exactActiveContextTvThreshold": EXACT_ACTIVE_CONTEXT_TV_THRESHOLD,
            "exactOverlappingEdgeTvThreshold": (
                EXACT_OVERLAPPING_EDGE_TV_THRESHOLD
            ),
            "finiteToParentNoiseMultiplier": (
                FINITE_TO_PARENT_NOISE_MULTIPLIER
            ),
            "operationDiagnostics": diagnostics,
            "finiteShotRepeatDiagnostics": repeat_diagnostics,
            "repeatDesign": {
                "parentCheckpointCount": len(parent_nodes),
                "repeatsPerParent": REPEAT_COUNT_PER_PARENT,
                "pairwiseComparisonsPerParent": (
                    REPEAT_COUNT_PER_PARENT * (REPEAT_COUNT_PER_PARENT - 1) // 2
                ),
                "tomographyCircuitsPerRepeat": circuit_count,
                "additionalCircuitExecutions": additional_circuits,
                "additionalShots": additional_shots,
                "totalCircuitExecutionsIncludingCalibration": (
                    estimate["totalCircuitExecutions"] + additional_circuits
                ),
                "totalShotsIncludingCalibration": (
                    estimate["totalShots"] + additional_shots
                ),
            },
            "weakestOperationToParentNoiseRatio": weakest_operation_ratio,
            "claimBoundary": (
                "Operations are identified by gates and measured changes. "
                "They are not labelled as strengthening or breaking relationships."
            ),
        },
    }
    report = render_report(bank)
    return bank, report


def render_report(bank: dict[str, Any]) -> str:
    estimate = bank["costEstimate"]
    calibration = bank["calibration"]
    repeat_design = calibration["repeatDesign"]
    root_acquisition = bank["checkpoints"]["round-1-root"]["acquisition"]
    if root_acquisition["providerMode"] == "local-aer":
        evidence_status = "LOCAL FINITE-SHOT AER EVIDENCE — not a QPU result."
        repeat_description = (
            "Three deterministic simulator/transpiler-seed repeats provide "
            "three pairwise repeat comparisons per relevant parent checkpoint."
        )
        acquisition_boundary = (
            "- The simulator does not establish entanglement, quantum advantage, "
            "hardware feasibility, latency, or cost."
        )
    else:
        evidence_status = (
            "BATCHED HARDWARE EVIDENCE — "
            f"{root_acquisition['providerName']} / "
            f"{root_acquisition['backendName']}; delivered offline."
        )
        acquisition_boundary = (
            "- A hardware execution does not by itself establish entanglement, "
            "quantum advantage, speedup, or game utility."
        )
        repeat_description = (
            "Three separately acquired hardware repeats provide three pairwise "
            "repeat comparisons per relevant parent checkpoint; the transpiler "
            "seed does not seed hardware measurement outcomes."
        )
    operation_rows = []
    for item in calibration["operationDiagnostics"]:
        operation_rows.append(
            "| {parentId} | {childId} | {trigger} | {gate} "
            "{angleRadians:+.3f} | {spotlightContext} | "
            "{exactActiveContextTotalVariation:.3f} | "
            "{exactMaxTargetTotalVariation:.3f} | "
            "{exactMaxOverlappingTotalVariation:.3f} | "
            "{finiteShotActiveContextTotalVariation:.3f} | "
            "{parentRepeatMaxPairContextTotalVariation:.3f} | "
            "{finiteToParentRepeatMaxRatio:.2f} |".format(**item)
        )
    repeat_rows = []
    for item in calibration["finiteShotRepeatDiagnostics"]:
        repeat_rows.append(
            "| {checkpointId} | {spotlightContext} | {repeatCount} | "
            "{pairwiseRepeatComparisons} | "
            "{maxActiveContextTotalVariation:.3f} | "
            "{maxPairContextTotalVariation:.3f} | "
            "{meanPairContextTotalVariation:.3f} |".format(**item)
        )
    return "\n".join(
        [
            "# Quantum Royale fixture compilation report",
            "",
            f"**Compiled:** {bank['compiledAt']}",
            f"**Status:** {evidence_status}",
            "",
            "## Cost",
            "",
            f"- Checkpoints: {estimate['checkpointCount']}",
            f"- Tomography circuits per checkpoint: {estimate['tomographyCircuitsPerCheckpoint']}",
            f"- Total circuit executions: {estimate['totalCircuitExecutions']}",
            f"- Shots per circuit: {estimate['shotsPerCircuit']}",
            f"- Total simulated shots: {estimate['totalShots']}",
            "- Parent checkpoints characterized for repeat noise: "
            f"{repeat_design['parentCheckpointCount']}",
            "- Additional repeats per parent: "
            f"{repeat_design['repeatsPerParent']}",
            "- Additional repeat-calibration circuits: "
            f"{repeat_design['additionalCircuitExecutions']}",
            "- Additional repeat-calibration shots: "
            f"{repeat_design['additionalShots']}",
            "- Total circuit executions including calibration: "
            f"{repeat_design['totalCircuitExecutionsIncludingCalibration']}",
            "- Total shots including calibration: "
            f"{repeat_design['totalShotsIncludingCalibration']}",
            "",
            "## Operation-level pre/post calibration",
            "",
            "| Parent | Child | Trigger | operation | context | exact active TV | exact target max TV | exact overlap max TV | finite active TV | parent repeat max TV | ratio |",
            "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
            *operation_rows,
            "",
            "The total-variation thresholds are prototype legibility gates, not scientific standards. "
            "Every row compares one child checkpoint with its actual parent before and after the named operation; it is not a sibling comparison. "
            "Each finite-shot checkpoint was reconstructed with the pinned pairwise `lstsq` PSD fitter. The browser samples from those stored distributions classically.",
            "",
            "## Parent-specific finite-shot repeat envelopes",
            "",
            "| Parent | context | repeats | pairwise comparisons | active-context max TV | all-pair/context max TV | all-pair/context mean TV |",
            "|---|---:|---:|---:|---:|---:|---:|",
            *repeat_rows,
            "",
            f"{repeat_description} This is a bounded empirical envelope, not a confidence interval or hardware-noise model.",
            "",
            "Acceptance rules:",
            "",
            f"- Every exact child-versus-parent active-context TV must be at least {calibration['exactActiveContextTvThreshold']:.2f}.",
            f"- Every exact child-versus-parent maximum overlapping-edge TV must be at least {calibration['exactOverlappingEdgeTvThreshold']:.2f}.",
            f"- Every finite-shot child-versus-parent active-context TV must exceed {calibration['finiteToParentNoiseMultiplier']:.0f} times that parent's maximum observed repeat TV across all pairs and contexts.",
            "- Observed weakest operation/own-parent-repeat ratio: "
            f"{calibration['weakestOperationToParentNoiseRatio']:.2f}",
            "",
            "## Installed dependency VCS metadata",
            "",
            f"- QuantumGraph: `{bank['provenance']['quantumGraphCommit']}`",
            "- pairwise-tomography: "
            f"`{bank['provenance']['pairwiseTomographyCommit']}`",
            "- Compilation fails before artifact emission unless each installed distribution's `direct_url.json` records the pinned Git URL, commit ID, and requested revision.",
            "- This metadata check does not independently hash or attest every installed package file.",
            "",
            "## Boundaries",
            "",
            "- The complete K6 graph is a logical gameplay relationship graph, not a hardware layout.",
            "- Pairwise tomography does not reconstruct a complete six-qubit state.",
            acquisition_boundary,
            "- Runtime branch selection loads a committed child checkpoint and performs no quantum computation.",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", type=int, default=DEFAULT_SHOTS)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("fixtures/quantum-royale-aer-v1.json"),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("fixtures/compilation-report.md"),
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.shots < 128 or args.shots > 16384:
        raise SystemExit("--shots must be between 128 and 16384.")
    parent_checkpoint_count = 7
    repeat_circuits = (
        parent_checkpoint_count
        * REPEAT_COUNT_PER_PARENT
        * TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT
    )
    estimate = {
        "checkpointCount": 15,
        "tomographyCircuitsPerCheckpoint": TOMOGRAPHY_CIRCUITS_PER_CHECKPOINT,
        "primaryCircuitExecutions": 225,
        "shotsPerCircuit": args.shots,
        "primaryShots": 225 * args.shots,
        "repeatParentCheckpointCount": parent_checkpoint_count,
        "repeatCountPerParent": REPEAT_COUNT_PER_PARENT,
        "repeatCalibrationCircuitExecutions": repeat_circuits,
        "repeatCalibrationShots": repeat_circuits * args.shots,
        "totalCircuitExecutionsIncludingCalibration": 225 + repeat_circuits,
        "totalShotsIncludingCalibration": (225 + repeat_circuits) * args.shots,
    }
    if args.dry_run:
        verify_pinned_source_revisions()
        print(json.dumps(estimate, indent=2))
        return
    random.seed(args.seed)
    np.random.seed(args.seed)
    bank, report = compile_bank(shots=args.shots, seed=args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(bank, indent=2) + "\n", encoding="utf-8")
    args.report.write_text(report, encoding="utf-8")
    print(f"Wrote {args.output}")
    print(f"Wrote {args.report}")


if __name__ == "__main__":
    main()
