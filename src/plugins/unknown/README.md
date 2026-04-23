# unknown {#unknown_plugin}

The Rumsfeld mechanism. The model registers what it doesn't know before acting.

`<unknown>which database adapter is configured</unknown>`

## Registration

- **Tool**: `unknown`
- **Category**: `unknown`
- **Handler**: None — recorded by TurnExecutor, deduplicated against existing unknowns.
- **Filter**: `assembly.user` at priority 200 — renders `<unknowns>` adjacent to `<prompt>` (priority 300), after `<performed>` (priority 100). Unknowns are active work, not stable environment state; they belong in the user packet.

## Projection

`# unknown\n{body}`

## Behavior

Unknowns are sticky — they persist across turns until the model explicitly
removes them with `<rm>`. The model investigates unknowns using `<get>`,
`<env>`, or `<ask_user>`, then removes resolved ones. Server deduplicates
on insert. Each unknown renders with turn, visibility, and tokens for
temporal reasoning and context management.
