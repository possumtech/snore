# EXCEPTIONS.md — Documented Backbone Responsibilities

Operations that bypass the plugin protocol. Each must justify WHY it
can't go through the standard tool handler path. If the justification
is weak, the exception should be eliminated.

## Currently Identified

### 1. File.activate / File.ignore / File.drop

**What:** Direct DB writes to `file_constraints` AND promotes/demotes
entries across all runs for a project.
**Called by:** RPC `get` (persist: true), RPC `file/activate`, `file/ignore`.
**Bypasses:** Tool handler, budget check, entry.created hook, entry.changed hook.
**Root cause:** File constraints are project-level config (legitimate
backbone). But the entry promotion that follows is tool-level work that
should go through the handler chain with budget checking.
**Fix required:** Split File.activate into:
  1. `File.setConstraint()` — project config, stays in backbone
  2. Entry promotion — moves to run initialization or repo plugin,
     goes through standard tool dispatch with budget enforcement

### 2. RPC `set` scheme entries bypass tool handler

**What:** When `set` is called via RPC on a scheme path (e.g.,
`known://...`), it uses `rummy.set()` which calls `store.upsert()`
directly. File paths go through `dispatchTool()`.
**Bypasses:** Tool handler chain for scheme entries.
**Justification:** TBD — should scheme entries go through dispatchTool
the same as file entries? The handler chain may apply transformations
(hedberg parsing, patch generation) that aren't needed for direct
scheme writes.

### 3. Housekeeping loop in AgentLoop#drainQueue

**What:** Budget 413 triggers housekeeping loop enqueue in backbone code.
**Bypasses:** Plugin protocol — loop management is in AgentLoop, not a plugin.
**Justification:** TBD — can the budget plugin enqueue loops through RPC?

### 3. TurnExecutor#record — tool-specific handling

**What:** `known`, `unknown`, `summarize`, `update` have special-case
code in `#record` (dedup, slug paths, lifecycle classification).
**Bypasses:** These tools don't go through the same dispatch path as
`get`, `set`, `rm` etc.
**Justification:** TBD — are these genuinely different, or should they
be regular tool handlers?

### 4. Token math — multiple sources of truth

**What:** `known_entries.tokens`, `turn_context.tokens`,
`v_model_context.tokens`, `assembledTokens`, `turns.context_tokens`.
**Bypasses:** No single authority. Different code reads different sources.
**Justification:** None. This is a bug, not an exception.

---

*This file should shrink over time. Every entry is a debt to be paid
or a boundary to be justified.*
