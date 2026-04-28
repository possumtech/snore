# set {#set_plugin}

Writes or edits entry content. Handles new files, full overwrites,
SEARCH/REPLACE edits, and pattern updates.

## Files

- **set.js** — Plugin registration and edit dispatch logic.
- **HeuristicMatcher.js** — Fuzzy SEARCH/REPLACE matching.
- **HeuristicMatcher.test.js** — Tests for HeuristicMatcher.

## Registration

- **Tool**: `set`
- **Category**: `logging`
- **Handler**: Routes based on attributes:
  - `blocks` or `search` — SEARCH/REPLACE edit via `processEdit`.
  - `manifest` — pattern manifest (lists matches without performing the set).
  - Scheme path — direct upsert at status 200.
  - File path — produces status 202 (proposed) with unified diff patch.
  - Glob/filter — bulk update via `updateBodyByPattern`.

## Projection

Shows `set {file}` with token delta (`before→after tokens`). Includes
the merge conflict block when a SEARCH/REPLACE was performed.

## Behavior

- **Literal match first**: SEARCH text is matched literally.
- **Heuristic fallback**: On literal failure, fuzzy matching with warnings.
- **Patch generation**: `generatePatch` produces unified diff for client display.
- File writes are always status 202 (proposed); scheme writes resolve immediately.
- **`proposal.content` filter** — when the client accepts a proposed
  set, this plugin overrides the resolved body to the body it
  already staged on the audit entry (rather than whatever literal
  body the client passed through `resolve`).
