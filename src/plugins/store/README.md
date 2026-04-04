# store

Demotes entries from active context to stored (background) state.

## Registration

- **Tool**: `store`
- **Modes**: ask, act
- **Category**: ask
- **Handler**: Matches entries by pattern, demotes them via `demoteByPattern`, and records the result.

## Projection

Shows `store {path}`.

## Behavior

- Pattern queries (globs or body filters) produce a summary of matched paths.
- Exact path queries report "{path} stored" or "{path} not found".
- Stored entries remain in the database but are excluded from model context.
