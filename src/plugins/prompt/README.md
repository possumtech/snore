# prompt {#prompt_plugin}

Renders the `<prompt>` tag at the front of the user message —
the model sees its task first, then the dynamic state blocks,
then the late-bound rules and budget. Always present on every
turn.

## Registration

- **Filter**: `assembly.user` at priority 30 (front of user
  message, before all dynamic state and the `<instructions>`
  block at 165)

## Behavior

Finds the latest `prompt://` entry in the turn_context rows. Renders
with `commands` attribute (available tool list) and an optional
`warn="File editing disallowed."` attribute when the loop's mode is
`ask` (read from `attributes.mode` on the prompt entry, falling back
to the type passed by the core). The mode itself is not rendered as
a tag attribute — the warn copy carries the only model-relevant
consequence.

## Archived prompts disappear, by design

`v_model_context.sql` filters archived entries out of the model's
context for every scheme — `prompt` included. There is no carve-out.
An archived `prompt://N` does not appear in the user message at
all: no tag, no body, no metadata.

The model receives no instruction-side hint not to archive the
active prompt. If it archives the prompt anyway, the run will
visibly fail on the next turn (no `<prompt>` tag for the model to
act on; the model emits "please provide a prompt to act upon" or
similar confusion). That instructive failure mode is intentional —
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
