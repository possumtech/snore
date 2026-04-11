# progress

Renders the `<progress>` section of the user message — bridges the
current work log to the active prompt.

## Registration

- **Filter**: `assembly.user` at priority 200

## Behavior

Emits `<progress turn="N">` carrying token budget and fidelity stats.
On continuation turns with current entries: "The above actions were
performed in response to the following prompt:"

Progress text is the tuning knob for model orientation between turns.
