# budget {#budget_plugin}

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
   Prompt Demotion, emits a 413 error via `hooks.error.log` so the
   strike system treats the overflow as a turn-level event.

2. **Post-dispatch Turn Demotion** (`hooks.budget.postDispatch`): after
   all tools dispatch, re-materialize and check. If over ceiling →
   demote ALL visible entries from this turn (status < 400, status
   preserved — demotion only changes visibility). Emits a 413 error
   with the 50% rule directive as its message; the error entry is
   what the model sees next turn.

3. **LLM rejection** (`isContextExceeded` in TurnExecutor): turn-1
   token estimate drift causes LLM to reject. Same 413 error path as
   pre-LLM overflow.

## Files

- **budget.js** — Plugin. Enforce + postDispatch methods exposed on
  `core.hooks.budget`.

## Registration

- **Hook**: `hooks.budget.enforce` — pre-LLM ceiling check + first-turn
  Prompt Demotion.
- **Hook**: `hooks.budget.postDispatch` — post-dispatch re-check + Turn
  Demotion. Emits 413 errors through the unified error channel; there
  is no separate `budget://` scheme.
