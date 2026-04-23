# cp {#cp_plugin}

Copies an entry from one path to another within the K/V store.

## Registration

- **Tool**: `cp`
- **Category**: `logging`
- **Handler**: Reads source body, writes to destination. Scheme destinations resolve immediately (status 200); file destinations produce status 202 (proposed).

## Projection

Shows `cp {from} {to}`.

## Behavior

Warns if the destination already exists and will be overwritten. Uses
`Entries.scheme()` to determine whether the destination is a scheme
path or a file path.
