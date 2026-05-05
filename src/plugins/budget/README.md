# budget {#budget_plugin}

Context ceiling enforcement.

## Design

Ceiling = `floor(contextSize × RUMMY_BUDGET_CEILING)` (default 0.9). The
10% headroom is the system's operating room for graceful overflow
handling. No per-write gating — tools run uninterrupted. Enforcement
happens at boundaries.

## Enforcement Points

1. **Pre-LLM enforce** (`turn.beforeDispatch` filter): checks the
   assembled dispatch packet before the LLM call. If over ceiling on
   turn 1 → Prompt Demotion (demote the incoming prompt entry, swap
   `body` from `vBody` to `sBody` on the local row, re-run the
   assembler). Runs in the headroom if that fits. On non-first turns
   or still-over after Prompt Demotion, sets `ok=false` on the packet
   so TurnExecutor short-circuits dispatch and emits a 413 error via
   `hooks.error.log.emit`.

2. **Post-dispatch Turn Demotion** (`turn.dispatched` event): after
   all tools dispatch, re-materialize and project the next-turn
   packet. If predicted next packet exceeds ceiling → demote ALL
   visible entries from this turn (status < 400, status preserved —
   demotion only changes visibility). Emits a 413 error with the
   demoted-paths body via `hooks.error.log.emit`; the error entry is
   what the model sees next turn.

3. **LLM rejection** (`isContextExceeded` in TurnExecutor): turn-1
   token estimate drift causes LLM to reject. Same 413 error path as
   pre-LLM overflow.

## Files

- **budget.js** — Plugin. Math (`ceiling`, `measureMessages`,
  `measureRows`, `computeBudget`), 413 body shaper (`overflowBody`),
  and the plugin class itself. The plugin subscribes via the standard
  hook surface — no named-method registration on `core.hooks.budget`.

## Hook participation

- `core.filter("turn.beforeDispatch", ...)` — pre-LLM ceiling check
  on the dispatch packet. Returns the (possibly demoted) packet with
  `ok` / `overflow` flags.
- `core.on("turn.dispatched", ...)` — post-dispatch Turn Demotion +
  413 emission. Other plugins may subscribe for unrelated post-
  dispatch concerns; budget does not own the event.
- `core.filter("assembly.user", ..., 175)` — renders the `<budget>`
  table into the user message.

Emits 413 errors through the unified error channel (`hooks.error.log.emit`);
there is no separate `budget://` scheme.
