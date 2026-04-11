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
overridden when actions fail. `<think>` / `<thought>` tags for model
reasoning — inner tool calls captured as rawBody, never dispatched.
Preamble: XML format, conclude every turn, summaries approximate.
Four entry roles: data (knowns), logging (current/previous), unknown,
prompt. Default category: logging. `<prompt mode="ask|act">`.
Each plugin owns its own views.
PLUGINS.md: third-party developer guide, §0-§11. plugin_spec.test.js:
30 compliance tests. Hooks: tool.before/after, entry.recording filter,
turn.completed, loop.started/completed, run.created, context.materialized.
Concurrent loop protection: AbortController created at top of
`#drainQueue` before first await — closes the race on `#activeRuns`.
`normalizePath` lowercases scheme component. `<previous>` sorted
chronologically by source_turn (prompt before logging within same turn).
`progress://` scheme removed; `<progress turn="N">` is structural only.
`context_tokens` back-filled from LLM `prompt_tokens` post-response.
154 unit tests passing.

## Future Work

### Benchmarking (MAB + LME)
- Re-run after SDI fixes to measure improvement
- Model cooperation with budget is the remaining challenge

### Smart Housekeeping (Step 3)
- Model makes informed decisions about what to demote
- Guided by progress warnings at 50%/75%
- Step 3 of ENFORCED → FUNCTIONAL → SMART

## Deferred

- Relevance engine (stochastic, separate project/plugin)
- Hedberg extraction to `@possumtech/rummy.hedberg` npm package
- Bulk operation aggregation (one entry per pattern operation)
- Non-git file scanner fallback

---

## Done: Session 2026-04-10/11 — Packet SDI Audit

40-item audit of packets sent to the model. 36 fixed, 4 no-change.
All E/P/D/M categories resolved. 154 unit tests passing.

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
  format examples, §11.2-§11.5 complete RPC listings.
- **EXCEPTIONS.md created**: 4 documented protocol violations with
  justifications and fix paths.
- **plugin_spec.test.js**: 30 section-numbered compliance tests.
- **Token math audited**: three sources (known_entries.tokens,
  turn_context.tokens, turns.context_tokens), all consistent, no
  conflation. Budget uses only assembled tokens. Documented in §7.5.
- **entry.changed verified**: KnownStore.onChanged → hooks pipeline.
  Fires on upsert, fidelity change, remove.
- **All hooks verified**: every PLUGINS.md hook emitted and subscribable.
- **noRepo plumbed**: RPC→AgentLoop→TurnExecutor→RummyContext.noRepo.

## Done: Session 2026-04-06/07 (continued)

- **`<store>` tool removed**: Fidelity control via `<set>` attributes.
  10 tools → 9.
- **`summary="..."` attribute**: Model-authored descriptions (<= 80 chars)
  persist across fidelity changes.
- **Tool tags in previous/current**: Results render as `<set path="...">`.
- **Native tool call normalization**: Qwen, OpenAI, Anthropic, Mistral
  formats silently translated to rummy XML in XmlParser.
- **Skill plugin**: Class renamed `Skill`, turn 0 for init-time writes.
- **XmlParser → Hedberg**: JSON edit parsing moved to `hedberg/normalize.js`.
- **Repetition detection**: Update text fingerprinting. Known entry dedup.
- **Scheme registration**: All tool plugins register. Audit schemes bootstrapped.
- **URI length cap**: 2048 chars max on known_entries.path.

## Done: Session 2026-04-06/07

- **Loops table**: projects > runs > loops > turns. Replaced prompt_queue.
- **HTTP status codes**: `state TEXT` → `status INTEGER` + `fidelity TEXT`.
- **Budget enforcement**: Post-assembly token check, progress warnings.
- **Glob matching**: picomatch replaces hand-rolled globToRegex.
- **XmlParser recovery**: Mismatched/overlapping tool tags handled.
- **Plugin loader**: Global package resolution.
- **Error feedback**: Get, set, rm return labeled errors on missing path.
- **Tool docs distributed**: Each tool's docs show globs, preview inline.

## Done: Earlier Sessions

- Plugin architecture refactor (18 plugins, constructor(core) pattern)
- xAI integration (Responses API)
- Hedberg plugin (patterns, matcher, sed, edits, normalize)
- Packet restructuring (system/user split, assembly filters)
- Cleanup (removed defaults, fallbacks, legacy code)
