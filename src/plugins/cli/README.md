# cli

One-shot CLI client. Boots the service, runs a single `ask`/`act`,
prints the final summary to stdout, exits with code `0` on terminal
status `200` (non-zero otherwise). Server mode is unaffected — the
plugin is inert when `RUMMY_PROMPT` is unset.

## Invocation

```bash
rummy-cli --RUMMY_PROMPT="list files in /tmp" --RUMMY_MODEL=xfast
```

All args are env-var-shape: `--KEY=value`, `--KEY value`, or `--KEY`
(boolean shorthand → `"1"`). Anything else is rejected with exit
code `2`. CLI flags trump every `.env*` file (Node's `loadEnvFile`
preserves existing vars).

## Required env

| Var | Effect |
|---|---|
| `RUMMY_PROMPT` | Activates the plugin and supplies the instruction. |
| `RUMMY_MODEL` | Model alias (must match a registered `RUMMY_MODEL_<alias>`). |

## Optional env

| Var | Default | Effect |
|---|---|---|
| `RUMMY_MODE` | `act` | `ask` or `act`. |
| `RUMMY_RUN_TIMEOUT_MS` | `3600000` (1h) | Watchdog — exits `124` on overflow. |

Per-run defaults (`RUMMY_YOLO`, `RUMMY_NO_REPO`, `RUMMY_NO_WEB`,
`RUMMY_NO_INTERACTION`, `RUMMY_NO_PROPOSALS`) cascade through
`AgentLoop`'s boundary normalization — see `.env.example`.

## Profile pattern

Layer profile-specific defaults via Node's `--env-file-if-exists`:

```bash
node --env-file-if-exists=.env.example \
     --env-file-if-exists=.env \
     --env-file-if-exists=.env.tbench \
     src/plugins/cli/bin.js \
     --RUMMY_PROMPT="..." --RUMMY_MODEL=xfast
```

A `.env.tbench` profile typically pins `RUMMY_YOLO=1`,
`RUMMY_NO_INTERACTION=1`, `RUMMY_NO_WEB=1`, plus model alias and
provider key. Bench harnesses call `rummy-cli` with just
`--RUMMY_PROMPT="..."` and let the profile carry the rest.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Terminal status `200`. Model claimed success. |
| `1` | Terminal status in `{204, 413, 422, 499, 500}` or run crashed. |
| `2` | Arg parse error (invalid flag shape, missing required env). |
| `124` | Wall-clock timeout (`RUMMY_RUN_TIMEOUT_MS` exceeded). |

External verifiers (terminal-bench, SWE-bench, etc.) decide actual
task success — the exit code only reports rummy's internal terminal
status.

## Files

- **`cli.js`** — plugin class. Subscribes to `boot.completed`; on fire,
  if `RUMMY_PROMPT` is set, constructs a `ProjectAgent`, kicks off
  the run, watches `run.state` for terminal, exits.
- **`bin.js`** — executable. Parses env-shape args, mirrors
  `bin/rummy.js`'s env-loading prelude, imports `service.js`.

## Architectural notes

- The plugin uses the same `ProjectAgent` constructor as
  `ClientConnection`. In CLI mode, `SocketServer` still starts (it's
  cheap) — `process.exit()` from the plugin terminates everything.
- `core.on("boot.completed", ...)` is the plugin's only hook.
  Subscribing earlier (e.g. constructor-time) would race plugin
  registration order; `boot.completed` fires after all plugins are
  inited and the DB is open.
