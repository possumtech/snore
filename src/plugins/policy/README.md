# policy

Per-invocation enforcement of ask-mode restrictions. Rejects
model-emitted commands that would mutate the filesystem when the run
was started in `ask` mode.

## Registration

- **Filter**: `entry.recording` (priority 1) — runs before a command
  becomes an entry.

## Rejections (ask mode only)

- `<sh>` — any shell command.
- `<set path="file.txt">` — file-scheme writes (bare path, non-scheme).
- `<rm path="file.txt">` — file-scheme deletes.
- `<mv>` / `<cp>` into a file-scheme destination.

Each rejection logs via `error.log` and returns an entry with
`state: "failed"`, `outcome: "permission"` so it still appears in the
turn's audit trail.
