# EXCEPTIONS.md — Documented Backbone Responsibilities

Operations that bypass the plugin protocol. Each must justify WHY it
can't go through the standard tool handler path. If the justification
is weak, the exception should be eliminated.

## Resolved

### File.setConstraint / File.dropConstraint

**What:** Direct DB writes to `file_constraints` table.
**Justification:** File constraints are project-level config — they
define which files a project cares about. This is backbone, not tool
dispatch. Entry promotion/demotion that follows constraints now goes
through the standard tool handler chain via `dispatchTool`.
**Boundary documented:** SPEC.md §2.3.

## Currently Identified

### 1. TurnExecutor#record — tool-specific handling

**What:** `known`, `unknown`, `summarize`, `update` have special-case
code in `#record` (dedup, slug paths, lifecycle classification).
**Bypasses:** These tools don't go through the same dispatch path as
`get`, `set`, `rm` etc.
**Justification:** Lifecycle signals (`summarize`, `update`) are state
declarations, not tool operations — they always dispatch and cannot be
409'd. `known` and `unknown` generate their own paths from body content
(slug paths). The classification is a fundamental architectural split
(lifecycle vs action), not a protocol violation.

### 2. Token math — multiple measurement points

**What:** `known_entries.tokens`, `turn_context.tokens`,
`turns.context_tokens`, `countTokens()` estimates.
**Bypasses:** No single function call, but a strict rule.
**Justification:** Each serves a different purpose. `known_entries.tokens`
is display-only (model sees entry sizes in `<knowns>`). `turn_context.tokens`
is per-turn snapshot. `turns.context_tokens` is assembled ground truth for
budget. The rule: budget decisions use ONLY assembled message tokens.
DB tokens are NEVER used for budget. Documented in PLUGINS.md §7.5.

---

*This file should shrink over time. Every entry is a debt to be paid
or a boundary to be justified.*
