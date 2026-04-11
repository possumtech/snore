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
Budget: BudgetGuard at KnownStore layer gates every write during
dispatch. Pre-LLM check on assembled tokens. contextSize is the
ceiling, no margins. Token math: `ceil(text.length / RUMMY_TOKEN_DIVISOR)`.
No tiktoken. Panic mode: new prompt exceeds ceiling → model gets
restricted loop to free space, 3 strikes without reduction → hard 413.
500-token size gate on known entries. Advisory warnings at 50%/75%.
Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Both sent → update wins. Summarize
overridden when actions fail. `<think>` tag for model reasoning.
Preamble: XML format, conclude every turn, summaries approximate.
Four entry roles: data (knowns), logging (current/previous), unknown,
prompt. Default category: logging. `<prompt mode="ask|act">` replaces
`<prompt mode="ask|act">`. Each plugin owns its own views.
PLUGINS.md: third-party developer guide, §0-§11, quickstart, payloads,
wire format. plugin_spec.test.js: 30 compliance tests.
Hooks: tool.before/after, entry.recording filter, turn.completed,
loop.started/completed, run.created, context.materialized.
Paradigm audit: 26/26 complete. All protocol violations resolved.
Unified API: all three tiers, same interface. File.activate split
into setConstraint (backbone) + dispatchTool (promotion).
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
  →RummyContext.noRepo. All repos aligned (core, rummy.repo, rummy.nvim).
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
  §8.2 v_model_context visibility, §8.3 archive fidelity hidden.
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

### Future: Benchmarking (MAB + LME)
- Runners are clean and separate — no changes needed
- Re-run after budget enforcement to measure improvement
- Model cooperation with budget is the remaining challenge

### Future: Smart Housekeeping (Step 3)
- Model makes informed decisions about what to demote
- Guided by progress warnings at 50%/75%
- Step 3 of ENFORCED → FUNCTIONAL → SMART

## Done: Session 2026-04-09/10 — Budget Enforcement + Paradigm Shift

- **Budget enforcement (Project 413)**: BudgetGuard at KnownStore
  layer. Every write gated during dispatch. Delta calculation for
  updates. Exemptions: status>=400, model_visible=0, archive fidelity.
  Trip cascade: one tool exceeds → all subsequent fail.
- **Panic mode**: New prompt exceeds ceiling → panic loop with
  restricted tools, strike system (3 strikes without reduction →
  hard 413), re-enqueue original prompt after panic. mode="panic"
  in loops table.
- **Four entry roles**: data, logging, unknown, prompt. Categories
  hardcoded in PluginContext.CATEGORIES (frozen Set). Default: logging.
  registerScheme() rejects invalid categories.
- **`<prompt mode="ask|act">`**: Unified ask/act into one scheme.
  prompt:// with mode attribute.
- **`<think>` tag**: Model reasoning. model_visible=0, logging category.
- **Token math simplified**: tiktoken removed. `ceil(text.length /
  RUMMY_TOKEN_DIVISOR)`. Env-configurable. No external dependencies.
- **Update wins over summarize**: If model sends both, it's not done.
- **Automatic RPC**: All registered tools callable via RPC. Third-party
  plugins get RPC for free via tool fallback on RpcRegistry.
- **Hook expansion**: tool.before/after, entry.recording filter,
  turn.completed, loop.started/completed, run.created,
  context.materialized, panic.started/completed.
- **Plugin loader**: Timeout protection (10s). Absolute path support.
- **External plugin alignment**: noContext→noRepo across all repos.
  rummy.repo: external file change diffs via set:// entries.
- **Documentation**: All plugin READMEs rewritten. SPEC.md, PLUGINS.md
  aligned. Four roles documented.
- **Tests**: 186 unit + 157 integration + 14 E2E.

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

---

# Packet SDI Review

> Exhaustive audit of packets (system/user messages) sent to the model.
> Every item here is an opportunity to improve model behavior.
> Source: packet log analysis + code review, 2026-04-10.
> **[fixed]** = resolved in this session. Remaining items are open.

## Category 1: Obvious Errors
*Silent data loss, broken math, crashes. Fix immediately.*

- [x] **E-1** *(was SDI-1 + SDI-20)* `<think>` not in `ALL_TOOLS` — **fixed**: `"think"` added to `ALL_TOOLS` in `XmlParser.js`. The `TurnExecutor` filter for `c.name === "think"` now yields results. DeepSeek-R1 and similar in-band thinking models now have their `<think>` blocks parsed as commands rather than falling through to `unparsed`.

- [x] **E-2** *(was SDI-2)* `RUMMY_TOKEN_DIVISOR` unguarded — **fixed**: `tokens.js` now throws on boot if `DIVISOR` is falsy. `Number("")` = `0`, `Number(undefined)` = `NaN`; both were silent and produced `Infinity`/`NaN` tokens throughout budget math.

- [x] **E-3** *(was SDI-4)* `known.js` handler omits `loopId` — **fixed**: `loopId` is now destructured from `rummy` and passed to `store.upsert`. `has_rejections` and `get_latest_summary` loop-scoped queries now see `known` entries.

- [x] **E-4** *(was SDI-6)* `afterTokens` uses hardcoded divisor `4` — **fixed**: `set.js` now imports and calls `countTokens(patch)`. The hardcoded `(patch.length / 4) | 0` was using a fixed divisor that could be off by 2× depending on `RUMMY_TOKEN_DIVISOR`.

- [x] **E-5** *(was SDI-12)* `generatePatch` calls `execSync(diff ...)` — **fixed**: `hedberg/matcher.js` now uses the pure-JS `diff` library (`createTwoFilesPatch`). No more temp files, no more blocking `execSync`, no more `writeFileSync` on the hot path.

- [x] **E-6** *(was P-SDI-4)* 409 "aborted" errors invisible — **fixed**: `TurnExecutor` now writes the error message string into the entry body, not just `attributes.error`. Model now sees `<env ...>Aborted — preceding <sh> requires resolution.</env>` rather than a silent empty body.

- [x] **E-7** *(was SDI-5)* `#rematerialize` in `TurnExecutor` is dead code — **fixed**: deleted. — the private method (lines ~706–734) duplicates the materialization block in `execute()` but is never called. It also lacks the `loopId` it would need to match the live path. Fix: delete it.

- [x] **E-8** *(was SDI-10)* `service.js` uses `var` — **fixed**: hoisted to `let` in the outer declaration. — `service.js` line 27: `var initPlugins = pluginIndex.initPlugins` inside a `try` block to hoist scope past `catch`. Only `var` in the codebase. Fix: restructure the import with `const`.

- [x] **E-9** *(was SDI-16)* `v_model_context` hardcodes category — **fixed**: `visible` CTE now uses `COALESCE(s.category, 'logging')` from the `schemes` table join; the hardcoded CASE/WHEN mapping is removed. — the `CASE scheme` block (lines 50–58 of `v_model_context.sql`) hardcodes `known`, `skill`, `http`, `https` → `data` and everything else → `logging`. A third-party plugin registering `category: "data"` in its scheme is silently misclassified. Fix: join `schemes` in the `projected` CTE and use `s.category`.

- [x] **E-10** *(was SDI-19)* `Set.#buildRevision` drops all but first block — **fixed**: `#buildRevision` now stores `{ blocks: attrs.blocks }` (full array); `#applyRevision` iterates all blocks sequentially. Single-block path unchanged (preserves `searchText`/`replaceText` for merge notation). — returns `{ search: attrs.blocks[0].search, replace: attrs.blocks[0].replace }` and silently loses blocks 1…N. Multi-block `<<<SEARCH/REPLACE>>>` edits via the revision queue apply only the first hunk. Fix: store the full blocks array; `#materializeRevisions` iterates all of them.

- [x] **E-11** *(was P-SDI-3)* `<current>` double-projects via `full()` — **fixed**: `renderToolTag` in `current.js` now uses `entry.body` directly (already projected by TurnExecutor). The `view()` call is removed. — `TurnExecutor` writes already-projected bodies into `turn_context`. `current.js` `renderToolTag` then calls `core.hooks.tools.view()` a second time. Every entry in `<current>` has its heading duplicated: `# sh rm notes.md\n# sh rm notes.md\nDo not delete.` The model cannot tell if a command ran once or twice.

- [x] **E-12** *(was P-SDI-5)* `<summarize>` override invisible to model — **fixed**: `TurnExecutor` now calls `knownStore.resolve(runId, summaryEntry.path, 409, "Overridden — actions in this turn failed.")` after the override so the model sees a 409 rejection instead of a silent 200. — when `<sh>rm notes.md</sh>` (403) and `<summarize>Deleted notes.md</summarize>` appear in the same turn, `summarize` records with status 200. `TurnExecutor` overrides summarize→update internally but the model sees its own summarize succeed and then inexplicably receives the same prompt again. Fix: record the overridden summarize as status 409 so the model sees the failure.

- [x] **E-13** *(was P-SDI-12)* Fidelity change on missing path returns 200 "not found" — **fixed**: `set.js` fidelity handler now returns 404 with `"not found"` body when the pattern matches zero entries. — `set.js` handler for fidelity changes writes `"${target} not found"` as body with `status=200` when the pattern resolves to zero matches. In run 12 turn 22, model attempted `<set path="known://the%20content%20of%20src/data3.txt" fidelity="summary"/>`, received 200 OK with body "not found", believed 0 tokens were freed, and continued panic incorrectly. Fix: return 404 when the path resolves to zero entries.

- [x] **E-14** **[log]** `<thought>` tag (Gemma/Qwen variant) causes inner tool calls to execute — **fixed**: `"thought"` added to `ALL_TOOLS` alongside `"think"`. Inner tool calls inside reasoning blocks are now captured as rawBody and discarded. — `<thought>` is not in `ALL_TOOLS` (only `<think>` is). When a model writes `<thought>I tried <sh>rm notes.md</sh> but it was rejected...</thought>`, `htmlparser2` processes the content as a stream: `thought` opens without setting `current`, the reasoning text goes to `textChunks`, then `<sh>` IS in `ALL_TOOLS` and opens `current` — the inner shell command executes for real. In run 9 turn 3, model's reasoning text `"` was rejected, I will use `"` became two separate `env://` entries with that text as the command path. Fix: add `"thought"` to `ALL_TOOLS` with the same no-op handler as `think`, or strip non-`think` reasoning tag bodies before parsing.

- [ ] **E-15** *(was P-SDI-14)* Duplicate `<rm>` entries in `<previous>` — rm of `unknown://...` creates two entries: `rm://turn_7/unknown%3A//...` (dedup collision path) and `rm://unknown%3A//...` (canonical). Both have `source_turn=7`, both pass `category=logging`, both render in `<previous>`. Same rm appears twice. Fix: dedup collision resolution must produce a single canonical path.

- [~] **E-16** *(was P-SDI-18)* Index entries sort before full in `<knowns>` — **REVERTED**: SPEC.md line 297 specifies `index → summary → full` intentionally. A path has exactly one entry — upsert is idempotent — so a stale index entry co-existing with a full entry is impossible. The premise was false. Original ordering restored. — `v_model_context` fidelity ordering: `CASE fidelity WHEN 'index' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END`. A file indexed at turn 1 and promoted to full at turn 8 lists the stale placeholder first. Model may use the empty placeholder without realising the full entry exists. Fix: invert the fidelity sort (`full` first), or filter out superseded index entries when a full entry for the same path is present.

---

## Category 2: Potential Problems
*Work today but could break under real conditions or edge cases.*

- [x] **P-1** *(was SDI-3)* Hook listeners accumulate per WebSocket — **fixed**: `HookRegistry.removeEvent()` added; `Hooks.js` exposes `.off()`; `ClientConnection` stores named handler refs and calls `off` for all four hooks in a `#teardown()` method wired to `ws.close`. — `ClientConnection` registers four anonymous callbacks on `hooks.run.progress`, `hooks.ui.render`, `hooks.ui.notify`, and `hooks.run.state` at construction. `HookRegistry` has no `off()`. Every new WebSocket connection permanently grows those listener lists. Fix: implement `off()` and deregister on `ws.close`.

- [x] **P-2** *(was SDI-7)* Budget `check`/`charge` asymmetry — **fixed**: `BudgetGuard.charge` now applies negative deltas (`Math.max(0, #spent + tokens)`); KnownStore calls `charge(delta)` for all non-zero deltas. — `KnownStore.upsert` calls `budgetGuard.check(delta, ...)` where delta can be negative (shrinking body). `check()` short-circuits on `tokens <= 0`, but `if (delta > 0) budgetGuard?.charge(delta)` means shrinking writes never credit the guard back. The guard's balance can only grow during a turn — false 413 trips on churning writes. Fix: pass raw delta (positive or negative) to `charge()`; handle negatives in `BudgetGuard`.

- [x] **P-3** *(was SDI-8)* `"0.7"` temperature fallback in `TurnExecutor` — **fixed**: hardcoded `|| "0.7"` removed; `temperature` now passes through as `options?.temperature` (null when absent). — line 489: `process.env.RUMMY_TEMPERATURE || "0.7"`. Temperature is stored on the `runs` row (from RPC `options.temperature`). The fallback is never the right answer once a run exists. Fix: remove the literal; read from the run row.

- [x] **P-4** *(was SDI-11)* `Telemetry` blocks the event loop with `writeFileSync` — **fixed**: `#flush()` now uses `writeFile(...).catch(() => {})` (fire-and-forget async). — `#flush()` calls `writeFileSync(this.#lastRunPath, ...)` inside `#logResponse`, which fires on every LLM response. Fix: use async `writeFile` fire-and-forget, or buffer and flush outside the filter chain.

- [x] **P-5** *(was SDI-13)* RPC timeout leaks a `setTimeout` handle — **fixed**: timer stored in `let timer`; `Promise.race(...).finally(() => clearTimeout(timer))` clears it on resolution. — `ClientConnection` line 138 creates a raw `setTimeout` inside `Promise.race`. When the handler resolves first, the timer still fires and rejects the settled promise — no visible error but the handle is never cleared. Fix: wrap in `AbortController` via `node:timers/promises`, or clear the timer in the resolved branch.

- [x] **P-6** *(was SDI-15)* `Budget.enforce` does not update `turn_context.tokens` — **fixed**: telemetry now reads `turns.context_tokens` (set by `update_turn_stats` from actual `assembledTokens`) via new `get_turn_context_tokens` query, not the `turn_context` row sum. — after `enforce`, `turn_context` rows retain pre-enforce token counts. Telemetry query `get_turn_budget` sums those rows and reports a total higher than what was actually sent to the LLM. Fix: rely exclusively on `turns.context_tokens` populated by `update_turn_stats`, or re-sum after enforce.

- [x] **P-7** *(was SDI-17)* `dedup`/`slugPath` `Date.now()` collision — **fixed**: collision suffix now uses `++this.#seq` (per-instance monotonic counter). Short, deterministic, zero-collision within a process. — both append `_${Date.now()}` on path collision. Parallel tool dispatch within the same millisecond can produce two identical suffixes → upsert collision → silent loss of one entry. Fix: use `crypto.randomUUID()` or a per-run monotonic counter suffix.

- [x] **P-8** *(was SDI-18, extended)* `AgentLoop.resolve` and `inject` re-enqueue with `config: "{}"` — **fixed**: `resolve` now passes `currentLoop?.config || "{}"`. `inject` correctly uses `"{}"` — it's a fresh ask loop from an external message, no flags to carry. — `resolve` line 712 and `inject` line 756 both use the literal `"{}"`, discarding `noRepo`, `noInteraction`, `noWeb`, and `temperature` from the original loop. After a 202→accept→resume or an inject cycle, the model runs with different flags than the original request. Fix: carry the original loop's `config` JSON through both paths.

- [x] **P-9** *(was P-SDI-6)* **[log]** Reasoning bleed stored as URL-encoded tool paths — **fixed**: `TurnExecutor.#record()` now rejects paths longer than 512 chars or containing Unicode control chars (`\p{Cc}`) with a 400 status. Reasoning bleed produces multi-sentence paths that exceed this threshold. — when model reasoning bleeds into a tool body (e.g. text between backtick-fenced tool references), `KnownStore.dedup()` URL-encodes it and stores it as the entry path. In run 9: `env://turn_3/%60%20was%20rejected%2C%20I%20will%20use%20%60`. The garbage path is then echoed back in `<current>` as URL-decoded text. Fix: cap path length at the tool handler layer and return 400 for oversized or non-printing paths; reasoning bleed must not silently succeed.

- [x] **P-10** *(was P-SDI-10)* Panic `<knowns>` omits `status` — **fixed**: `renderKnownTag` in `known.js` now includes `status` in the panic-mode self-closing tag. — normal mode renders `<file path="..." turn="1" status="200" fidelity="index"/>`. Panic drops status: `<file path="..." turn="1" fidelity="index"/>`. Model cannot distinguish a 4xx errored file from a healthy one when deciding what to delete. Fix: include `status` in the panic-mode knowns renderer.

- [x] **P-11** *(was P-SDI-16)* **[log]** `<previous>` exposes internal `get://turn_N/` dedup namespace — **fixed**: `previous.js` strips `scheme://turn_N/` prefixes from all summary text before rendering into `<previous>`. — summaries in `<previous>` include `summary="# get get://turn_1/src/data0.txt\n..."`. In run 4, the model then issued `<get path="get://turn_3/*">` queries to explore this as a real namespace. Fix: strip the `get://turn_N/` prefix from summaries rendered into `<previous>` — it is a dedup artifact, not a queryable path.

- [x] **P-12** *(was P-SDI-17)* `<progress>` inside `<current>` self-closes inconsistently — **fixed**: `prompt.js` now always writes `progress://${turn}` with `"Turn N/M"` counter. `loopIteration` flows from AgentLoop → TurnExecutor → `turn.started` event. — when `isContinuation=false` (turn 1 of a loop), the continuation prompt is empty and the progress entry has no body, rendering as `<progress path="" turn="1" status="200"/>`. On subsequent turns it has body `"Turn 2/99"`. Loop position signal appears on some turns and not others. Fix: always include the loop counter regardless of continuation state.

- [x] **P-13** getDoc `fidelity="index"` misleads — **fixed**: `getDoc.js` now reads `fidelity="archive"` (removes from context), not `"index"`. — `getDoc.js` final constraint: `'Use <set path="..." fidelity="index"/> to archive loaded content'`. The word "archive" is wrong here: `index` fidelity keeps the entry visible in `<knowns>` (with empty body); `archive` removes it from context entirely. A model following this advice thinks it freed context when it only hid the body. Fix: change the doc to `fidelity="archive"` and explain the difference between index (placeholder remains) and archive (removed from context).

---

## Category 3: Warrant Discussion
*Design decisions with tradeoffs worth debating.*

- [~] **D-1** *(was SDI-14)* `PluginContext` silently drops unknown hook paths — **decision: no change**. Fail-hard applies to internal contracts, not third-party plugin integration. External plugins can register against unknown paths without crashing the agent. — `#resolveEvent` and `#resolveFilter` return `null` for unrecognised paths; `on()` and `filter()` do nothing. Fail-hard philosophy says throw. Counter: external plugins should not crash the agent on a typo. Decision: strict throw vs. dev-mode-only warning vs. current silent drop.

- [ ] **D-2** *(was P-SDI-1)* Prompts tail `<previous>` due to category ordinal — `v_model_context` orders: `tool(1) → data(2) → logging(3) → unknown(4) → prompt(5)`. The prompt that triggered turn 1's `<get>` appears 30+ entries after that `<get>` in `<previous>` at turn 22. Model must reconnect cause to effect across unordered entries. Discussion: interleave prompts by `source_turn` vs. keep current grouping.

- [x] **D-3** *(was P-SDI-2)* **[log]** `<get>` receipt gives no indication content landed in `<knowns>` — **fixed**: receipt body now reads `"src/app.js loaded into <knowns> (53 tokens)"` instead of the silent `"src/app.js 53 tokens"`. — the non-pattern get handler writes `"src/app.js 53 tokens"` as the result body. Content is promoted into `<knowns>` with no announcement. In run 4, model re-issued `<get>src/app.js</get>` eight consecutive turns believing the file hadn't loaded. Discussion: receipt should say `"src/app.js loaded into <knowns> (53 tokens)"`. Belongs in receipt body, tool doc, or both.

- [~] **D-4** *(was P-SDI-7)* **[log]** Loop counter resets to "Turn 2/99" every new loop — **decision: no change**. Each entry in `<previous>` carries `turn=""` (global sequence) which disambiguates temporal ordering. Loop-local counter in summary is secondary context. — `loopIteration` counts within the current loop. Each new loop resets to 1. In `<previous>` at turn 22: five different actual turns all show `summary="Turn 2/99"`. Model cannot detect whether it is stuck in a repeating pattern or making progress. Discussion: emit `Loop N Turn M/99` or a global monotonic turn counter.

- [x] **D-5** *(was P-SDI-8)* Two different token counts in same packet — **addressed by D-6 fix**: with `context_tokens` back-filled from LLM's `prompt_tokens`, `<progress>` will show the accurate prior-turn count. The pre-LLM estimate in panic is necessarily an estimate (LLM hasn't run yet). One-turn lag is acceptable. — at turn 22 (panic): outer `<progress>` shows `"29489 of 32768 tokens (90%)"` (from previous turn's `context_tokens`), panic prompt body says `"CONTEXT OVERFLOW: 29603 tokens"` — 114-token discrepancy. Both claim to be current. Discussion: use the same token source in both, or label clearly which is the estimate vs. the ground truth.

- [x] **D-6** *(was P-SDI-9)* **[log]** System token estimate diverges ~40% from LLM actual — **fixed**: `telemetry.js` now sets `context_tokens = usage.prompt_tokens || assembledTokens`. `get_last_context_tokens` (used by `<progress>` and `lastContextTokens` baseline) now reflects LLM actuals, not the divisor-based estimate. — run 12: `context_tokens` (system estimate) = 9619 at turn 2, LLM `prompt_tokens` = 3647. System reports 90% full, LLM processed 29%. Model was given inflated context pressure for ~60% of available budget. Discussion: back-fill `context_tokens` post-response from LLM's usage report? System estimate is a pre-call upper bound; LLM actual is the ground truth.

- [x] **D-7** *(was P-SDI-11)* **[log]** Panic `<knowns>` shows tokens for `full` entries, not `index` — **fixed**: panic renderer now always emits `tokens="0"` (or actual count) — no entry is missing its cost. Panic prompt updated to note `0 = already minimal`. — panic renders `<file path="data/users.json" fidelity="index"/>` (no `tokens` attr) vs `<file path="src/data0.txt" fidelity="full" tokens="6000"/>`. The panic prompt claims all entries show token counts. Model burned turns trying to demote zero-cost index entries because their cost appeared unknown. Discussion: explicitly render `tokens="0"` on index entries, or add a note that index entries are already minimal.

- [x] **D-8** *(was P-SDI-13)* **[log]** Panic continuation prompt loses all quantitative context — **fixed**: continuation panic turns now regenerate the full quantitative prompt using `_lastAssembledTokens` (the actual count from the previous turn). Model always has current deficit figure. — first panic turn gets exact count, target, and instructions. Subsequent turns get only `"Continue freeing space. Check <knowns> token counts."` If the model freed 0 tokens due to wrong-path errors, it has no current deficit figure and no indication prior attempts failed. Discussion: regenerate the full quantitative prompt every panic continuation turn, or include current shortfall at minimum.

- [x] **D-9** *(was P-SDI-15)* `<progress>` has dual semantics — **fixed**: `progress://N` KV entries removed entirely. Loop counter dropped (telemetric noise; turn count is an operator guardrail, not model-relevant budget). Outer `<progress>` now carries `turn="N"` attribute for temporal context. Single unambiguous tag. — inside `<current>`: `<progress path="" turn="2" status="200">Turn 2/99</progress>` (loop position). Outside: `<progress>29489 of 32768 tokens (90%)...</progress>` (context budget). Identical tag, entirely different meaning. Discussion: rename the inner one — e.g. `<loop-turn>` or a plain attribute on the outer `<current>` wrapper, rename outer to `<budget>`.

- [x] **D-10** *(was P-SDI-19, partially fixed)* Unknown appears in `<current>` and `<unknowns>` simultaneously — **fixed** (partial→complete): `current.js` excludes `scheme === "unknown"`. One-turn lag (unknown created at turn N appears in `<unknowns>` at turn N+1) is architectural and correct — assembly reads DB state at turn start, before dispatch. Acceptable. — **partial fix applied**: `current.js` now excludes `scheme === "unknown"` from `<current>`. Remaining question: the one-turn visibility lag (unknown created turn N not visible until turn N+1) is architectural but may surprise models. Confirm this is acceptable and document it.

- [x] **D-11** *(was P-SDI-20)* **[log]** Panic prompt never disambiguates file paths vs `known://` slugs — **fixed**: panic prompt now includes "Copy the path attribute EXACTLY from `<knowns>` — do not invent paths." — `<knowns>` shows `<file path="src/data0.txt" .../>` and `<known path="known://The assistant has..." .../>`. Model responded with `<set path="known://the%20content%20of%20src/data3.txt" fidelity="summary"/>` — invented a `known://` path by prepending the scheme onto the file subject. Correct call: `<set path="src/data3.txt" fidelity="archive"/>`. Saved 0 tokens. Discussion: panic prompt should include a concrete `<knowns>` excerpt and instruct "copy the path attribute exactly".

- [ ] **D-12** Model writes placeholder `<known>` before having data — in run 2, the model issued `<known>Mass Effect 1 release year</known>` in turn 1 before the search result returned, then issued a second `<known summary="Mass Effect 1 release year: 2007">Mass Effect 1 was released in 2007</known>` in turn 2. Two entries for the same fact. Discussion: the size gate (512 tokens) prevents bloat, but there is no dedup by semantic content. Consider whether a same-turn known with empty/placeholder body should be rejected with 409.

---

## Category 4: Model Mysteries
*Patterns in model reasoning that reveal confusion, workarounds, or opportunities.*
*Each item quotes actual model reasoning from packet logs.*

- [x] **M-1** *(was P-SDI-2)* **8 consecutive re-reads of `src/app.js`** — **fixed by D-3**: receipt now reads `"src/app.js loaded into <knowns> (53 tokens)"`. — run 4, turns 2–10. Model re-issued `<get>src/app.js</get>` eight times in a row despite successful loads. The get receipt said `"src/app.js 53 tokens"` with no indication the content was in `<knowns>`. Model read a 200 response with no content and concluded the file hadn't loaded. Eight wasted LLM calls before the run was aborted.

- [x] **M-2** *(was P-SDI-4)* **4 wasted turns after sh 403** — **fixed by E-6**: 409 bodies now include the rejected command text so the model's history makes sense. — run 9, turns 3–6. After `<sh>rm notes.md</sh>` returned 403, model issued `<env>ls -R</env>` twice and two `<get>` calls. All returned 409 with (previously) empty bodies. From model reasoning: *"I previously attempted to use `<sh>rm notes.md</sh>` but it was rejected (likely due to safety constraints or the environment setup). I also tried `<env>ls -R</env>` which was rejected."* The 409 body fix (E-6) addresses this.

- [x] **M-3** **`<thought>` tag bleeds model reasoning into tool execution** — **fixed by P-9**: `ALL_TOOLS` now includes `think`, `thought`, `mcp`; inner tool calls inside those blocks are captured as `rawBody` (not dispatched). Path validation rejects implausible targets. — run 9, turn 3. Model (Gemma) used `<thought>` not `<think>`. Content of `<thought>` included `<sh>rm notes.md</sh>` and `<env>ls -R</env>` references. Those became real dispatched commands. From `content://3` (unparsed text, with tool tags stripped by htmlparser2): *"The user wants to delete `notes.md`. I previously attempted to use `` but it was rejected... I also tried `` which was rejected."* The `<sh>` inside `<thought>` actually executed and got a 403. Then `<env>` inside the same `<thought>` body was parsed with the reasoning text as the command string: `env://turn_3/%60%20was%20rejected%2C%20I%20will%20use%20%60`. Model saw these execute and became confused about its own history.

- [x] **M-4** *(was P-SDI-6)* **Model queries internal `get://turn_N/` namespace** — **fixed by P-11**: summaries now strip `scheme://turn_N/` prefixes before storage, so the internal dedup namespace is never visible in `<previous>` summaries. — run 4. The model saw `<get path="" turn="1" summary="# get get://turn_1/src/app.js\n..."/>` in `<previous>`. It then issued `<get path="get://turn_3/*">` and similar queries, treating the dedup namespace as a queryable store. This is a direct information leak from the audit namespace into model-visible output.

- [x] **M-5** *(was P-SDI-7)* **Model cannot detect it is stuck** — **fixed by D-9**: `progress://N` KV entries removed; ghost loop-counter entries no longer pollute `<previous>`. — run 9, 25 turns, 13 loops. In `<previous>` at later turns: five different actual global turns all show `summary="Turn 2/99"`. From `<previous>`: `<progress turn="2" .../>`, `<progress turn="4" .../>`, `<progress turn="6" .../>`, `<progress turn="9" .../>`, `<progress turn="15" .../>` — all with identical summaries. Model has no signal that it has executed the same task 13 times.

- [x] **M-6** *(was P-SDI-9)* **Model panics at 29% actual usage** — **fixed by D-6**: `context_tokens` back-filled from LLM `prompt_tokens` post-response; `<progress>` and budget enforcement now reflect actual tokenizer counts, not the divisor estimate. — run 12. System estimated context at 90% full; LLM `prompt_tokens` showed 29% actual. Model received panic pressure for the entire middle of the run. Token inflation is `RUMMY_TOKEN_DIVISOR=2` (2 chars/token) vs. actual tokenizer producing ~3.4 chars/token for this content. The model was effectively lied to about its own resource state.

- [x] **M-7** *(was P-SDI-11)* **Model burns turns on zero-cost index entries in panic** — **fixed by D-7**: panic renderer now always emits `tokens="0"` on index entries; panic prompt notes `0 = already minimal`. — run 12, turn 22. From `content://22`: *"I will start by archiving the large data files to `archive` fidelity to reduce their token count... Actually, `fidelity='archive'` is for 'archive out of context'. The prompt says 'Only reduce'."* The model correctly read the panic instruction but then got confused about whether archive counts as reduction. It considered index entries as having unknown/high cost because they show no `tokens` attribute.

- [x] **M-8** *(was P-SDI-12 + P-SDI-13)* **Model receives 200 "not found", believes panic succeeded, has no recalibration data** — **fixed by D-8 + D-11 + M-10**: continuation panic now regenerates full quantitative prompt; panic prompt tells model to copy paths exactly; `setDoc` clarifies `summary` fidelity hides body without requiring content. — run 12, turn 22. Model tried `<set path="known://the%20content%20of%20src/data3.txt" fidelity="summary"/>` (invented path). Got `status=200` body `"known://the content of src/data3.txt not found"`. From `content://22`: *"I will compress `src/data0.txt` and `src/data1.txt` to summaries... Wait, if I use `<set path='...' fidelity='summary' summary='data file'/>`, it replaces the content with the summary. But I don't have the content of the files in my immediate view to summarize them effectively without loading them, which I am told NOT to do."* The model correctly diagnosed its own confusion about what `summary` fidelity does, then still issued the wrong command and received a false success response.

- [x] **M-9** *(was P-SDI-20)* **Model invents `known://` path from file subject in panic** — **fixed by D-11**: panic prompt now instructs "Copy the path attribute EXACTLY from `<knowns>` — do not invent paths." — run 12. `<knowns>` showed `<file path="src/data3.txt" .../>`. Model issued `<set path="known://the%20content%20of%20src/data3.txt" fidelity="summary"/>`. It constructed a `known://` scheme path using the file's subject as the slug — the two-namespace convention (`file` paths are bare, `known://` slugs are auto-generated) is never explained in the panic prompt or anywhere visible to the model.

- [x] **M-10** **Model uses `fidelity="summary"` believing it requires the content** — **fixed**: `setDoc.js` now explicitly states "`fidelity=\"summary\"` HIDES the body — does NOT require reading or compressing content. Write any short keyword label you already know." — run 12, `content://22`: *"I will use `<set path='...' fidelity='summary' summary='...'/>` to compress the large files. But I don't have the content of the files in my immediate view to summarize them effectively without loading them, which I am told NOT to do."* The model believes that to set `fidelity="summary"` it must provide a meaningful semantic summary, which requires reading the file. It does not know that `fidelity="summary"` just hides the body and uses the `summary` keyword attribute as a label — it does not replace or compress the body content in a semantic sense. The set tool doc does not explain this.
