"""
Baseline runner using mini-swe-agent on swe-bench-verified-mini.

Produces a predictions.jsonl in the same shape as Rummy's runner,
so the same evaluator scores both. Requires `pip install mini-swe-agent`
(installed via test/swe/setup.sh).

Usage:
    python test/swe/baseline.py [--row 0-49]
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
DATA = THIS_DIR / "data" / "test.ndjson"
RESULTS = THIS_DIR / "results"
DATASET_HF = "MariusHobbhahn/swe-bench-verified-mini"


def parse_range(spec):
    if not spec:
        return None
    if "-" in spec:
        start, end = spec.split("-", 1)
        return int(start), int(end)
    n = int(spec)
    return n, n


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--row", default=None, help="row or range (e.g. 0 or 0-9)"
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("RUMMY_TEST_MODEL", "openrouter/x-ai/grok-4-1-fast"),
        help="LiteLLM-compatible model id",
    )
    args = parser.parse_args()

    if not DATA.exists():
        print(f"missing: {DATA}\nrun: npm run test:swe:get", file=sys.stderr)
        sys.exit(1)

    rng = parse_range(args.row)
    timestamp = dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    run_dir = RESULTS / f"baseline_{timestamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = run_dir / "predictions.jsonl"

    # mini-swe-agent CLI: `mini-extra swebench` runs the harness on a slice
    cmd = [
        "mini-extra",
        "swebench",
        "--subset",
        "verified",
        "--split",
        "test",
        "--model",
        args.model,
        "--output",
        str(run_dir),
    ]
    if rng is not None:
        cmd += ["--slice", f"{rng[0]}:{rng[1] + 1}"]

    print(f"Baseline: mini-swe-agent on {args.model}")
    print(f"Range: {rng if rng else 'all 50'}")
    print(f"Output: {run_dir}")
    print(f"Command: {' '.join(cmd)}\n")

    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(
            "\nNote: mini-swe-agent may write to a different filename. "
            "If predictions.jsonl is missing, look in the output dir for "
            "the actual JSONL produced and rename/symlink to predictions.jsonl",
            file=sys.stderr,
        )
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
