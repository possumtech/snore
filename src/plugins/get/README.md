# get {#get_plugin}

Retrieves and promotes entries by path or glob pattern.

## Registration

- **Tool**: `get`
- **Category**: `logging`
- **Handler**: Fetches matching entries via `getEntriesByPattern`, promotes them with `promoteByPattern`, and records the result.

## Projection

Shows `get {path}` followed by the entry body.

## Behavior

- Pattern queries (globs or body filters) produce a summary of matched paths.
- Exact path queries report the path and token count, or "not found".
- Budget check: rejects with 413 if incoming tokens exceed remaining context.
