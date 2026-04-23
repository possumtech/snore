# rm {#rm_plugin}

Removes entries by path or glob pattern.

## Registration

- **Tool**: `rm`
- **Category**: `logging`
- **Handler**: Matches entries by pattern. Scheme entries are removed immediately (status 200); file entries produce status 202 (proposed) for client approval.

## Projection

Shows `rm {path}`.

## Behavior

Supports glob patterns and body filters via `getEntriesByPattern`. Each
matched entry is processed independently.
