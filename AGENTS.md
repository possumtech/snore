# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
No monolithic assembler. Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).
9 model tools (store removed — fidelity control via set attributes).
Budget enforcement demotes oldest full entries to summary when context
exceeds 95% of the model's window. Token estimation via tiktoken * 2x
multiplier for cross-model safety. Glob matching via picomatch.
160 unit + 92 integration passing. 12/13 e2e (unknown investigation
flaky — model sends ask_user instead of investigating). Live tests
need rerun.

## Todo: Budget Cascade — Context Guarantee

The budget engine must guarantee that materialized context never exceeds the
model's context window. Context overflow is structurally impossible.

### Floor

The irreducible minimum context. Validated at run creation — if the model's
context can't hold the floor, reject the run before the first turn.

Floor = system prompt + tool docs + stash entries (one per scheme with stored
content) + user prompt (`<ask>`/`<act>` tag) + progress block.

### Cascade

Each tier is a deterministic transformation that strictly reduces token count.
Applied in order until re-render verifies budget is met. Batch demotion —
estimate which entries to demote in one pass (target 110% of excess), re-render
once to verify. Second pass if math was off, but rare.

**Tier 1: Full → summary.** Collapse full entries to summary (symbols +
contextual description) by demotion priority (scheme tier, then oldest first).

**Tier 2: Summary → index.** Collapse summaries to bare paths. Path-only
entries cost ~5 tokens each.

**Tier 3: Index → stash.** Collapse all index entries per scheme into a single
stash entry — a list of paths. `known://stash` contains
`auth_flow, session_store, db_adapter, ...`. Hundred entries become one.

**Tier 4: Hard error.** Floor + stashes don't fit. Configuration error —
the model's context window is too small to operate. Reject at run creation.

### Implementation

1. Materialize all candidates from `v_model_context`
2. Render full message through assembly filter chain
3. Measure assembled tokens via `countTokens()` on final strings
4. If over budget: batch-demote tier 1 candidates, re-render, re-measure
5. If still over: tier 2, re-render, re-measure
6. Continue through tiers until budget met
7. Never subtract estimated savings — always re-render and re-measure

The re-render is cheap (string concatenation). The LLM call is expensive.
Spending 5ms on 3 re-renders to guarantee no $0.05 wasted 500 error is
the correct tradeoff.

### Token Accounting

Single source of truth: `countTokens()` on the final assembled message
strings. No estimates, no per-entry overhead calculations, no disconnect
between what's measured and what's sent. The assembled message IS the
measurement.

Entry-level `tokens` column in `known_entries` and `turn_context` used
only for demotion candidate estimation (which entries to batch-demote).
Never used as the authority on whether the budget is met.

---

## Todo: Proposal Lifecycle — Remaining Work

Sequential dispatch implemented: commands execute one at a time.
On 202 (proposed) or >= 400 (error), remaining commands abort with
409 and context message. Get handler returns 413 when files would
exceed context budget.

Remaining:
- [ ] Integration test for sequential abort behavior
- [ ] E2E test: model sends rm + summarize, rm rejected, verify
  model sees rejection + aborted summarize on next turn

## Todo: Repetition Detection — Get Handler Dedup

When the model sends `<get path="lua/*.lua">` AND individual
`<get>lua/init.lua</get>` in the same response, files promote
twice. The overhead is minimal (promotion is idempotent) but
receipt entries accumulate. Low priority.





## Todo: Test Improvements

- [x] E2E test diagnostic DBs persist to /tmp/rummy_test_diag/
- [x] Integration test for scheme registration via plugins (8 tests)
- [x] Ask mode restrictions (already covered in mode_enforcement.test.js)
- [x] Sed chaining (already covered in XmlParser.test.js)
- [ ] Fix set handler integration tests (path normalization mismatch
  between test setup `set://src%2F...` and handler's `set://src/...`)
- [ ] Live tests need rerun for HTTP status code migration

## Done: Session 2026-04-06/07 (continued)

- **Skill plugin**: Class renamed `Skill`, turn 0 for init-time writes.
- **XmlParser → Hedberg**: JSON edit parsing moved to `hedberg/normalize.js`.
  `resolveCommand` delegates all format detection to hedberg functions.
- **Native tool call normalization**: Qwen `<|tool_call>` and OpenAI
  `function_call` JSON silently translated to rummy XML in XmlParser.
- **Repetition detection**: Update text fingerprinting (same 3 turns =
  force-complete). Known entry dedup (80-char prefix match reuses path).
- **File scheme documented**: NULL scheme exception explained in file.js.
- **ResponseHealer**: Already clean 134 lines. No split needed.
- **TurnExecutor thinning**: Already done — audit writes in telemetry plugin.
- **Scheme registration**: All tool plugins register. Audit schemes bootstrapped.

## Done: Session 2026-04-06/07

- **Loops table**: projects > runs > loops > turns. Replaced prompt_queue.
  Summary/rejection checks scoped to current loop.
- **HTTP status codes**: `state TEXT` → `status INTEGER` + `fidelity TEXT`.
  Runs, loops, entries, client RPC — all integer codes. Schemes table
  simplified (no valid_states, no fidelity column). External plugins
  and rummy.nvim client migrated.
- **Budget enforcement**: Post-assembly token check demotes oldest full
  entries to summary. Token estimation via tiktoken * 2x multiplier.
  Progress section warns model. `<known ... demoted>` flag per-turn.
  Runtime context from llama.cpp `/props` endpoint.
- **Glob matching**: picomatch replaces hand-rolled globToRegex. Proper
  `**` recursive matching. Single `*` respects directory boundaries.
- **XmlParser recovery**: Known tool opening while another is current
  closes the old one. Mismatched close tags don't swallow commands.
- **Plugin loader**: Global package resolution for RUMMY_PLUGIN_* env
  vars. Local then global — no fallback, explicit error.
- **Phantom tool cleanup**: `ensureTool` only from `on("handler")`.
  File plugin no longer appears in model tool list.
- **Error feedback**: Get, set, rm return labeled errors on missing
  path (400). Rm returns 404 on no match. Path normalization for
  unencoded URIs.
- **Tool docs distributed**: Advanced patterns section removed from
  hedberg. Each tool's docs show globs, preview, body filters inline.
- **Known docs**: "entries are your memory — you forget everything else"
- **Unknowns show paths**: `<unknown path="...">` so model can rm by URI.
- **Env docs**: "Do not use env to read or list files — use get path=* preview"
- **Previous loop context**: Prompts from previous loops shown in
  `<previous>`. Assembly uses entry's own fidelity, not hardcoded.
- **File.activate promotion**: Immediately promotes matching entries,
  symmetric with File.ignore demote.
- **getEntries fidelity**: Server response includes fidelity field.
  Client uses fidelity for buffer visibility marking.
- **Set docs**: "literal SEARCH/REPLACE blocks", better error messages.
- **Rm docs**: `known://donald-rumsfeld-was-born-in-1932` example.
- **Env handler**: 202 (proposed) instead of 200 (immediate).
- **Context tokens telemetry**: Per-turn context_tokens in run/state
  for accurate statusline display.
- **rummy.nvim audit**: Status codes migrated, getEntries fidelity
  mapping, uppercase in run/rename, turn_tokens for statusline.

## Done: Earlier Sessions

- Plugin architecture refactor (18 plugins, constructor(core) pattern)
- xAI integration (Responses API)
- Hedberg plugin (patterns, matcher, sed, edits, normalize)
- Packet restructuring (system/user split, assembly filters)
- Cleanup (removed defaults, fallbacks, legacy code)

## Deferred

- Relevance engine (stochastic, separate project/plugin)
- Hedberg extraction to `@possumtech/rummy.hedberg` npm package
- Janitor plugin (deterministic context budget management)
- Bulk operation aggregation (one entry per pattern operation)
- Non-git file scanner fallback
- Separate state from fidelity (already done via HTTP codes — the
  original concern about conflation is resolved. Fidelity is its own
  column, status is HTTP codes, schemes don't constrain fidelity.)
