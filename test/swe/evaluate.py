"""
Run SWE-bench's official evaluation harness against a predictions.jsonl.

Wraps `python -m swebench.harness.run_evaluation` with the right args
for swe-bench-verified-mini. Requires Docker + the `swebench` pip
package (install via test/swe/setup.sh).

Usage:
    python test/swe/evaluate.py <run_dir>
    # where <run_dir> contains predictions.jsonl
"""
import json
import os
import subprocess
import sys
from pathlib import Path

DATASET = "MariusHobbhahn/swe-bench-verified-mini"
SPLIT = "test"


def main():
    if len(sys.argv) < 2:
        print("usage: python test/swe/evaluate.py <run_dir>", file=sys.stderr)
        sys.exit(1)

    run_dir = Path(sys.argv[1]).resolve()
    predictions = run_dir / "predictions.jsonl"
    if not predictions.exists():
        print(f"missing: {predictions}", file=sys.stderr)
        sys.exit(1)

    # Read predictions to extract a run_id
    lines = predictions.read_text().strip().split("\n")
    first = json.loads(lines[0])
    model = first.get("model_name_or_path", "unknown")
    run_id = f"{run_dir.name}_{model}".replace("/", "_")

    cmd = [
        sys.executable,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        DATASET,
        "--split",
        SPLIT,
        "--predictions_path",
        str(predictions),
        "--max_workers",
        "4",
        "--run_id",
        run_id,
    ]

    print(f"Evaluating {len(lines)} predictions from {predictions}")
    print(f"Run ID: {run_id}")
    print(f"Command: {' '.join(cmd)}\n")

    env = os.environ.copy()
    result = subprocess.run(cmd, env=env, cwd=run_dir)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
