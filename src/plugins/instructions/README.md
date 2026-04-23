# instructions {#instructions_plugin}

Projects the system prompt instructions into model context.

## Registration

- **View**: `full` — renders preamble + tool docs + persona.
- **Event**: `turn.started` — writes `instructions://system` entry.
- **Filter**: `instructions.toolDocs` — gathers docs from all tool plugins.

## Behavior

Replaces the `[%TOOLS%]` placeholder in the preamble with the active
tool list. Appends tool descriptions gathered via the `toolDocs` filter
and persona text when present in attributes.
