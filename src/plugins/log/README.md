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

`tokens=` is omitted on `set`, `mv`, `cp`, `sh`, `env` — their log
body is a small summary while the real content lives on the
companion data entry; advertising the log's body size would plant a
mixed signal pointing at the wrong cost.

## Behavior

No loop-boundary split. The `turn` attribute on every entry carries
when it happened; the model derives loop membership from the data if
it matters. One chronological log from turn 1 to now.
