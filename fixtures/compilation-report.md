# Quantum Royale fixture compilation report

**Compiled:** 2026-08-18T06:25:59+00:00
**Status:** LOCAL FINITE-SHOT AER EVIDENCE — not a QPU result.

## Cost

- Checkpoints: 15
- Tomography circuits per checkpoint: 15
- Total circuit executions: 225
- Shots per circuit: 4096
- Total simulated shots: 921600
- Parent checkpoints characterized for repeat noise: 7
- Additional repeats per parent: 3
- Additional repeat-calibration circuits: 315
- Additional repeat-calibration shots: 1290240
- Total circuit executions including calibration: 540
- Total shots including calibration: 2211840

## Operation-level pre/post calibration

| Parent | Child | Trigger | operation | context | exact active TV | exact target max TV | exact overlap max TV | finite active TV | parent repeat max TV | ratio |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| round-1-root | round-2-M | MATCHED_ACTION | CRY +3.142 | X | 0.221 | 0.369 | 0.369 | 0.238 | 0.034 | 6.93 |
| round-1-root | round-2-S | SPLIT_ACTION | CRY -3.142 | X | 0.221 | 0.369 | 0.369 | 0.232 | 0.034 | 6.77 |
| round-2-M | round-3-MM | MATCHED_ACTION | RZX +1.571 | Y | 0.239 | 0.335 | 0.389 | 0.233 | 0.031 | 7.63 |
| round-2-M | round-3-MS | SPLIT_ACTION | RZX -1.571 | Y | 0.233 | 0.239 | 0.357 | 0.229 | 0.031 | 7.49 |
| round-2-S | round-3-SM | MATCHED_ACTION | RZX +1.571 | Y | 0.239 | 0.335 | 0.389 | 0.268 | 0.032 | 8.41 |
| round-2-S | round-3-SS | SPLIT_ACTION | RZX -1.571 | Y | 0.233 | 0.239 | 0.357 | 0.229 | 0.032 | 7.21 |
| round-3-MM | round-4-MMM | MATCHED_ACTION | RZX +1.571 | Z | 0.236 | 0.236 | 0.381 | 0.238 | 0.037 | 6.41 |
| round-3-MM | round-4-MMS | SPLIT_ACTION | RZX -1.571 | Z | 0.226 | 0.236 | 0.348 | 0.229 | 0.037 | 6.17 |
| round-3-MS | round-4-MSM | MATCHED_ACTION | RZX +1.571 | Z | 0.236 | 0.236 | 0.381 | 0.228 | 0.030 | 7.59 |
| round-3-MS | round-4-MSS | SPLIT_ACTION | RZX -1.571 | Z | 0.226 | 0.236 | 0.348 | 0.218 | 0.030 | 7.27 |
| round-3-SM | round-4-SMM | MATCHED_ACTION | RZX +1.571 | Z | 0.236 | 0.236 | 0.381 | 0.239 | 0.033 | 7.30 |
| round-3-SM | round-4-SMS | SPLIT_ACTION | RZX -1.571 | Z | 0.226 | 0.236 | 0.348 | 0.217 | 0.033 | 6.64 |
| round-3-SS | round-4-SSM | MATCHED_ACTION | RZX +1.571 | Z | 0.236 | 0.236 | 0.381 | 0.250 | 0.026 | 9.47 |
| round-3-SS | round-4-SSS | SPLIT_ACTION | RZX -1.571 | Z | 0.226 | 0.236 | 0.348 | 0.237 | 0.026 | 9.00 |

The total-variation thresholds are prototype legibility gates, not scientific standards. Every row compares one child checkpoint with its actual parent before and after the named operation; it is not a sibling comparison. Each finite-shot checkpoint was reconstructed with the pinned pairwise `lstsq` PSD fitter. The browser samples from those stored distributions classically.

## Parent-specific finite-shot repeat envelopes

| Parent | context | repeats | pairwise comparisons | active-context max TV | all-pair/context max TV | all-pair/context mean TV |
|---|---:|---:|---:|---:|---:|---:|
| round-1-root | X | 3 | 3 | 0.024 | 0.034 | 0.015 |
| round-2-M | Y | 3 | 3 | 0.012 | 0.031 | 0.015 |
| round-2-S | Y | 3 | 3 | 0.021 | 0.032 | 0.017 |
| round-3-MM | Z | 3 | 3 | 0.020 | 0.037 | 0.015 |
| round-3-MS | Z | 3 | 3 | 0.010 | 0.030 | 0.016 |
| round-3-SM | Z | 3 | 3 | 0.017 | 0.033 | 0.015 |
| round-3-SS | Z | 3 | 3 | 0.022 | 0.026 | 0.015 |

Three deterministic simulator/transpiler-seed repeats provide three pairwise repeat comparisons per relevant parent checkpoint. This is a bounded empirical envelope, not a confidence interval or hardware-noise model.

Acceptance rules:

- Every exact child-versus-parent active-context TV must be at least 0.15.
- Every exact child-versus-parent maximum overlapping-edge TV must be at least 0.05.
- Every finite-shot child-versus-parent active-context TV must exceed 3 times that parent's maximum observed repeat TV across all pairs and contexts.
- Observed weakest operation/own-parent-repeat ratio: 6.17

## Installed dependency VCS metadata

- QuantumGraph: `6917364b9496bd324225e87e6dd986bce52ecefd`
- pairwise-tomography: `dbab12513281bd8ca7828252cf2e98a1a5749761`
- Compilation fails before artifact emission unless each installed distribution's `direct_url.json` records the pinned Git URL, commit ID, and requested revision.
- This metadata check does not independently hash or attest every installed package file.

## Boundaries

- The complete K6 graph is a logical gameplay relationship graph, not a hardware layout.
- Pairwise tomography does not reconstruct a complete six-qubit state.
- The simulator does not establish entanglement, quantum advantage, hardware feasibility, latency, or cost.
- Runtime branch selection loads a committed child checkpoint and performs no quantum computation.
