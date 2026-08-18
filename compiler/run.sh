#!/bin/sh
set -eu

prototype_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
workspace_dir=$(CDPATH= cd -- "$prototype_dir/../.." && pwd)
default_python="$workspace_dir/prototypes/quantumgraph-playground/.venv/bin/python"
python_bin=${QUANTUM_ROYALE_PYTHON:-$default_python}

if [ ! -x "$python_bin" ]; then
  echo "Pinned QuantumGraph Python was not found at: $python_bin" >&2
  echo "Build/repair prototypes/quantumgraph-playground first or set QUANTUM_ROYALE_PYTHON." >&2
  exit 2
fi

export PYTHONDONTWRITEBYTECODE=1
unset PYTHONPYCACHEPREFIX
export MPLCONFIGDIR="$prototype_dir/.mplconfig"
unset PYTHONHOME PYTHONPATH

cd "$prototype_dir"
exec "$python_bin" "$@"
