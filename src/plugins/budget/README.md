# budget

Context ceiling enforcement.

## Design

Ceiling = `floor(contextSize × RUMMY_BUDGET_CEILING)` (default 0.9). The
10% headroom is the system's operating room for graceful overflow
handling. No per-write gating — tools run uninterrupted. Enforcement
happens at boundaries.

## Enforcement Points

1. **Pre-LLM enforce** (`hooks.budget.enforce`): checks assembled context
   before the LLM call. If over ceiling on turn 1 → Prompt Demotion
   (demote the incoming prompt, re-materialize, re-check). Runs in the
   headroom if that fits. On non-first turns or still-over after
   Prompt Demotion, returns status=413 and TurnExecutor exits the loop.

2. **Post-dispatch Turn Demotion** (`hooks.budget.postDispatch`): after
   all tools dispatch, re-materialize and check. If over ceiling →
   demote ALL promoted entries from this turn (status < 400, status
   preserved — demotion only changes visibility). Write `budget://`
   entry with the 50% rule directive. Model sees it next turn and
   adapts.

3. **LLM rejection** (`isContextExceeded` in TurnExecutor): turn-1
   token estimate drift causes LLM to reject. Same exit path as a
   pre-LLM 413.

## Files

- **budget.js** — Plugin. Enforce + postDispatch methods exposed on
  `core.hooks.budget`.

## Registration

- **Hook**: `hooks.budget.enforce` — pre-LLM ceiling check + first-turn
  Prompt Demotion.
- **Hook**: `hooks.budget.postDispatch` — post-dispatch re-check + Turn
  Demotion.
- **Scheme**: `budget://` — logging category, model-visible. `onView`
  renders body at all visibility levels (demoted shows full content).
