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
13 model tools: get, set, known, unknown, env, sh, rm, cp, mv,
search, summarize, update, ask_user. Tool priority ordering (get first,
ask_user last). Unified tool exclusion via `resolveForLoop(mode, flags)`.
Budget: 413 enforcement (model owns context). No auto-crunch, no death
spiral. Pre-LLM check on assembled tokens, per-entry gate at 95%
ceiling, 500-token size gate on known entries. Advisory warnings at
50% (YOU MAY) and 75% (YOU MUST). Token math: assembled tokens for
budget, DB tokens for display only — never conflated (PLUGINS.md §7.5).
Token estimation via tiktoken * 2x multiplier. Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Summarize overridden when actions fail.
Preamble: XML format, conclude every turn, summaries approximate.
PLUGINS.md: third-party developer guide, §0-§11, quickstart, payloads,
wire format. plugin_spec.test.js: 30 compliance tests. EXCEPTIONS.md:
4 documented protocol violations. SPEC.md aligned with implementation.
Paradigm audit: 26/26 complete. All protocol violations resolved.
File.activate split into setConstraint (backbone) + dispatchTool
(promotion). RPC set routes all entries through handler chain. RPC
mv, cp implemented. Unified API: all three tiers, same interface.
MAB benchmark: Conflict_Resolution row 0 = 1/100 (frontier = 7/100).

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
- [x] RPC `get` with `persist: true` — split into File.setConstraint
  (project config, backbone) + dispatchTool (entry promotion, tool
  handler chain with budget). `run` now required on all `get` RPC.
- [x] RPC `get` without `persist` — goes through `dispatchTool`. Verified.
- [x] RPC `set` — all entries (scheme and file) now go through
  dispatchTool. No more dual path. KnownStore import removed.
- [x] RPC `rm` — goes through `dispatchTool`. Verified.
- [x] RPC `mv`, `cp` — implemented. Same dispatchTool pattern as rm.
  Unified API: all three tiers have the same interface.
- [x] `File.activate` / `File.ignore` / `File.drop` — replaced with
  File.setConstraint + File.dropConstraint (project config only).
  Entry promotion/demotion moved to tool dispatch. Boundary
  documented in SPEC.md §2.3.
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
- [x] `noRepo` flag — fully plumbed in core: RPC→AgentLoop→TurnExecutor
  →RummyContext.noRepo. External repo plugin reads it (as `noContext`,
  needs rename to `noRepo`). Core implementation complete, repo
  plugin rename tracked separately.
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
- [x] Align SPEC.md with implementation — §1.2 state→status+fidelity,
  §1.3 schemes simplified, §2 loops table replaces prompt_queue,
  turns updated with loop_id/context_tokens/reasoning_content,
  §4.1 knowledge→knowns, §4.5 crunch cascade→413 enforcement,
  §4.6 crunch removed, §5.1 noContext→noRepo, search added to
  unified API, 13 tools, duplicate RUMMY_DEBUG removed.

**PLUGINS.md completeness (the guardrail):**
- [x] Quickstart: end-to-end example plugin (§0, ping tool with handler,
  view, docs, scheme registration)
- [x] Hook examples: one-liner subscribers for each event/filter in §3.3/§3.4
- [x] Payload shapes: event payloads in §3.3 table, ctx object in §3.4
- [x] RPC wire format: JSON-RPC request/response/notification in §11.1
- [x] plugin_spec.test.js: implemented §4.1 tool verbs, §4.2 query
  methods, §6 hedberg utilities, §7.5 budget enforce 413/200,
  §8.2 v_model_context visibility, §8.3 stored fidelity hidden.
  30 tests passing. Remaining: §2.2/§2.3 (need full dispatch
  integration), §11.1 (need RPC integration).
- [x] entry.changed: fires through full pipeline. KnownStore.onChanged
  wired to hooks.entry.changed.emit() in ProjectAgent and TestDb.
  Plugin spec §7.4.1-§7.4.4 verify upsert/fidelity/remove events.
- [x] Verify every hook listed in PLUGINS.md is both emitted AND
  subscribable — all §7.1-§7.4 hooks verified. `ui.render`/`ui.notify`
  are subscribable but emitted by external plugins only (acceptable).
  `run.config` filter defined but never invoked (future use).

**All audit items resolved. Protocol alignment complete.**

**Remaining exceptions (documented in EXCEPTIONS.md):**
- TurnExecutor#record lifecycle/action split — justified architectural
  boundary, not a protocol violation.
- Token math multiple measurement points — strict rule documented in
  PLUGINS.md §7.5, not a bug.

**Future work:**

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

## Done: Session 2026-04-09 — Paradigm Audit

22/26 audit items resolved. Backbone files unchanged in size.
+1305/-994 lines across 27 files (net +311, mostly tests and docs).

- **Dead code removed**: crunch plugin (111 lines), cascade.summarize
  hook, get_promoted_token_total SQL query.
- **SPEC.md realigned**: §1.2 status+fidelity replaces state, §1.3
  schemes simplified, §2 loops table replaces prompt_queue, §4.5
  budget 413 enforcement replaces crunch/death spiral, §4.6 crunch
  removed. noContext→noRepo. 13 tools (was 12).
- **PLUGINS.md completed**: §0 quickstart (end-to-end ping plugin),
  §3.3/§3.4 hook examples + payload shapes + ctx object, §11.1 wire
  format examples, §11.2-§11.5 complete RPC listings with store,
  getEntries, startRun, run/inject, removeModel, getRun.
- **EXCEPTIONS.md created**: 4 documented protocol violations with
  justifications and fix paths.
- **plugin_spec.test.js**: 30 section-numbered compliance tests.
  §1 contract, §2 unified API, §3 registration (ensureTool, scheme,
  handler auto-register, docsMap, views), §4 tool verbs + query
  methods on RummyContext, §5 tool order + mode exclusions, §6
  hedberg utilities, §7 hooks exist + entry events + budget enforce,
  §8 entry lifecycle + visibility + stored hidden.
- **Token math audited**: three sources (known_entries.tokens,
  turn_context.tokens, turns.context_tokens), all consistent, no
  conflation. Budget uses only assembled tokens. Documented in §7.5.
- **entry.changed verified**: KnownStore.onChanged → hooks pipeline.
  Fires on upsert, fidelity change, remove. Wired in ProjectAgent
  and TestDb.
- **All hooks verified**: every PLUGINS.md hook is both emitted and
  subscribable. ui.render/ui.notify are extension points for external
  plugins. run.config filter exists for future use.
- **noRepo plumbed**: RPC→AgentLoop→TurnExecutor→RummyContext.noRepo.
  External repo plugin needs noContext→noRepo rename (separate repo).

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
- Bulk operation aggregation (one entry per pattern operation)
- Non-git file scanner fallback
- rummy.repo: rename `noContext` → `noRepo` (one-line change)
