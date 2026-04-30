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

## Archived prompts disappear, by design

`v_model_context.sql` filters archived entries out of the model's
context for every scheme — `prompt` included. There is no carve-out.
An archived `prompt://N` does not appear in the user message at
all: no tag, no body, no metadata.

The model is told not to archive the active prompt via the tip in
`instructions_105.md`:

> * Don't accidentally set the current prompt to `archived`.

If the model archives the prompt anyway, the run will visibly fail
on the next turn (no `<prompt>` tag for the model to act on; the
model emits "please provide a prompt to act upon" or similar
confusion). That instructive failure mode is intentional —
paradigm purity (archived means archived, no exceptions) over
silent data-layer rescue.

If practical behavior at scale ever demands a guard, the right
surface is an action-gate (refuse the `<set>` of `visibility="archived"`
on the active `prompt://N` with a soft 403 the model can read),
not a read-view carve-out that quietly keeps the entry visible.

System-level auto-archive on new prompt is unaffected: when a fresh
`prompt://M` arrives, the engine archives `prompt://N` (M > N) so
the prior cycle's prompt cleanly leaves context. `unknown://` /
`known://` entries persist across cycles; logs are demoted per
stage instructions.
