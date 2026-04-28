# policy {#policy_plugin}

Per-invocation enforcement of ask-mode restrictions. Rejects
model-emitted commands that would mutate the filesystem when the run
was started in `ask` mode.

## Registration

- **Filter**: `entry.recording` (priority 1) — the validation /
  transform hook in TurnExecutor's RECORD phase. Runs after the
  command is parsed but before the audit row is committed. Returning
  an object with `state: "failed"` (or `"cancelled"`) short-circuits
  recording and skips DISPATCH for that command. Plugins may also
  return a transformed entry (modified body, attributes, path) for
  the recorder to commit. Filter signature:
  `(entry, { store, runId, turn, loopId, mode })`.

## Rejections (ask mode only)

- `<sh>` — any shell command.
- `<set path="file.txt">` — file-scheme writes (bare path, non-scheme).
- `<rm path="file.txt">` — file-scheme deletes.
- `<mv>` / `<cp>` into a file-scheme destination.

Each rejection logs via `error.log` and returns an entry with
`state: "failed"`, `outcome: "permission"` so it still appears in the
turn's audit trail.
