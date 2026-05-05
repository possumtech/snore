# programbench

Adapter for [facebookresearch/ProgramBench](https://github.com/facebookresearch/ProgramBench):
200 tasks where the agent rebuilds a complete codebase from a
compiled binary + docs alone, scored against per-task behavioral
test suites.

## Layout

- `runner.js` — single-task end-to-end (pull image → extract
  workspace → run rummy → tar submission).
- `setup.sh` — installs the `programbench` Python CLI for the
  eval phase. Inference needs no setup.
- `results/<run-id>/<task-key>/` — submission output per run.

## Run one task

```
npm run test:programbench:setup           # one-time, installs eval CLI
node test/programbench/runner.js \
  --task abishekvashok_1776_cmatrix.5c082c6
```

After the run, `results/<run-id>/abishekvashok__cmatrix.5c082c6/submission.tar.gz`
is the file `programbench eval` expects.

## Observing a run in flight

Three surfaces, in increasing detail:

1. **Live stderr** — the npm script tees to
   `/tmp/rummy_test_diag/programbench_<ts>.log`. `tail -f` it for
   per-turn `[rummy-cli] turn N status=X` lines and any errors.
2. **Scratch workspace** — `results/<run-id>/<task>/workspace/`.
   `watch ls workspace/` shows source files appearing as the model
   writes them.
3. **Per-run digest** — the DB is pinned at
   `results/<run-id>/<task>/rummy.db`. Run
   `npm run dev:digest results/<run-id>/<task>/rummy.db` for the
   curated digest (waterfall, reasoning, token totals incl. cache
   hit rate). Re-run anytime — it backs up the live DB via
   `sqlite3 .backup` so it doesn't lock against the writer.

## Eval

```
test/programbench/.venv/bin/programbench eval test/programbench/results/<run-id>/
```

Eval pulls per-task `:task` images from Docker Hub on demand and
writes `<task-key>.eval.json` next to each submission.

## Documented deviation: host-side execution

Canonical mini-swe-agent harness runs the agent inside the
cleanroom container and gates internet at the container network
boundary. Rummy here runs **on the host** and operates a scratch
directory copied out of the cleanroom workspace. The agent's
`<sh>` therefore runs in the host shell, not via `docker exec`.

Implications:
- The host has generic network reach. Internet exfil is gated
  only by `RUMMY_NO_WEB=1` (drops the `<search>` tool from the
  active toolset).
- Native binary execution: the cleanroom binary is `linux/amd64`;
  the host must match. Permissions on `executable` are restored
  to `---x--x--x` after `docker cp` to preserve the
  no-decompilation invariant.
- `.git` is excluded from `RUMMY_PROJECT_FILES` so the model
  never sees the (clean) git stub.

This deviation is for v0 ergonomics — get an end-to-end loop
running in one process, debug in one place. Containerized
execution is a future hardening pass.

## Models

`--model` flag overrides the model alias (default `gemma`).
`gemma` resolves to `openai/macher.gguf` against
`gemma.possumtech.com` via `.env.tbench` cascade. Server context
is 64K — adequate for small tasks (cmatrix, walk, fx); larger
targets (sqlite, ffmpeg) are out of reach until we either
shrink the working set further or move to a 2M-context model.
