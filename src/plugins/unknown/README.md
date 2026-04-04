# unknown

The Rumsfeld mechanism. The model registers what it doesn't know before acting.

`<unknown>which database adapter is configured</unknown>`

## Registration

- **Tool**: `unknown`
- **Modes**: ask, act
- **Category**: structural
- **Handler**: None — recorded by TurnExecutor, deduplicated against existing unknowns.

## Projection

`# unknown\n{body}`

## Behavior

Unknowns are sticky — they persist across turns until the model explicitly
stores or removes them. The model investigates unknowns using `<get>`,
`<env>`, or `<ask_user>`, then removes resolved ones with `<rm>`.
Server deduplicates on insert.
