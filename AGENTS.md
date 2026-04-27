# AGENTS: Planning & Progress

> **SESSION BOOTSTRAP — READ ME FIRST.** This file is the only
> cross-session ground truth. Before touching code: read the standing
> rules, the "Where We Are" paragraph, and any open "Ongoing
> Development Conversation" entries. Cross-reference SPEC.md §0 for
> the contract and PLUGINS.md §7 for the events/filters surface.
> **Append to "Ongoing Development Conversation" as you work** —
> decisions made, rules restated, choices deferred. The next session's
> coherence depends on it.

> **Standing rules that override anything else:**
> - **No fallbacks outside `src/plugins/hedberg/*` and `src/agent/XmlParser.js`.**
>   Not `|| 0`, not `?? null`, not `|| ""`. Boundaries validate;
>   interiors crash on contract violation. `biome/no-fallbacks.grit`
>   enforces — if it complains, fix the contract, not the rule.
> - **Every `createEvent` / `createFilter` in `Hooks.js` is a plugin
>   extension point and stays.** Zero current subscribers does not
>   mean "delete" — extensibility is the keystone architectural
>   promise. Adding events where core fires an unannounced phase
>   is encouraged.
> - **AGENTS.md isn't a trophy room.** When a phase lands, its
>   detail collapses to one line. Lessons survive; trivia dies.
>   Never remove a standing rule.
> - **The user is right until the DB proves otherwise.** When a
>   symptom gets reported, read `rummy_dev.db` first, don't guess,
>   don't blame the environment, don't defer to the next demo.
> - **Integration and e2e tests are 1:1 with SPEC.md's snake_case
>   anchor system.** Every SPEC.md heading carries an explicit
>   `{#snake_case_id}` anchor. Every anchor has at least one
>   `@snake_case_id` reference in `test/integration/` or
>   `test/e2e/`. Every test in those dirs is attributed to at least
>   one `@`-reference. No integration or e2e test exists outside
>   this system; no SPEC anchor exists without a test anchoring
>   it. See SPEC.md section "Spec-Anchored Testing". Enforced by
>   `npm run test:spec`. Numeric `§X.Y` references are dead — use
>   snake_case anchors that don't churn when sections move.
> - **AGENTS.md is the project memory scratchpad.** Never store
>   project-scoped decisions, plans, or state in Claude internal
>   memory (`~/.claude/projects/...`). Project-specific facts live
>   here where everyone can see them and the next session can read
>   them. Internal memory is for user-wide preferences only.

> **Instructions discipline (when touching `src/plugins/instructions/instructions.md`
> or any `instructions_10N.md` phase file):**
> - **Brief.** Every token is paid every turn. Cut before expanding.
> - **Show, don't tell.** Examples teach better than prescriptions. A
>   three-line worked example beats ten lines of "you must / you should".
> - **Mind the trade-offs both within and between tools the model must
>   succeed with.** Instructions that optimize one tool can sabotage
>   another. The model's context budget is one zero-sum pool shared
>   across `<get>`, `<set>`, `<rm>`, `<search>`, `<update>`, `<sh>`,
>   `<ask_user>`. Adding a rule that helps one can cost another its
>   oxygen.
> - **Static base in system, phase-specific in user.** The base
>   template (`instructions.md`) is part of the system prompt — it
>   must stay stable across turns within a run so prompt caching
>   holds. The phase-specific `instructions_10N.md` files render as
>   `<instructions>` in the user message (dynamic by design).
>   Anything that would change mid-run belongs in the phase files,
>   never the base template.

> **Guiding principles (enshrined):**
>
> "Is there a rummy way to do this?" Every `<tag>` the model sees is
> a plugin. Every scheme is registered by its owner. Every piece of
> data exists as an entry or a column. No exceptions without docs.
>
> **Everything is an entry.** Files, tool calls, streaming output,
> plans, unknowns, sub-agents — all entries. `<get>`/`<set>` is the
> universal grammar. (SPEC §0.1)
>
> **"Model behavior" is never an acceptable explanation for a test
> failure.** When a model misbehaves, the system failed — suboptimal
> context, poorly designed conditions, insufficient reinforcement.
> Every failure is a system bug until proven otherwise.
>
> **Reference + feedback over broadcast.** Steer the model through
> three channels in priority order: (1) tooldocs at the decision
> point, (2) error:// entries for dynamic feedback, (3) instructions
> for genuinely cross-cutting identity. System instructions pay context
> every turn; prefer the other two channels first.

---

## Where We Are

The contract (SPEC the_contract) is fully delivered. Schema,
primitives, entry grammar, client RPC surface, plugin hygiene, and
external repo rewrites (`rummy.repo`, `rummy.web`, `rummy.nvim`) are
all landed. The system instructions were split into a stable base
(identity + tools + tooldocs) plus a dynamic `<instructions>` block
that rides the user message to keep prompt caching intact. Lifecycle
handshake, budget math, and fallback hygiene are all clean. Phase 7
(verification + benchmark) is the remaining work.

## The Plan

- **Phase 1 — Schema** ✓ `run_views.state`, four writer tiers, view
  layer, boot env resolution.
- **Phase 2 — Primitives** ✓ Six-verb object-arg grammar:
  `set` / `get` / `rm` / `cp` / `mv` / `update`.
- **Phase 3 — Runs-as-entries** ✓ `run://<alias>` scheme, client
  writer tier, run:// → entry mirror with unified lifecycle.
- **Phase 4 — Client surface** ✓ RPC is a thin projection of the
  plugin API. Protocol 2.0.
- **Phase 5 — Plugin hygiene** ✓ Plugin-dep system deleted,
  TestDb+TestServer share one graph, PermissionError typed, handler
  writer plumbed via Proxy.
- **Phase 6 — External projects** ✓ `rummy.repo`, `rummy.web`,
  `rummy.nvim` all rewritten to the 2.0 wire and green.
- **Phase 7 — Verification** ⌛ Doc walk, benchmark baseline, demo
  handoff. See Open Items.

---

## Open Items

- [ ] **Token accounting refactor (2026-04-25).** End the doom loop where "tokens" sometimes means body-tokens, sometimes wire-tokens, sometimes API-tokens. One truth: tokens are a materialized cost, computed during assembly, never stored on entries. Per-entry materialization records carry `vTokens` (cost when visible), `sTokens` (cost when summarized), `aTokens = vTokens − sTokens` (the promotion premium — the only number the model sees on per-entry tags). Budget table renders visible-scheme breakdown using `aTokens`; summarized entries collapse into a single aggregate line below the table; system overhead (system prompt + tool defs) gets its own line. Total reconciles to `tokenUsage`.
  - [ ] **SPEC.md** — new `{#token_accounting}` anchor specifying: tokens are materialized, never stored; per-entry vTokens/sTokens/aTokens contract; `<budget>` rendered shape (visible-scheme table + summarized line + system line + total). Update `{#schema}` to drop `entries.tokens`. Update `{#budget_enforcement}` to point at the new `<budget>` shape.
  - [ ] **Failing tests** — `test/integration/materialization_token_accounting.test.js` for per-entry vTokens/sTokens/aTokens shape; update `test/integration/budget_math.test.js` for the new `<budget>` layout (visible table, summarized line, system line, total reconciles); e2e story verifying a model demote frees the demoted entry's aTokens on the next turn.
  - [ ] **Implementation, dependency order**: (1) materialization computes vTokens/sTokens/aTokens per-entry and exposes on the materialization records; (2) budget plugin's `assembleBudget` renders the new shape using aTokens for the table and aggregates for summarized + system; (3) `known.js` MAX_ENTRY_TOKENS gate moves to inline `countTokens(body)` at write time; (4) schema migration drops `entries.tokens`.
  - [ ] **`spec-coverage.js`** stays green throughout — every new anchor referenced by ≥1 test on landing.

- [ ] **Budget → error fold.** Subsumed by the Error paradigm
  unification (see Ongoing Development Conversation, 2026-04-22).
  Budget emits `error.log.emit({status: 413})` instead of
  `budget://`. Drop `budget://` scheme. Hard-exit 413 path at
  `TurnExecutor.js:131-141` deleted.

- [ ] **Post-unification audit: bespoke error paths.** Once the
  Error paradigm unification (2026-04-22) lands, sweep the entire
  codebase for model-facing error handling that bypasses
  `hooks.error.log.emit`. Covers:
  - Plugins: any `entries.set({state:"failed"})`, ad-hoc failure
    entries, custom "something went wrong" tags or schemes.
  - Core: `src/agent/*` — any direct failure-entry writes,
    status-code short-circuits, bespoke "tell the model" branches.
  - Renderer/view projections that surface error-like content
    outside the standard error entry shape.
  Anything found either migrates to `error.log.emit` with an
  appropriate status code, or documents why it's exempt.
  Success criterion: one channel in, one channel out; no parallel
  error paths anywhere the model can see.

- [ ] **System auto-pruning.** On loop boundary or when log size
  crosses threshold, archive `log://turn_{M}/**` where M < current -
  `RUMMY_LOG_HORIZON`. Keeps the log bounded on long runs without
  requiring model intervention.

- [ ] **Gemma/MAB benchmark run.** Published baselines are in this
  doc below (60%/5% GPT-4o; 60%/6% best). With the instructions
  system stable now, we have a meaningful number to measure against.
  Needed *before* any more instruction-shape experiments.
- [ ] **`notification_log` table.** `rpc_log` captures
  request/response; `run/state` / `run/progress` / `run/proposal`
  fly out untracked. Mirroring the shape would let us replay
  notification streams for diagnosis.
- [ ] **Plugin filter priority magic numbers.** 100 / 150 / 200 /
  300 appear throughout with no documented meaning. Either name
  the stages explicitly or document the ranges so third-party
  plugins can slot between phases without reading source.
- [ ] **Headless nvim e2e test.** Every new `run.state` telemetry
  field must be manually re-synced in `dispatch.lua` / `state.lua` /
  `statusline.lua`. A test that spins up a headless nvim against
  the server and asserts the statusline renders correctly for a
  known run would catch drift at contract time.
- [ ] **Stress test for `SocketServer.close()` drain.** Kick off N
  concurrent runs, call `close()` mid-flight, assert (a) the close
  awaits, (b) all run entries land terminal, (c) no Promises pin
  the event loop. Locks in the `abortAll` work.
- [ ] **Glossary in SPEC.** Pin exact meaning of *turn*, *loop*,
  *run*, *verdict*, *strike*, *phase*, *proposal*. Audit code for
  misuses.

## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code.
  Everything the contract doesn't name, isn't there.

## Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

## Lessons (keep these pinned; don't let future sessions forget)

- **AGENTS.md is shared memory.** Internal LLM memory is for
  overrides only. Append project observations here, not internally.
- **Plugin extensibility is a promise, not an implementation detail.**
  Don't delete "unused" events.
- **No fallbacks outside hedberg/XmlParser.** Biome enforces.
- **Read the DB first.** When a symptom gets reported, the answer
  is in the data, not in speculation.
- **Decide, don't dawdle.** When naming or scope questions arise,
  either resolve them in-session or ask the user — don't defer
  them silently to a "follow-up pass" that never happens.
- **The codebase is the codebase.** Don't compartmentalize by
  "prior model's code vs my code" when auditing. If you're
  touching it, it's yours now.
- **Attribute semantics must not split on context.** If `visibility=`
  means one thing on a state-entry tag (`<known>`) and another on an
  action-record tag (`<set>` in `<log>`), the model will confuse them
  and re-emit actions trying to "fix" phantom state. Any attribute
  rendered in the packet must mean the same thing wherever it
  appears.
- **Time-indexed vs topic-indexed paths.** Log entries are time-
  indexed — path encodes turn. State entries (knowns, files,
  unknowns) are topic-indexed — path encodes identity, turn is
  metadata. The rule: if the entry's identity is WHEN, turn goes in
  the path. If identity is WHAT, turn is an attribute.
- **When the model emits malformed XML or "wrong" syntax, scan
  `instructions.md`, `instructions_10N.md`, and `*Doc.md` for that
  exact pattern first.** Models reproduce what they see modeled.
  "Unclosed `<set>`" or "wrong attribute name" has been our fault
  more than once — an example with a typo, an inconsistent attribute
  spelling, an unbalanced tag in a code block. Treat the model's
  syntax mistake as an audit trigger before treating it as a model
  capability problem.
- **Unknown spamming is real.** Gemma can emit 90+ visible unknowns
  in a single Definition pass on a fact-heavy ingest. The state
  machine then has to grind every one through Discovery+Demotion
  before reaching Deployment. Front-loaded over-definition is a
  documented failure mode, not a baseline to accept.

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Empty — reset 2026-04-25. Append entries here only when there's an
actually-ongoing conversation worth tracking across sessions (an
in-flight refactor mid-stream, a deferred decision with a real follow-up,
a debugging thread that hasn't resolved). Landed work belongs in
git history; durable rules belong in the standing rules block above;
durable observations belong in the Lessons section. Don't chronicle
what the diff already records.*

### Benchmark architecture cleanup (2026-04-26, in flight)

MAB runner had three structural issues that chronically lowered scores
before they were caught:
1. Default chunk-size of 4000 chars regardless of model context window
2. Multi-question runs accumulated prior prompts on a single run, polluting validator state and producing the "prior-prompts wall"
3. No fork-per-question — questions ran on ingest-saturated state

**MAB done:**
- ✅ `--chunk-size` opt-in (default = single chunk; full-context-window models inhale the whole row)
- ✅ Fork-per-question — `askQuestion` uses `fork: true`; child filters via `loop_id != null`
- ✅ Auto-archive prior prompts/logs on new prompt arrival (server-side, defense-in-depth for any multi-prompt flow)
- ✅ TypeError fix: `Entries.scheme(null)` returns null instead of throwing
- ✅ `RUMMY_TEST_RUN_TIMEOUT` env var (1hr) replaces hardcoded 420s in AuditClient
- ✅ Audit-scheme leak fix — `getEntriesByPattern` defaults to filtering audit schemes; only `instructions.resolveSystemPrompt` opts in via `{ includeAuditSchemes: true }`
- ✅ Instruction additions: 105.md "ONLY from promoted information" + worked `<get path="**" preview>` example; 107.md direct-answer guidance

**LME punch list (apply same lessons):**
- [x] Add fork-per-question (mirror MAB pattern; child filters by `loop_id != null`)
- [x] Lock down `judgeAnswer` call — add `noRepo`, `noWeb`, `noProposals` to match ingest/question call shape
- [x] Delete dead `--chunk-size` arg + `_chunkSessions` function (read but never used)
- [x] Replace `e.turn >= turnBefore` filter with `loop_id != null` after fork lands

**Post-LME backlog:**
- [ ] **Gemma "empty response" deaths.** New failure pattern (since ~2026-04-26): gemma emits zero actionable tags on alternate turns mid-Definition, hits 3-strike abandonment at turn 4-6 before completing ingest. Was not the pattern weeks ago. Investigate: context-window pressure, instruction overload, or harness regression. **Gemma surviving is a higher priority than grok winning** — this is a regression, not a baseline.
  - Partial fix: removed status 144 (Definition continuation) from `instructions_104.md` so Definition is single-shot. Should eliminate the "(Already exists)" reasoning loop. Pending fresh run to confirm.
- [ ] **Gemma skips source-reading and fabricates from training.** Observed 2026-04-27 in YOLO e2e. Gemma's reasoning explicitly stated "I should `get` data.txt", "I will start by getting data.txt" — but the actual emission was `<set unknown://...>` in Definition Stage. Then in subsequent turns she emitted `<update status="200">Fact 1, Fact 2, Fact 3</update>` — fabricated placeholder text, never `<get>`-ing the source. The state machine's Definition imperative ("YOU MUST ONLY create unknown://") is fighting the natural read-then-act flow. Even with `instructions_105.md`'s "ONLY from promoted information" rule, the model bypasses source-reading and uses training. System-side bug to investigate: state-machine ergonomics for small models on simple research tasks; possibly the file-summary projection (which shows symbols-only and reads as "complete" to the model) is hiding the need to promote.

### YOLO mode (2026-04-27, ACTIVE FOCUS)

The benchmark work surfaced two missing harness capabilities. **Benchmarking is paused until both are properly settled.** Per user direction: "the first and only goal of benchmarking is surfacing these sorts of concerns. The benchmarking did its job, which is showing how our agent harness is missing important features and functionality."

**The gap YOLO closes:** AuditClient implements ~30% of headless-client behavior (file edit + rm). Shell execution is missing entirely — sh/env plugins create empty streaming entries and rely on a connected client to actually run the command. There's no path for a run to be fully autonomous without a human at a terminal.

**Design (parallel to existing `noFoo` flags):** `yolo: true` is a run attribute. When set, a YOLO plugin auto-resolves every proposal server-side AND spawns sh/env commands streaming output to the data channels.

**Active checklist:**
- [x] Plumb `yolo` attribute through rpc.js (3 sites: dispatchRunSet, fork path, inject) + AgentLoop loop config (#run, #drainQueue, #executeLoop, inject)
- [x] Write initial `src/plugins/yolo/yolo.js` (NOT verified — `core.db` and `core.hooks.projectAgent` access patterns assumed, untested)
- [ ] Verify plugin hook-access patterns by reading sibling plugins (error.js, set.js); fix where wrong
- [ ] **Refactor existing e2e tests to use `yolo: true`** instead of the AuditClient-side `#applySetToDisk`/`#applyRmToDisk` hacks. The hacks become unnecessary once YOLO handles this server-side. Audit `test/e2e/`, `test/integration/`, `test/live/` for proposal-handling workarounds.
- [ ] Confirm streaming integration: shell stdout/stderr append to `{path}_1`/`{path}_2` channels; finalize transitions channels to terminal status. Mirrors the existing `stream`/`stream/completed` RPC contract — just done in-process.
- [ ] SPEC.md `{#yolo_mode}` anchor documenting the contract: when set, server emulates a connected headless client; sh/env execute in `projectRoot`; proposals auto-accept; output streams to channel entries; non-YOLO runs are unaffected.
- [ ] Integration test `test/integration/yolo.test.js` referencing `@yolo_mode` — covers proposal auto-accept, sh execution + streaming, env execution, file-edit auto-accept, rm/mv/cp auto-accept.
- [ ] E2E test (test/e2e/) covering a YOLO run that edits a file, runs a shell command, and lands status 200 without any client-side proposal handling.
- [ ] Confirm AuditClient's `#applySetToDisk`/`#applyRmToDisk` become defunct for YOLO runs and remove them (or scope them to non-YOLO only) once the e2e refactor is done.

### `rummy.repo` lazy/hierarchical mode (next, after YOLO lands)

The benchmark also surfaced this. Current `rummy.repo` enumerates every tracked file at scan time. Even at "summarized" visibility (symbol-only projection), 5000 file entries blow gemma's 32K window before turn 1.

The harness needs a way to gracefully handle "repo too big for the context window" — by giving a hierarchical/symbolic overview at first scan, with individual file entries materialized lazily as the model `<get>`s them. This is the next focus once YOLO is settled.

### Benchmarks (revisit after YOLO + rummy.repo lazy mode)

MAB ditched (intelligence test, not recall — misfit for the harness). LME oracle row 0 working (1/1 pass). SWE-bench Verified Mini scaffolded (`test/swe/`, smoke test passed end-to-end on row 0 grok). Full benchmark runs deferred until the harness gaps are closed.
