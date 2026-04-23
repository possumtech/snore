# sh {#sh_plugin}

Proposes shell command execution for client approval.

## Registration

- **Tool**: `sh`
- **Category**: `logging`
- **Handler**: Upserts the entry at status 202 (proposed). The client must approve execution.

## Projection

Shows `sh {command}` followed by the entry body.

## Behavior

All shell commands require client-side approval — nothing executes
server-side. Act mode only; excluded in ask mode by `resolveForLoop`.
