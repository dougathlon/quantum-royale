# Offline compiler environment

The compiler is optional. Browser play, web development, and `pnpm check:web` use only Node and pnpm.

Fixture regeneration and `pnpm check:compiler` currently depend on a separately reviewed Python 3.9 environment. By default, `compiler/run.sh` expects:

```text
../quantumgraph-playground/.venv/bin/python
```

relative to the parent `prototypes/` directory. Set `QUANTUM_ROYALE_PYTHON` to an equivalent reviewed interpreter when the workspace is arranged differently.

The committed environment used Python 3.9.6 with Qiskit 2.2.3, Qiskit Aer 0.17.2, QuantumGraph commit `6917364b9496bd324225e87e6dd986bce52ecefd`, and pairwise-tomography commit `dbab12513281bd8ca7828252cf2e98a1a5749761`. The compiler checks installed PEP 610 VCS metadata before making pinned-source claims. That verifies recorded installation metadata, not a content hash of every installed dependency file.

This environment is not yet bootstrapped by the public repository or required by pull-request CI. The manual compiler workflow records that boundary instead of pretending a hosted runner has reproduced the pinned environment.
