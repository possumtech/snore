# instructions {#instructions_plugin}

Projects the model-facing instructions into the assembled packet.
Split into a stable system-side base and a per-turn user-side
imperative reminder so prompt caching holds across turns within a
run.

## Registration

- **Hook**: `hooks.instructions.resolveSystemPrompt` (single-owner;
  see AGENTS.md "Architectural exceptions") — resolves the system
  prompt: `instructions-system.md` text + `[%TOOLS%]` + `[%TOOLDOCS%]`
  + persona body. Cache-stable across all turns within a run.
- **Event**: `turn.started` — writes `instructions://system` entry
  with `{ persona, toolSet }` attributes (audit record only).
- **Filter**: `instructions.toolDocs` — gathers `*Doc.md` content
  from all tool plugins into a docsMap keyed by tool name. Skill
  plugin extends this filter to inject loaded skill docs.
- **Filter**: `assembly.user` (priority 165) — renders
  `instructions-user.md` as `<instructions>` late in the user
  message, between `<unknowns>` (150) and `<budget>` (175). The
  user message is a sandwich: `<prompt>` (30) leads for cache
  stability, dynamic state fills the middle, then rules and
  budget close out so the action site sees them with recency.

## Files

- `instructions.js` — plugin registration and assembly logic.
- `instructions-system.md` — the system-side base. Static within a
  run; identity + `[%TOOLS%]` + `[%TOOLDOCS%]` placeholders. The
  persona body is appended below at resolve time.
- `instructions-user.md` — the per-turn imperative reminder
  rendered as `<instructions>` in the user message. Same bytes
  every turn.
- `protocol.js` / `protocol.test.js` — pass-through stub on
  `entry.recording` (priority 1) reserved for future
  deterministic protocol rule enforcement.

## Cache shape

- System message (resolved by `resolveSystemPrompt`) includes
  `instructions-system.md` + tool docs + persona. Identical bytes
  every turn within a run → cache-stable.
- User message includes `<instructions>` at priority 165 — same
  bytes every turn, but placed AFTER the dynamic state blocks so
  it can't extend the per-turn cache prefix. The cache-stable
  prefix is system + `<prompt>` (priority 30); recency on the
  rules at the action site is the trade.

If you add a per-turn-dynamic piece to `instructions-system.md` by
mistake, the system prompt changes every turn and the cache prefix
collapses. Per-turn content belongs in `instructions-user.md` (or
in a dedicated assembly plugin at the appropriate priority).
