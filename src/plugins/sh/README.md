# sh

Proposes shell command execution for client approval.

## Registration

- **Tool**: `sh`
- **Modes**: act only
- **Category**: act
- **Handler**: Upserts the entry as `proposed` state. The client must approve execution.

## Projection

Shows `sh {command}` followed by the entry body.

## Behavior

All shell commands require client-side approval — nothing executes server-side. Act mode only; blocked in ask mode.
