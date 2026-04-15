# budget

Context ceiling enforcement.

## Design

Ceiling = `floor(contextSize × 0.9)`. The 10% headroom is the system's
operating room for graceful overflow handling. No per-write gating —
tools run uninterrupted. Enforcement happens at boundaries.

## Enforcement Points

1. **Pre-LLM enforce** (`budget.enforce`): checks assembled context
   before the LLM call. If over ceiling → Prompt Demotion (summarize
   the incoming prompt). Model runs in the headroom.

2. **Post-dispatch Turn Demotion**: after all tools dispatch, check
   context. If over ceiling → demote ALL entries from this turn
   (every scheme except `budget`/`system`/`prompt`/`instructions`,
   and 4xx error states stay promoted). Write `budget://` entry with
   directive to demote irrelevant entries and promote fewer next time.
   Model sees it next turn and adapts.

3. **LLM rejection** (`isContextExceeded`): turn-1 token estimate
   drift causes LLM to reject. Same demotion pattern.

4. **AgentLoop recovery**: pre-LLM 413 that Prompt Demotion can't
   resolve. Batch-demote all full entries, budget entry, model gets
   recovery turns. 3 strikes without progress → hard 413 to client.
   Only path where 413 reaches the client.

## Files

- **budget.js** — Plugin. Pre-LLM enforce hook.
- **BudgetGuard.js** — `BudgetExceeded` error type, `delta` utility.

## Registration

- **Hook**: `hooks.budget.enforce` — pre-LLM ceiling check.
- **Scheme**: `budget://` — logging category, model-visible. `onView`
  renders body at all fidelity levels (demoted shows full content).
