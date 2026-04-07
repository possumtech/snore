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
Budget enforcement demotes oldest full entries to summary when context
exceeds 95% of the model's window. Token estimation via tiktoken * 2x
multiplier for cross-model safety. Glob matching via picomatch.
160 unit + 92 integration passing. 12/13 e2e (unknown investigation
flaky — model sends ask_user instead of investigating). Live tests
need rerun.

## Todo: Proposal Lifecycle Refactor

The model sends multiple commands in one response. Some go to 202
(proposed). The resolve path handles them one at a time. Bugs:

- `<rm>file` + `<summarize>deleted` — rm proposes, summarize claims
  success. Mitigated by overriding summarize when proposals exist.
- Rejected proposals don't invalidate dependent entries.
- Interleaved proposals resolved independently but may be coupled.

Needs design before code.

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
- **Error feedback**: Get, store, rm return labeled errors on missing
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
