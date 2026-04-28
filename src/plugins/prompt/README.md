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

## Archived prompts: the singular exception to invisibility

`v_model_context.sql` filters archived entries out of the model's
context — every scheme **except `prompt`**. Archived `prompt://`
entries flow through with `effective_visibility = 'archived'` and
their body suppressed (per `projected.body`'s visibility CASE). The
plugin then renders the tag with full attributes (`path`,
`visibility="archived"`, etc.) but empty body.

The exception exists because the prompt is run identity: every other
archived entry is recoverable by pattern search if the model ever
needs it back, but the prompt is the question the run is answering.
A model that loses sight of its prompt cannot honestly act. Keeping
the archived prompt's path visible lets the model emit
`<get path="prompt://N"/>` to promote it back if it archived
prematurely (or step back to an earlier stage via
`<update status="174">`).

This is the only entry-type exception to the "archived = invisible"
contract. New schemes that warrant similar treatment should be added
explicitly here, not by accident.
