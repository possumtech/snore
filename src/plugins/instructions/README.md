# instructions {#instructions_plugin}

Projects the model-facing instructions into the assembled packet.
Cleanly split into a stable system-side base and a dynamic user-side
phase directive so prompt caching holds across turns within a run.

## Registration

- **View**: `full` — renders the `instructions.md` base (identity +
  `[%TOOLS%]` + `[%TOOLDOCS%]` + optional persona) for the
  `instructions://system` entry. Stable across turns.
- **Event**: `turn.started` — writes `instructions://system` entry
  with `{ persona, toolSet }` attributes.
- **Filter**: `instructions.toolDocs` — gathers docs from all tool
  plugins into a docsMap.
- **Filter**: `assembly.user` (priority 250) — renders the current
  phase's `instructions_10N.md` as `<instructions>` immediately
  before `<prompt>`. Phase selected from the latest `<update status>`
  emission in this turn's row set.

## Files

- `instructions.js` — plugin registration and assembly logic.
- `instructions.md` — the system-side base template. Static across
  turns; only identity + `[%TOOLS%]` + `[%TOOLDOCS%]` placeholders.
- `instructions_104.md` … `instructions_108.md` — phase-specific
  directives keyed by the 1XY status encoding (Define / Discover /
  Distill / Demote / Deploy).
- `protocol.js` — placeholder module reserved for deterministic
  protocol rule enforcement. Currently pass-through.

## Cache shape

- System message includes the base template + tool docs + persona.
  Identical bytes every turn within a run → cache-stable.
- User message includes `<instructions>` at priority 250 — changes
  as the phase advances, which is expected cache-turnover territory.

If you add a per-turn-dynamic piece to `instructions.md` by mistake,
the system prompt changes every turn and the cache prefix collapses.
Put anything turn-specific in a phase file instead.
