# known

Writes arbitrary key/value entries into the store at full fidelity.

## Registration

- **Tool**: `known`
- **Modes**: ask, act
- **Category**: act
- **Handler**: Upserts the entry body at the target path with `full` state.

## Projection

Shows `known {path}` followed by the entry body.

## Behavior

The target path defaults to `entry.resultPath` but can be overridden via `attrs.path`. Used by the model to persist structured notes and context.
