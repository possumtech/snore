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
- **Filter**: `assembly.user` (priority 165) — renders
  `instructions-user.md` as `<instructions>` late in the user
  message, between `<unknowns>` (150) and `<budget>` (175). The
  user message is a sandwich: `<prompt>` (30) leads for cache
  stability, dynamic state fills the middle, then rules and
  budget close out so the action site sees them with recency.

## Files

- `instructions.js` — plugin registration and assembly logic.
- `instructions.md` — the system-side base template. Static across
  turns; only identity + `[%TOOLS%]` + `[%TOOLDOCS%]` placeholders.
- `instructions_104.md` … `instructions_108.md` — phase-specific
  directives keyed by the 1XY status encoding (Decompose / Distill /
  Demote / Deploy / Resolve). `_108` is currently an empty
  placeholder reserved for the Resolution stage.
- `protocol.js` — placeholder module reserved for deterministic
  protocol rule enforcement. Currently pass-through.

## Navigation validation

`validateNavigation(status, rummy)` rejects illegal stage transitions
emitted via `<update status="N">`:

- **Forward skip** — `nextPhase > currentPhase + 1`. Models advancing
  more than one stage at once are jumping past required work. Returns
  and continuations (`nextPhase ≤ currentPhase`) always pass.
- **Status 200 outside Deployment** — 200 is Deployment Completion.
  Emitting it from earlier phases skips the actual Deployment work.
- **Deployment with prior prompts** — entering or remaining in
  Deployment (phase 7) requires zero visible PRIOR prompts. Covers
  167 (entry), 177 / 200 (continuation, completion).

On rejection the update entry is marked `rejected` (the phase router
skips it) and an error log is emitted; rejections count as normal
strikes.

## Cache shape

- System message includes the base template + tool docs + persona.
  Identical bytes every turn within a run → cache-stable.
- User message includes `<instructions>` at priority 165 — same
  bytes every turn (no phase keying), but placed AFTER the dynamic
  state blocks so it can't extend the per-turn cache prefix. The
  cache-stable prefix is system + prompt (~2K tokens); recency on
  the rules at the action site is the trade.

If you add a per-turn-dynamic piece to `instructions.md` by mistake,
the system prompt changes every turn and the cache prefix collapses.
Put anything turn-specific in a phase file instead.
