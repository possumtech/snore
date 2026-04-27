#!/usr/bin/env bash
# Set up the Python sidecar env for SWE-bench eval + baseline.
# Creates a venv inside test/swe/ so it doesn't pollute the project.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip --quiet
python -m pip install --quiet \
  swebench \
  mini-swe-agent

echo "Installed:"
python -c "import swebench; print('  swebench', swebench.__version__)" 2>/dev/null || echo "  swebench (version unknown)"
python -c "import minisweagent; print('  mini-swe-agent', getattr(minisweagent, '__version__', '?'))" 2>/dev/null || echo "  mini-swe-agent (version unknown)"

echo
echo "Activate with: source test/swe/.venv/bin/activate"
