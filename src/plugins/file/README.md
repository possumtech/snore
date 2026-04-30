# file {#file_plugin}

Owns file-related projections and file constraint management.

## Registration

- **Schemes**: `file` (bare paths), `http`, `https` — all `category: "data"`
- **Views**: `full` and `summary` for file scheme. Default identity views
  for `http`/`https` (overridden by rummy.web when installed).
- **No tool handler** — file operations are dispatched through `set`, `get`, `rm`, etc.

## File Constraints

Static methods `setConstraint` and `dropConstraint` manage per-project
file constraints in the database. Constraints are project-level config
(backbone), not tool dispatch. See [file_constraints](../../../SPEC.md#file_constraints).

Constraint type governs **membership** and **write permission**, not
in-context visibility. Visibility (visible / summarized / archived)
is per-entry and model-controlled — files default to `archived` on
ingestion; the model promotes via `<get>` / `<set visibility=...>`.

- `add` — file is part of the project; ingested as an entry; model
  may write. Default for `setConstraint`.
- `readonly` — same ingestion; `<set>` is vetoed at the proposal-
  accept gate.
- `ignore` — excluded from scans entirely. The file remains on disk
  for `<sh>` / `<env>` invocation but is not present as an entry.

Promotion/demotion of an ingested file goes through the standard tool
handler chain via `dispatchTool`.
