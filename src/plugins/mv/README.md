# mv

Moves (renames) an entry from one path to another within the K/V store.

## Registration

- **Tool**: `mv`
- **Category**: `logging`
- **Handler**: Reads source body, writes to destination, removes source. Scheme destinations resolve immediately (status 200); file destinations produce status 202 (proposed).

## Projection

Shows `mv {from} {to}`.

## Behavior

Warns if the destination already exists and will be overwritten. Uses
`Entries.scheme()` to determine scheme vs file paths. Source entry
is removed on successful scheme moves.
