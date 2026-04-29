#!/usr/bin/env bash
# Provisions the local-side scaffolding for terminal-bench 2.0 via Harbor:
#   - Clones our harbor fork to $RUMMY_TBENCH_HARBOR_DIR (default ~/repo/harbor/main).
#   - Creates a Python venv inside test/tbench/ and pip-install -e's harbor.
# The harbor adapter (src/harbor/agents/installed/rummy.py) lives in the
# harbor fork checkout, not in this repo. setup.sh is idempotent.
set -euo pipefail

cd "$(dirname "$0")"

: "${RUMMY_TBENCH_HARBOR_DIR:?must be set in .env.tbench}"
: "${RUMMY_TBENCH_HARBOR_REPO:?must be set in .env.tbench}"
: "${RUMMY_TBENCH_HARBOR_REF:?must be set in .env.tbench}"

# Tilde-expand if needed (env var loaders don't expand ~).
HARBOR_DIR="${RUMMY_TBENCH_HARBOR_DIR/#\~/$HOME}"

if [ ! -d "$HARBOR_DIR/.git" ]; then
  echo "Cloning $RUMMY_TBENCH_HARBOR_REPO → $HARBOR_DIR"
  mkdir -p "$(dirname "$HARBOR_DIR")"
  git clone --quiet "$RUMMY_TBENCH_HARBOR_REPO" "$HARBOR_DIR"
fi

git -C "$HARBOR_DIR" fetch --quiet origin "$RUMMY_TBENCH_HARBOR_REF"
git -C "$HARBOR_DIR" checkout --quiet "$RUMMY_TBENCH_HARBOR_REF"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
python -m pip install --upgrade pip --quiet
python -m pip install --quiet -e "$HARBOR_DIR"

echo "Installed:"
python -c "import harbor; print('  harbor', getattr(harbor, '__version__', '?'))" 2>/dev/null || echo "  harbor (version unknown)"
which harbor || echo "  (harbor CLI not found on PATH — check editable install)"

echo
echo "Harbor fork:  $HARBOR_DIR"
echo "Activate venv: source test/tbench/.venv/bin/activate"
echo "Adapter source-of-truth: $HARBOR_DIR/src/harbor/agents/installed/rummy.py"
