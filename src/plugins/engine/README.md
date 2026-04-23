# engine {#engine_plugin}

SQL infrastructure for context assembly and turn management. No JS plugin.

## Files

- **engine.sql** — Queries for retrieving visible entries by scheme tier, model visibility, and state.
- **turn_context.sql** — Queries for clearing and reading the `turn_context` / `v_model_context` view, which produces the ordered context sent to the model.

## Behavior

These SQL files are loaded by the database layer and used by the agent loop to assemble per-turn model context. They are not a plugin in the `register()` sense.
