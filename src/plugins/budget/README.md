# budget

Context ceiling enforcement and panic mode recovery.

## Files

- **budget.js** — Plugin. Pre-LLM enforce, BudgetGuard activation,
  panic prompt generation.
- **BudgetGuard.js** — Write-layer gate. Installed on KnownStore during
  dispatch. Checks token delta on every upsert, promote, and body update.

## Registration

- **Hook**: `hooks.budget.enforce` — pre-LLM ceiling check.
- **Hook**: `hooks.budget.activate(store, contextSize, assembledTokens)` — install guard.
- **Hook**: `hooks.budget.deactivate(store)` — remove guard.
- **Hook**: `hooks.budget.panicPrompt({ shortfall, assembledTokens, contextSize })` — generate panic prompt.

## Budget Contract

`contextSize` is the ceiling. `countTokens()` is the measurement.
Over = 413. Under = 200. No margins.

## BudgetGuard

Installed on KnownStore by TurnExecutor before dispatch, cleared in
`finally`. Gates `upsert()`, `promoteByPattern()`, `updateBodyByPattern()`.

Exemptions: `status >= 400` (error entries), `model_visible = 0` (audit),
`fidelity = "stored"` (not in context).

On first violation: `BudgetExceeded` thrown, guard trips, all subsequent
writes fail. TurnExecutor catches per-tool, writes 413 result entry.

## Panic Mode

When a new prompt exceeds the ceiling, AgentLoop enqueues a panic loop.
The model receives the exact shortfall and must free space using core
tools (get, set, known, unknown, rm, mv, cp, summarize, update).
Excluded: sh, env, search, ask_user.

Strike system: 3 consecutive turns without context reduction = hard 413.
Any reduction resets the counter. One panic attempt per drain cycle.
