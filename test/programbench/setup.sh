#!/usr/bin/env bash
# Provisions the local-side scaffolding for ProgramBench eval.
#
# Inference (running rummy against a task) needs no setup beyond
# Docker + the rummy repo. Evaluation (scoring a submission) needs
# the `programbench` Python CLI, which we install into a local venv
# the same way tbench installs harbor.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate

pip install --upgrade pip --quiet
pip install --quiet programbench

echo "programbench CLI installed at $(.venv/bin/programbench --help 2>&1 | head -1)"
