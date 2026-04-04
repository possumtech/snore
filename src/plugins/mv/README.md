# mv

Moves (renames) an entry from one path to another within the K/V store.

## Registration

- **Tool**: `mv`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Reads source body, writes to destination, removes source. K/V destinations resolve immediately (`pass`); file destinations produce a `proposed` entry.

## Projection

Shows `mv {from} {to}`.

## Behavior

Warns if the destination already exists and will be overwritten. Uses `KnownStore.scheme()` to determine K/V vs file paths. Source entry is removed on successful K/V moves.
