# persona {#persona_plugin}

Workflow specification rendered into the system prompt below the
tooldocs. 1:1 run:persona — set at run creation, immutable thereafter.

## Files

- **default.md** — default persona (7D state machine) injected when the
  client supplies none.
- **persona.js** — registers the `persona` scheme + view callbacks.

## Resolution

- Client supplies persona text via the run-creation RPC's `persona`
  option.
- If null, `AgentLoop.ensureRun` loads `default.md`.
- Result persists to `runs.persona`; the instructions plugin reads it
  during system-prompt assembly.
