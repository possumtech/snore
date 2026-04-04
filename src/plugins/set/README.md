# set

Writes or edits entry content. Handles new files, full overwrites, SEARCH/REPLACE edits, and pattern updates.

## Files

- **set.js** — Plugin registration and edit dispatch logic.
- **HeuristicMatcher.js** — Fuzzy SEARCH/REPLACE matching. Handles whitespace/indentation differences and escaped characters when literal match fails.
- **HeuristicMatcher.test.js** — Tests for HeuristicMatcher.

## Registration

- **Tool**: `set`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Routes to different paths based on attributes:
  - `blocks` or `search` — SEARCH/REPLACE edit via `processEdit`.
  - `preview` — pattern preview (dry run).
  - K/V path — direct upsert at `full` state.
  - File path — produces `proposed` entry with udiff patch.
  - Glob/filter — bulk update via `updateBodyByPattern`.

## Projection

Shows `set {file}` with token delta (`before→after tokens`). Includes the merge conflict block when a SEARCH/REPLACE was performed.

## Behavior

- **Literal match first**: SEARCH text is matched literally against the entry body.
- **Heuristic fallback**: On literal failure, `HeuristicMatcher.matchAndPatch` attempts fuzzy matching with warnings.
- **Patch generation**: `generatePatch` produces unified diff format for client display.
- File writes are always `proposed`; K/V writes resolve immediately.
