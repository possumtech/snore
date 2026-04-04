# rm

Removes entries by path or glob pattern.

## Registration

- **Tool**: `rm`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Matches entries by pattern. K/V entries are removed immediately (`pass`); file entries produce `proposed` state for client approval.

## Projection

Shows `rm {path}`.

## Behavior

Supports glob patterns and body filters via `getEntriesByPattern`. Each matched entry is processed independently.
