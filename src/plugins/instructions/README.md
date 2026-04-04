# instructions

Projects the system prompt instructions into model context.

## Registration

- **Projection**: `onProject("instructions", ...)` — no tool handler.

## Behavior

Replaces the `[%TOOLS%]` placeholder in the prompt body with the `tools` attribute. Appends tool descriptions and persona text when present in attributes.
