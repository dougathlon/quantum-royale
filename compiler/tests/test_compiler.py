from __future__ import annotations

from dataclasses import replace
import json
import math
import unittest
from unittest.mock import patch

import numpy as np
from qiskit import QuantumCircuit

from compiler.compile_fixtures import (
    AcquisitionFailure,
    AcquisitionRequest,
    EDGES,
    HardwareTargetEvidence,
    LocalAerAcquisition,
    PAIRWISE_TOMOGRAPHY_COMMIT,
    PAIRWISE_TOMOGRAPHY_URL,
    QUANTUMGRAPH_COMMIT,
    QUANTUMGRAPH_URL,
    SPOTLIGHTS,
    append_branch_operation,
    build_tree,
    compiled_acquisition_summary,
    explicit_tomography,
    fixture_execution,
    initial_circuit,
    local_aer_fixture_execution,
    pair_density_exact,
    pair_probabilities,
    product_of_marginals,
    repeat_noise_diagnostic,
    total_variation,
    validate_acquisition_batch,
    validate_tree,
    verify_pinned_source_revisions,
)


class CompilerMathTests(unittest.TestCase):
    def test_complete_k6_has_fifteen_edges(self) -> None:
        self.assertEqual(len(EDGES), 15)
        self.assertEqual(EDGES[0], (0, 1))
        self.assertEqual(EDGES[-1], (4, 5))

    def test_projectors_preserve_hi_tensor_lo_order(self) -> None:
        circuit = QuantumCircuit(6)
        circuit.x(0)
        rho = pair_density_exact(circuit, (0, 1))
        self.assertEqual(
            pair_probabilities(rho, "Z"),
            {"pp": 0.0, "pm": 0.0, "mp": 1.0, "mm": 0.0},
        )

    def test_asymmetric_pair_reversal_is_visible(self) -> None:
        circuit = QuantumCircuit(6)
        circuit.x(1)
        rho = pair_density_exact(circuit, (0, 1))
        self.assertEqual(
            pair_probabilities(rho, "Z"),
            {"pp": 0.0, "pm": 1.0, "mp": 0.0, "mm": 0.0},
        )

    def test_product_control_preserves_marginals_and_removes_covariance(self) -> None:
        source = {"pp": 0.52, "pm": 0.08, "mp": 0.12, "mm": 0.28}
        control = product_of_marginals(source)
        self.assertAlmostEqual(control["pp"] + control["pm"], 0.60)
        self.assertAlmostEqual(control["pp"] + control["mp"], 0.64)
        self.assertAlmostEqual(sum(control.values()), 1.0)
        self.assertAlmostEqual(
            control["pp"] * control["mm"] - control["pm"] * control["mp"],
            0.0,
        )


class BranchTreeTests(unittest.TestCase):
    def test_tree_is_full_and_accumulates_history(self) -> None:
        nodes = build_tree()
        validate_tree(nodes)
        levels = {
            round_number: [node for node in nodes if node.round_number == round_number]
            for round_number in range(1, 5)
        }
        self.assertEqual([len(levels[i]) for i in range(1, 5)], [1, 2, 4, 8])
        for node in nodes:
            self.assertEqual(len(node.operation_history), node.round_number - 1)
            if node.parent_id is not None:
                last = node.operation_history[-1]
                self.assertNotEqual(
                    last["parentCircuitSha256"], last["resultCircuitSha256"]
                )

    def test_each_explicit_operation_changes_its_parent_and_overlap(self) -> None:
        nodes = build_tree()
        nodes_by_id = {node.checkpoint_id: node for node in nodes}
        for child in nodes:
            if child.parent_id is None:
                continue
            parent = nodes_by_id[child.parent_id]
            spotlight = SPOTLIGHTS[parent.round_number]
            parent_active = pair_probabilities(
                pair_density_exact(parent.circuit, spotlight.pair),
                spotlight.context,
            )
            child_active = pair_probabilities(
                pair_density_exact(child.circuit, spotlight.pair),
                spotlight.context,
            )
            active_tv = total_variation(parent_active, child_active)
            overlap_tv = max(
                total_variation(
                    pair_probabilities(pair_density_exact(parent.circuit, edge), basis),
                    pair_probabilities(pair_density_exact(child.circuit, edge), basis),
                )
                for edge in EDGES
                for basis in "XYZ"
                if edge != spotlight.pair and set(edge) & set(spotlight.pair)
            )
            with self.subTest(child=child.checkpoint_id):
                self.assertGreaterEqual(active_tv, 0.15)
                self.assertGreaterEqual(overlap_tv, 0.05)

    def test_branch_angles_match_the_reviewed_recipe(self) -> None:
        expected_magnitudes = {1: math.pi, 2: math.pi / 2, 3: math.pi / 2}
        for round_number, expected_magnitude in expected_magnitudes.items():
            for branch, sign in (("MATCHED_ACTION", 1), ("SPLIT_ACTION", -1)):
                circuit = initial_circuit()
                operation = append_branch_operation(
                    circuit,
                    round_number=round_number,
                    branch=branch,
                )
                with self.subTest(round=round_number, branch=branch):
                    self.assertAlmostEqual(
                        operation["angleRadians"],
                        sign * expected_magnitude,
                    )


class CalibrationTests(unittest.TestCase):
    def test_repeat_diagnostic_is_parent_scoped_and_costed(self) -> None:
        matrices = []
        for angle in (0.0, 0.03, -0.02):
            circuit = initial_circuit()
            circuit.ry(angle, 0)
            matrices.append(
                {edge: pair_density_exact(circuit, edge) for edge in EDGES}
            )
        call_index = 0

        def fake_tomography(circuit, *, shots, seed, adapter=None):
            nonlocal call_index
            current = call_index
            call_index += 1
            return matrices[current], {
                "rawCountsSha256": f"{current + 1:064x}",
                "jobId": f"job-{current + 1}",
            }

        with patch(
            "compiler.compile_fixtures.explicit_tomography",
            side_effect=fake_tomography,
        ):
            diagnostic = repeat_noise_diagnostic(
                "round-2-M",
                initial_circuit(),
                spotlight_edge=(2, 3),
                spotlight_context="Y",
                shots=128,
                seeds=(110, 111, 112),
            )
        self.assertEqual(diagnostic["checkpointId"], "round-2-M")
        self.assertEqual(diagnostic["repeatCount"], 3)
        self.assertEqual(diagnostic["pairwiseRepeatComparisons"], 3)
        self.assertEqual(diagnostic["additionalCircuitExecutions"], 45)
        self.assertEqual(diagnostic["additionalShots"], 5_760)
        self.assertGreaterEqual(
            diagnostic["maxPairContextTotalVariation"],
            diagnostic["maxActiveContextTotalVariation"],
        )

    def test_repeat_diagnostic_rejects_underpowered_or_duplicate_designs(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least three"):
            repeat_noise_diagnostic(
                "round-1-root",
                initial_circuit(),
                spotlight_edge=(0, 1),
                spotlight_context="X",
                shots=128,
                seeds=(1, 2),
            )
        with self.assertRaisesRegex(ValueError, "unique"):
            repeat_noise_diagnostic(
                "round-1-root",
                initial_circuit(),
                spotlight_edge=(0, 1),
                spotlight_context="X",
                shots=128,
                seeds=(1, 1, 2),
            )


class SourceRevisionTests(unittest.TestCase):
    @staticmethod
    def direct_url(url: str, commit: str, requested: str | None = None) -> str:
        return json.dumps(
            {
                "url": url,
                "vcs_info": {
                    "vcs": "git",
                    "commit_id": commit,
                    "requested_revision": requested or commit,
                },
            }
        )

    def test_installed_direct_urls_must_match_both_pins(self) -> None:
        payloads = {
            "quantumgraph": self.direct_url(
                QUANTUMGRAPH_URL,
                QUANTUMGRAPH_COMMIT,
            ),
            "pairwise-tomography": self.direct_url(
                PAIRWISE_TOMOGRAPHY_URL,
                PAIRWISE_TOMOGRAPHY_COMMIT,
            ),
        }

        class Distribution:
            def __init__(self, text: str) -> None:
                self.text = text

            def read_text(self, filename: str) -> str | None:
                return self.text if filename == "direct_url.json" else None

        with patch(
            "compiler.compile_fixtures.metadata.distribution",
            side_effect=lambda name: Distribution(payloads[name]),
        ):
            verified = verify_pinned_source_revisions()
        self.assertEqual(
            verified["quantumgraph"]["commit"],
            QUANTUMGRAPH_COMMIT,
        )
        self.assertEqual(
            verified["pairwise-tomography"]["commit"],
            PAIRWISE_TOMOGRAPHY_COMMIT,
        )

    def test_source_drift_in_url_commit_or_requested_revision_fails_closed(
        self,
    ) -> None:
        valid_pairwise = self.direct_url(
            PAIRWISE_TOMOGRAPHY_URL,
            PAIRWISE_TOMOGRAPHY_COMMIT,
        )

        class Distribution:
            def __init__(self, text: str) -> None:
                self.text = text

            def read_text(self, filename: str) -> str | None:
                return self.text if filename == "direct_url.json" else None

        for quantumgraph_payload in (
            self.direct_url(
                "https://github.com/example/QuantumGraph.git",
                QUANTUMGRAPH_COMMIT,
            ),
            self.direct_url(QUANTUMGRAPH_URL, "0" * 40),
            self.direct_url(
                QUANTUMGRAPH_URL,
                QUANTUMGRAPH_COMMIT,
                requested="1" * 40,
            ),
        ):
            payloads = {
                "quantumgraph": quantumgraph_payload,
                "pairwise-tomography": valid_pairwise,
            }
            with self.subTest(payload=quantumgraph_payload), patch(
                "compiler.compile_fixtures.metadata.distribution",
                side_effect=lambda name: Distribution(payloads[name]),
            ):
                with self.assertRaisesRegex(ValueError, "source drift"):
                    verify_pinned_source_revisions()

    def test_missing_direct_url_fails_closed(self) -> None:
        class Distribution:
            def read_text(self, filename: str) -> None:
                return None

        with patch(
            "compiler.compile_fixtures.metadata.distribution",
            return_value=Distribution(),
        ):
            with self.assertRaisesRegex(ValueError, "no direct_url.json"):
                verify_pinned_source_revisions()


class AcquisitionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        circuit = QuantumCircuit(6, name="acquisition-contract")
        circuit.h(0)
        circuit.measure_all()
        cls.request = AcquisitionRequest(
            logical_circuits=(circuit,),
            shots_per_circuit=128,
            simulator_seed=812,
            transpiler_seed=913,
        )
        cls.batch = LocalAerAcquisition().acquire(cls.request)
        validate_acquisition_batch(cls.request, cls.batch)

    def test_local_aer_adapter_preserves_the_v1_execution_record(self) -> None:
        record = local_aer_fixture_execution(self.batch.evidence)
        self.assertEqual(
            list(record),
            [
                "backendClass",
                "backendName",
                "providerMode",
                "providerName",
                "mothApi",
                "jobId",
                "shotsPerCircuit",
                "simulatorSeed",
                "transpilerSeed",
                "tomographyCircuitCount",
                "totalShots",
                "logicalMeasurementCircuitSha256",
                "transpiledAerCircuitSha256",
                "rawCountsSha256",
                "durableProviderResult",
                "hardwareLayout",
                "backendCalibration",
                "fallbackFrom",
            ],
        )
        self.assertEqual(record["providerMode"], "local-aer")
        self.assertEqual(record["shotsPerCircuit"], 128)
        self.assertEqual(record["tomographyCircuitCount"], 1)
        self.assertEqual(record["totalShots"], 128)
        self.assertFalse(record["durableProviderResult"])
        self.assertEqual(record["providerName"], "qiskit-aer")
        self.assertFalse(record["mothApi"])
        self.assertIsNone(record["hardwareLayout"])
        self.assertIsNone(record["backendCalibration"])
        self.assertIsNone(record["fallbackFrom"])

    def test_explicit_tomography_integrates_the_local_adapter(self) -> None:
        matrices, record = explicit_tomography(
            initial_circuit(),
            shots=128,
            seed=771,
        )
        self.assertEqual(set(matrices), set(EDGES))
        self.assertEqual(record["providerMode"], "local-aer")
        self.assertEqual(record["tomographyCircuitCount"], 15)
        self.assertEqual(record["totalShots"], 1_920)

    def test_validation_rejects_tampered_execution_evidence(self) -> None:
        bad_counts = replace(
            self.batch,
            evidence=replace(
                self.batch.evidence,
                raw_counts_sha256="0" * 64,
            ),
        )
        with self.assertRaisesRegex(ValueError, "Raw count digest"):
            validate_acquisition_batch(self.request, bad_counts)

        bad_isa = replace(
            self.batch,
            evidence=replace(
                self.batch.evidence,
                transpilation=replace(
                    self.batch.evidence.transpilation,
                    isa_circuit_sha256=("0" * 64,),
                ),
            ),
        )
        with self.assertRaisesRegex(ValueError, "ISA circuit hashes"):
            validate_acquisition_batch(self.request, bad_isa)

        wrong_shots = replace(
            self.batch,
            evidence=replace(self.batch.evidence, shots_per_circuit=127),
        )
        with self.assertRaisesRegex(ValueError, "shot count"):
            validate_acquisition_batch(self.request, wrong_shots)

    def test_future_hardware_evidence_requires_the_durable_contract(self) -> None:
        hardware_request = replace(self.request, simulator_seed=None)
        target = HardwareTargetEvidence(
            logical_to_physical=(5, 4, 3, 2, 1, 0),
            target_name="test-six-qubit-target",
            target_snapshot_sha256="a" * 64,
            calibration_id="calibration-2026-08-18",
            calibration_timestamp_utc="2026-08-18T01:00:00+00:00",
            calibration_sha256="b" * 64,
        )
        hardware_evidence = replace(
            self.batch.evidence,
            provider_mode="batched-hardware",
            provider_name="test-provider",
            backend_name="test-qpu",
            backend_class="ProviderBackend",
            result_id="result-456",
            submitted_at_utc="2026-08-18T00:00:00+00:00",
            completed_at_utc="2026-08-18T00:05:00+00:00",
            retrieved_at_utc="2026-08-18T00:06:00+00:00",
            simulator_seed=None,
            durable_provider_result=True,
            hardware_target=target,
        )
        hardware_batch = replace(self.batch, evidence=hardware_evidence)
        validate_acquisition_batch(hardware_request, hardware_batch)
        record = fixture_execution(hardware_evidence)
        self.assertEqual(record["providerMode"], "batched-hardware")
        self.assertEqual(record["providerName"], "test-provider")
        self.assertEqual(record["backendName"], "test-qpu")
        self.assertEqual(record["resultId"], "result-456")
        self.assertEqual(record["hardwareLayout"]["logicalToPhysical"], [5, 4, 3, 2, 1, 0])
        self.assertEqual(
            record["transpilation"]["isaCircuitSha256"],
            list(hardware_evidence.transpilation.isa_circuit_sha256),
        )

        missing_result = replace(
            hardware_batch,
            evidence=replace(hardware_evidence, result_id=None),
        )
        with self.assertRaisesRegex(ValueError, "result_id"):
            validate_acquisition_batch(hardware_request, missing_result)

        missing_timestamp = replace(
            hardware_batch,
            evidence=replace(hardware_evidence, completed_at_utc=None),
        )
        with self.assertRaisesRegex(ValueError, "requires submission, completion"):
            validate_acquisition_batch(hardware_request, missing_timestamp)

        missing_target = replace(
            hardware_batch,
            evidence=replace(hardware_evidence, hardware_target=None),
        )
        with self.assertRaisesRegex(ValueError, "layout, target, and calibration"):
            validate_acquisition_batch(hardware_request, missing_target)

        incomplete_layout = replace(
            hardware_batch,
            evidence=replace(
                hardware_evidence,
                hardware_target=replace(target, logical_to_physical=(0, 1)),
            ),
        )
        with self.assertRaisesRegex(ValueError, "map all six logical qubits"):
            validate_acquisition_batch(hardware_request, incomplete_layout)

        with self.assertRaisesRegex(ValueError, "cannot serialize hardware"):
            local_aer_fixture_execution(hardware_evidence)

    def test_failures_block_characterization_and_fallbacks_are_explicit(self) -> None:
        failure = AcquisitionFailure(
            provider_name="test-provider",
            backend_name="test-qpu",
            moth_api=False,
            stage="result-retrieval",
            occurred_at_utc="2026-08-18T00:07:00+00:00",
            reason="Provider result was incomplete.",
            job_id="job-123",
        )
        failed = replace(
            self.batch,
            result=None,
            evidence=replace(
                self.batch.evidence,
                status="failed",
                failure=failure,
            ),
        )
        with self.assertRaisesRegex(ValueError, "refusing characterization"):
            validate_acquisition_batch(self.request, failed)

        fallback = replace(
            self.batch,
            evidence=replace(self.batch.evidence, fallback_from=failure),
        )
        validate_acquisition_batch(self.request, fallback)
        fallback_record = local_aer_fixture_execution(fallback.evidence)
        self.assertEqual(
            fallback_record["fallbackFrom"],
            {
                "providerName": "test-provider",
                "backendName": "test-qpu",
                "mothApi": False,
                "stage": "result-retrieval",
                "occurredAtUtc": "2026-08-18T00:07:00+00:00",
                "reason": "Provider result was incomplete.",
                "jobId": "job-123",
            },
        )

        invalid_fallback = replace(
            fallback,
            evidence=replace(
                fallback.evidence,
                fallback_from=replace(failure, reason=""),
            ),
        )
        with self.assertRaisesRegex(ValueError, "fallback_from.reason"):
            validate_acquisition_batch(self.request, invalid_fallback)

    def test_invalid_adapter_evidence_never_reaches_the_fitter(self) -> None:
        class TamperedAdapter:
            provider_mode = "local-aer"

            def acquire(self, request: AcquisitionRequest):
                batch = LocalAerAcquisition().acquire(request)
                return replace(
                    batch,
                    evidence=replace(
                        batch.evidence,
                        raw_counts_sha256="0" * 64,
                    ),
                )

        with patch(
            "compiler.compile_fixtures.PairwiseStateTomographyFitter"
        ) as fitter:
            with self.assertRaisesRegex(ValueError, "Raw count digest"):
                explicit_tomography(
                    initial_circuit(),
                    shots=128,
                    seed=117,
                    adapter=TamperedAdapter(),
                )
            fitter.assert_not_called()

    def test_injected_validated_hardware_batch_reaches_fitting_and_serialization(
        self,
    ) -> None:
        target = HardwareTargetEvidence(
            logical_to_physical=(5, 4, 3, 2, 1, 0),
            target_name="mock-six-qubit-target",
            target_snapshot_sha256="c" * 64,
            calibration_id="mock-calibration",
            calibration_timestamp_utc="2026-08-18T01:00:00+00:00",
            calibration_sha256="d" * 64,
        )

        class MockHardwareAdapter:
            provider_mode = "batched-hardware"

            def acquire(self, request: AcquisitionRequest):
                self_request = replace(request, simulator_seed=319)
                local_batch = LocalAerAcquisition().acquire(self_request)
                return replace(
                    local_batch,
                    evidence=replace(
                        local_batch.evidence,
                        provider_mode="batched-hardware",
                        provider_name="mock-offline-provider",
                        backend_name="mock-qpu",
                        backend_class="MockProviderBackend",
                        moth_api=False,
                        result_id="mock-result-456",
                        submitted_at_utc="2026-08-18T00:00:00+00:00",
                        completed_at_utc="2026-08-18T00:05:00+00:00",
                        retrieved_at_utc="2026-08-18T00:06:00+00:00",
                        simulator_seed=None,
                        durable_provider_result=True,
                        hardware_target=target,
                    ),
                )

        matrices, record = explicit_tomography(
            initial_circuit(),
            shots=128,
            seed=991,
            adapter=MockHardwareAdapter(),
        )
        self.assertEqual(set(matrices), set(EDGES))
        self.assertEqual(record["providerMode"], "batched-hardware")
        self.assertEqual(record["providerName"], "mock-offline-provider")
        self.assertEqual(record["backendName"], "mock-qpu")
        self.assertTrue(record["durableProviderResult"])
        self.assertIsNone(record["simulatorSeed"])

    def test_compiler_rejects_mixed_acquisition_modes(self) -> None:
        local = local_aer_fixture_execution(self.batch.evidence)
        hardware = {
            "providerMode": "batched-hardware",
            "providerName": "mock-provider",
            "backendName": "mock-qpu",
            "mothApi": False,
        }
        with self.assertRaisesRegex(ValueError, "mixed acquisition modes"):
            compiled_acquisition_summary([local, hardware])


if __name__ == "__main__":
    unittest.main()
