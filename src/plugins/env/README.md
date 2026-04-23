# env {#env_plugin}

Runs an exploratory shell command and records the output.

## Registration

- **Tool**: `env`
- **Category**: `logging`
- **Handler**: Upserts the entry at status 202 (proposed) with original attributes preserved.

## Projection

Shows `env {command}` followed by the entry body.
