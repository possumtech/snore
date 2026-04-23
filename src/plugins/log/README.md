# log {#log_plugin}

Assembles the `<log>` block in the user message: every
`category="logging"` entry across the entire run, rendered as XML tool
tags in v_model_context sort order.

## Registration

- **Filter**: `assembly.user` (priority 100) — contributes the `<log>`
  block to the user packet.

## Rendering

Each logging entry renders with its scheme as the tag name (`<get>`,
`<set>`, `<search>`, `<rm>`, `<cp>`, `<mv>`, `<sh>`, `<env>`,
`<update>`, `<ask_user>`, `<error>`, `<budget>`). Attributes:
`path`, `turn`, `status`, `state`, `outcome`, `summary`, `visibility`,
`tokens`.

**`tokens=` invariant.** The value is always the full-visibility cost
of the thing the tag represents — never the log entry's own stub body
size. Resolution:

- If the log entry has `attrs.path` referencing a data entry (`get`,
  `set`, `mv`, `cp`): `tokens=` is that target's tokens. Promotes the
  audit record into a cost-accurate signal the model can plan against.
- If the action's log body itself IS the cost-bearing content
  (`search`, `update`, `error`, `ask_user`): `tokens=` is the entry's
  own body tokens.
- `sh` and `env` own multiple streaming channels (`sh://turn_N/{slug}_N`)
  — no single target to point at. `tokens=` is omitted; the channels
  render their own tokens in `<context>`.

## Behavior

No loop-boundary split. The `turn` attribute on every entry carries
when it happened; the model derives loop membership from the data if
it matters. One chronological log from turn 1 to now.

## Scheme invariant

Log entries (`log://turn_N/{action}/{slug}`) are audit records —
summary, exit status, references to where the data lives — and never
carry the payload itself. Payload for streaming actions lives under the
producer's own scheme (`sh://`, `env://`, future `search://`, etc.) at
`category=data`, and is rendered inside `<context>` by the known
plugin. Scheme determines category; data and logging never share a
scheme. See [scheme_category_split](#scheme_category_split).
