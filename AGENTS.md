# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

> **"Model behavior" is never an acceptable explanation for a test failure.**
> When a model misbehaves, the system failed — suboptimal context, poorly
> designed test conditions, insufficient reinforcement of correct behavior.
> Every failure is a system bug until proven otherwise. Investigate the
> context the model saw, the instructions it was given, and the constraints
> it was operating under. If you can't explain exactly why the model did
> what it did, you haven't finished debugging.

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
No monolithic assembler. Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).
12 model tools: get, set, known, unknown, env, sh, rm, cp, mv,
search, summarize, update. Tool priority ordering (get first,
ask_user last). Unified tool exclusion via `resolveForLoop(mode, flags)`.
Budget cascade: two-phase crunch spiral (upfront LLM summary + halving)
+ death spiral (stash by scheme) + crash. No scheme-based tiers.
Selection: fattest half of oldest half. Protected: system, tool, prompt.
Crunch plugin generates ≤80-char keyword summaries. ToolRegistry.view()
prepends summaries above plugin output at summary fidelity.
Token estimation via tiktoken * 2x multiplier. Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Summarize overridden when actions fail.
Preamble: XML format, conclude every turn, summaries approximate.
175 unit + 121 integration + 14/15 e2e passing (gemma).
MAB benchmark: Conflict_Resolution row 0 = 1/100 (frontier = 7/100).
Ingestion working: atomic entries, no duplication, 100% crunch success.
Retrieval from stashed entries is the bottleneck.

## Paradigm Refactoring — Unified Plugin Protocol

The budget/housekeeping work exposed systemic drift from the plugin
protocol. RPC calls bypass tool handlers. File operations bypass budget.
Token math means different things in different places. The codebase has
too many special paths for anyone to reason about.

**Goal:** Every operation — model, client, plugin — flows through the
same tool handler with the same budget enforcement. No exceptions that
aren't documented in EXCEPTIONS.md with clear justification.

**Approach:**
1. Audit every code path against PLUGINS.md's Unified API contract
2. Document each violation in EXCEPTIONS.md (justify or fix)
3. Update PLUGINS.md to be the third-party-facing truth
4. Keep SPEC.md aligned with implementation
5. Checklist progress here in AGENTS.md

**Audit checklist:**
- [ ] RPC `get` with `persist: true` — calls `File.activate` directly,
  bypasses tool handler and budget. Must go through the same path as
  model `<get>`.
- [x] RPC `get` without `persist` — goes through `dispatchTool`. Verified.
- [ ] RPC `set` — scheme entries bypass tool handler (uses rummy.set()
  directly). File entries go through dispatchTool. Inconsistent.
- [x] RPC `rm` — goes through `dispatchTool`. Verified.
- [ ] RPC `mv`, `cp` — no RPC handlers exist. PLUGINS.md lists them
  but clients can't use them. Either implement or remove from docs.
- [ ] `File.activate` / `File.ignore` / `File.drop` — direct DB calls,
  no tool handler, no budget check
- [x] `known_entries.tokens` vs assembled tokens — audited. Budget gate
  in TurnExecutor uses assembled tokens (correct). get.js uses
  tokens_full for incoming entries (correct — represents full-fidelity
  cost) + get_last_context_tokens for current usage (correct).
  Progress fallback uses row token sum (display only, acceptable).
  Rule documented in PLUGINS.md §7.5.
- [x] `get_promoted_token_total` query — REMOVED. Dead SQL, no callers.
- [x] TurnExecutor `#record` budget gate — uses `countTokens(cmd.body)`
  estimate at 95% ceiling. Conservative (2x tiktoken multiplier).
  Secondary safety net; real budget enforcement is pre-LLM via
  budget.enforce() on assembled messages. Acceptable.
- [ ] `noRepo` flag — passed through but never read. Disables default
  project/repo file scanning. Files can still be added explicitly by
  the client. Core and rummy.repo should skip auto-loading project
  files when set. Needs implementation.
- [x] Crunch plugin — REMOVED. Dead code. cascade.summarize hook removed.
- [x] `v_model_context` token calculation vs `turn_context` tokens vs
  `known_entries` tokens — three sources, three meanings, all consistent.
  known_entries.tokens = display-only fidelity-aware counts.
  turn_context.tokens = recalculated after projection (per-turn snapshot).
  turns.context_tokens = assembled message tokens (ground truth).
  No code uses view tokens for budget. Rule in PLUGINS.md §7.5.
- [x] Housekeeping loop in `#drainQueue` — removed from backbone.
  413 retry with housekeeping enqueue remains (correct pattern).
- [x] `summarize` 413 rejection in TurnExecutor — removed.
  Future: budget plugin handles via entry.changed hook.
- [x] Progress plugin token math — uses `ctx.lastContextTokens` from
  turns.context_tokens (assembled ground truth). Fallback to row token
  sum only on turn 1 (no prior data). Display only, never budget.
- [x] EXCEPTIONS.md created with documented backbone responsibilities
- [x] PLUGINS.md updated with numbered sections, comprehensive API
- [x] plugin_spec.test.js created with section-numbered compliance tests
- [ ] Align SPEC.md with implementation

**PLUGINS.md completeness (the guardrail):**
- [ ] Quickstart: end-to-end example plugin (register, handle, render, docs)
- [ ] Hook examples: one-liner subscriber for each event/filter
- [ ] Payload shapes: formalize every hook's payload as typed object
- [ ] RPC wire format: show actual JSON-RPC request/response examples
- [ ] plugin_spec.test.js: implement all TODO tests (§2.2, §2.3, §4.1,
  §4.2, §6, §7.4 full pipeline, §7.5, §8 full lifecycle, §11.1)
- [ ] entry.changed: verify fires through full plugin pipeline, not
  just KnownStore callback
- [ ] Verify every hook listed in PLUGINS.md is both emitted AND
  subscribable (no dead hooks)

**After refactoring is complete:**

### Future: Budget Enforcement
- Budget plugin: 413 on every tool use that would exceed context
- Universal: model tools, client RPC, and plugin calls all checked
- Measurement: full materialization after each tool, not DB estimates
- No crashes: all violations are 413 rejections with token math

### Future: Housekeeping Loop
- Budget plugin enqueues housekeeping loop when next prompt won't fit
- 3 loops max, 3 summarize rejections per loop
- 413 to client if model can't free enough
- Implemented as a plugin, not backbone code

### Future: Benchmarking (MAB + LME)
- Runners are clean and separate — no changes needed
- Re-run after refactoring to measure improvement
- Model cooperation with budget is the remaining challenge

## Done: Session 2026-04-06/07 (continued)

- **`<store>` tool removed**: Fidelity control via `<set>` attributes:
  `stored`, `summary`, `index`, `full`. Direct-to-storage writes:
  `<set path="..." stored>content</set>`. 10 tools → 9.
- **`summary="..."` attribute**: Model-authored descriptions (<= 80 chars)
  persist across fidelity changes. Rendered as header in all views:
  `# <set summary="..."/>`. Falls back in ToolRegistry when no summary
  view is registered. The model describes files as it reads them —
  no janitorial pass needed.
- **Tool tags in previous/current**: Results render as `<set path="...">`
  not `<tool path="set://...">`. The history teaches the invocation syntax.
- **Native tool call normalization**: Qwen, OpenAI, Anthropic, Mistral
  formats silently translated to rummy XML in XmlParser.
- **Skill plugin**: Class renamed `Skill`, turn 0 for init-time writes.
  Persona extracted to own plugin (`persona/persona.js`).
- **XmlParser → Hedberg**: JSON edit parsing moved to `hedberg/normalize.js`.
- **Repetition detection**: Update text fingerprinting (same 3 turns =
  force-complete). Known entry dedup (80-char prefix match reuses path).
- **File scheme documented**: NULL scheme exception explained in file.js.
- **Scheme registration**: All tool plugins register. Audit schemes bootstrapped.
- **URI length cap**: 2048 chars max on known_entries.path.

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
