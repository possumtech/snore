# persona

Runtime persona management. A persona is free-form text that gets
prepended to the model's system prompt for a run.

## Files

- **persona.js** — RPC registration and persona file loading.

## RPC Methods

| Method | Params | Notes |
|--------|--------|-------|
| `persona/set` | `{ run, name?, text? }` | Set persona by filename (`${RUMMY_HOME}/personas/<name>.md`) or raw text. Pass neither to clear. |
| `listPersonas` | — | Return `[{name, path}]` for available persona files. |

## Behavior

Persona is stored on the run row (`runs.persona`). The instructions
plugin reads it during system-prompt assembly.
