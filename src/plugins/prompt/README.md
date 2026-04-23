# prompt {#prompt_plugin}

Renders the `<prompt mode="ask|act">` tag at the end of the user message.
Always present on every turn — the model always sees its task.

## Registration

- **Filter**: `assembly.user` at priority 300 (always last)

## Behavior

Finds the latest `prompt://` entry in the turn_context rows. The mode
(`ask` or `act`) is stored in `attributes.mode`. Renders with `tools`
attribute (available tool list) and optional `warn` attribute in ask
mode. Falls back to the mode passed by the core if no prompt entry
exists.
