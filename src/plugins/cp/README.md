# cp

Copies an entry from one path to another within the K/V store.

## Registration

- **Tool**: `cp`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Reads source body, writes to destination. K/V destinations resolve immediately (`pass`); file destinations produce a `proposed` entry.

## Projection

Shows `cp {from} {to}`.

## Behavior

Warns if the destination already exists and will be overwritten. Uses `KnownStore.scheme()` to determine whether the destination is a K/V path or a file path.
