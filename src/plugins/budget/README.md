# budget

Context ceiling enforcement.

## Files

- **budget.js** — Plugin. Pre-LLM enforce, BudgetGuard activation.
- **BudgetGuard.js** — Write-layer gate. Installed on KnownStore during
  dispatch. Checks token delta on every upsert, promote, and body update.

## Registration

- **Hook**: `hooks.budget.enforce` — pre-LLM ceiling check.
- **Hook**: `hooks.budget.activate(store, contextSize, assembledTokens)` — install guard.
- **Hook**: `hooks.budget.deactivate(store)` — remove guard.

## Budget Contract

`contextSize` is the ceiling. `countTokens()` is the measurement.
Over = 413. Under = 200. No margins.

## BudgetGuard

Installed on KnownStore by TurnExecutor before dispatch, cleared in
`finally`. Gates `upsert()`, `promoteByPattern()`, `updateBodyByPattern()`.

Exemptions: `status >= 400` (error entries), `model_visible = 0` (audit),
`fidelity = "archive"` (not in context).

On first violation: `BudgetExceeded` thrown, guard trips, all subsequent
writes fail. TurnExecutor catches per-tool, writes 413 result entry.
