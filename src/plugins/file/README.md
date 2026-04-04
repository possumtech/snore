# file

Owns file-related projections and file constraint management.

## Files

- **file.js** — Plugin registration, projection hooks, and constraint CRUD (activate, ignore, drop).
- **FileScanner.js** — Scans project directories for file entries.
- **GitProvider.js** — Git integration for file discovery and status.
- **ProjectContext.js** — Builds project-level context from scanned files.
- **FsProvider.js** — Filesystem abstraction for file reading/writing.

## Registration

- **Projections**: Registers `onProject` handlers for schemes: `file`, `known`, `skill`, `ask`, `act`, `progress`. All project the entry body directly.
- **No tool handler** — file operations are dispatched through `set`, `get`, `rm`, etc.

## File Constraints

Static methods `activate`, `ignore`, and `drop` manage per-project file constraints in the database. Constraints control file visibility across all runs:

- `active` / `readonly` — always promoted into context.
- `ignore` — excluded from scans; demotes existing entries.

Paths are normalized to project-relative when absolute.
