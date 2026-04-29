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

## Documentation placement (where each kind of doc belongs)

| Kind | Lives in |
|---|---|
| Non-obvious *why* / hack warning at the site | One-line `//` comment in source, nowhere else |
| *What* the code does | Nowhere — rename until the identifier says it |
| Contract / promised behavior of the system | `SPEC.md`, anchor-tagged so tests can `@`-reference it |
| Plugin's behavior, internal design, helper rationale | `src/plugins/<name>/README.md` |
| Plugin extension surface (events / filters) | `PLUGINS.md` §7 |
| Model-facing guidance at the decision point | `src/plugins/<name>/<name>Doc.js` (tooldoc) |
| Cross-cutting model identity / global rules | `instructions.md` (sacred — touched only on explicit approval) |
| Phase-specific model guidance | `instructions_10N.md` |
| Project state, standing rules, in-flight threads | `AGENTS.md` |

Per-comment decision flow when sweeping source: says *what* → delete;
says *spec* → move to `SPEC.md` / `PLUGINS.md` / plugin README and
delete; warns about a hack/gotcha → trim to one line; duplicates the
constant name → delete.

---

## Where We Are

The contract (SPEC [entries](SPEC.md#entries)) is fully delivered.
Schema, primitives, entry grammar, client RPC surface, plugin hygiene,
and external repo rewrites (`rummy.repo`, `rummy.web`, `rummy.nvim`)
are landed. System instructions are split into a stable base
(identity + tools + tooldocs) plus a dynamic `<instructions>` block
that rides the user message to keep prompt caching intact. Lifecycle
handshake, budget math, and fallback hygiene are clean. Phase 7
(verification) is the remaining work; benchmarks (LME, SWE-bench
Verified Mini) are scaffolded and run on demand.

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
- **Phase 7 — Verification** ⌛ Doc walk, demo handoff. See Open Items.

---

## Open Items

- [ ] **System auto-pruning.** On loop boundary or when log size
  crosses threshold, archive `log://turn_{M}/**` where M < current -
  `RUMMY_LOG_HORIZON`. Keeps the log bounded on long runs without
  requiring model intervention.

- [ ] **rummy.nvim migration to pulse + query.** The server side is
  done — the typed `run/state` / `run/progress` / `run/proposal`
  notifications are gone (deleted 2026-04-28). `rummy.nvim` still
  consumes the legacy notifications and must be migrated to the new
  contract documented in `CLIENT_INTERFACE.md`: subscribe to
  `run/changed`, track last-seen entry id per run, call
  `getEntries(run, { since, pattern })` to reconcile, and drive UI
  from the entry stream. Substantial lua refactor across
  `dispatch.lua`, `state.lua`, `statusline.lua`, `diff.lua`, plus
  tests. Cannot be validated from this repo — drive from the nvim
  side. Until migrated, `rummy.nvim` will not function against a
  current server.

- [ ] **Headless nvim e2e test.** A test that spins up a headless
  nvim against the server and asserts the statusline renders
  correctly for a known run would catch contract drift at the wire
  layer. Especially valuable now that nvim is consuming the entry
  stream directly — any change to `getEntries` shape or `run/changed`
  cadence is a silent break otherwise.

- [ ] **Core → plugin extraction conversation.** Audit what still
  lives in `src/agent/*` that could plausibly be a plugin. Top
  candidates: `XmlParser` (syntax-layer; would need a `parser.parse`
  hook in `TurnExecutor`), the cycle-detection / strike machinery
  in `src/plugins/error/error.js` (already a plugin but the verdict
  hook is core-coupled), telemetry side of `AgentLoop.#emitRunState`,
  the YOLO-style "report current run status on resolve ack" RPC
  shaping. The Rummy Way: everything is entries+hooks+plugins; a
  conversation needed to decide which extractions are principled vs.
  ceremony. Discuss before refactor.

- [ ] **Tooldoc example weight.** (CC-13 in the audit.) System prompt
  is ~6KB / ~2K tokens, of which ~5.5KB is tool docs (10 tools × 5+
  examples each). Strong models pattern-match tools from one example;
  weaker models benefit from multiple. Worth measuring same prompts
  with 2-example vs 5-example tooldocs against grok and gemma to
  see if the example density is earning its cost. Benchmark, not a
  fix — frame as a measurement task.

- [ ] **Sudden-death turn warning.** On the last turn of
  `RUMMY_MAX_LOOP_TURNS`, surface an error/notice to the model giving
  it a heads-up that it's on its sudden-death turn — close cleanly
  rather than getting capped mid-thought. Implementation deferred;
  this is a reminder.

## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code.
  Everything the contract doesn't name, isn't there.

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
- **When a model misbehaves, audit the test prompt against the
  documented protocol first.** Don't theorize about model
  non-determinism or harness bugs until you've verified the prompt
  isn't asking the model to violate a documented rule. A prompt that
  says "run `ls` via `<sh>`" violates `shDoc.md`'s "use `<env>` for
  read-only commands" rule, and a small model that obeys the docs
  will struggle. The "small model is flaky" interpretation is almost
  always a prompt smell.
- **Reasoning-runaway is a model pathology, not an instruction
  failure.** Small models can spiral inside `reasoning_content` —
  planning the same action over and over, never emitting it,
  burning completion tokens until the response truncates. The
  model isn't forgetting that XML tags execute; it's stuck. No
  instruction edit reaches a model in this state. The framework's
  answer is the strike-streak watchdog: a single empty-emission
  turn fires a strike, the next productive turn resets, and
  sustained runaways accumulate to abandon. Observed and recovered
  cleanly in the 2026-04-28 demo run (turn 7 = 34K reasoning, 0
  emissions; turn 8 productive; run completed at 200). Don't add
  forward-looking coaching for the runaway state — analyze upstream
  instead (what was the model facing on the turn *before* it
  spiraled?).
- **Stochastic agentic tests should accept the engine's terminal
  set, not just success.** Identical prompts on identical models
  can land 200 or 499 depending on the decision tree the model
  walks. A test asserting strict 200 on an agentic run is flaky by
  construction. Either widen the assertion to `[200, 499]` (or
  whichever set is legitimate for the test's intent) or move the
  test to `test/live/` where stricter outcome verification is the
  whole point. The protocol-as-state-machine guarantees terminal
  reachability, not deterministic success. (Source: CC-8c in the
  E2E audit; seen in `persona_fork` 3rd subtest pre-session.)
- **Block ordering matters for prefix caching.** Within the user
  message, blocks are ordered slowest-mutating-first (top) to
  fastest-mutating-last (bottom). This isn't aesthetic — KV cache
  reuse extends through the longest prefix that matches the prior
  turn, so a block that mutates frequently kills cache for
  everything below it. Current order: `<summarized>` (slow) →
  `<visible>` (per-turn unchanged unless promote/demote) → `<log>`
  (appends per turn) → `<unknowns>` → `<instructions>` (per phase)
  → `<budget>` (recomputed) → `<prompt>` (run-stable, conventionally
  last). The system message stays fully stable post-bifurcation.
  Don't reorder blocks without considering the cache impact at the
  bottom of the order.

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Append entries here only when there's an actually-ongoing
conversation worth tracking across sessions (an in-flight refactor
mid-stream, a deferred decision with a real follow-up, a debugging
thread that hasn't resolved). Landed work belongs in git history;
durable rules belong in the standing rules block above; durable
observations belong in the Lessons section. Don't chronicle what
the diff already records.*

### Pulse + query notification refactor (landed 2026-04-28)

Replaced the typed `run/state` / `run/progress` / `run/proposal`
notification surface with a content-free `run/changed` pulse plus a
`since`-cursor query against the entry store. The entry store is the
source of truth; the pulse is a latency hint that says "go look."
Wire contract documented in `CLIENT_INTERFACE.md`.

Phase A (2026-04-28): pulse + query infrastructure added alongside
the typed notifications.

Phase B (2026-04-28): in-repo consumers (`AuditClient`, e2e tests,
`cli.js`) migrated; then the typed surface deleted entirely —
`AgentLoop#emitRunState`, both `hooks.run.progress.emit` sites in
`TurnExecutor`, `ClientConnection`'s `#onProgress`/`#onState`/`#onProposal`
handlers, `rpc.js`'s `run/state`/`run/progress`/`run/proposal`
notification registrations, and `hooks.run.state`/`hooks.run.progress`
in `Hooks.js`. `hooks.proposal.pending` stays — yolo uses it
server-internally.

Migration of the external `rummy.nvim` consumer remains open (filed
as Open Item).

**What landed:**

- `getEntriesByPattern` (`Entries.js`) accepts a `since` cursor.
  When set, results filter by `e.id > since` and order by id
  (insertion order) for streaming consumers; otherwise results
  order by path (browse mode). Single query method, mode-driven.
- SQL: `get_entries_by_pattern` extended with `:since` filter and
  conditional ORDER BY. One new clause + one ORDER BY branch.
  Results now also carry `id` so callers can track last-seen.
- `getEntries` RPC accepts `since` and `limit` params. Description
  documents the pulse-and-reconcile pattern for clients.
- `run/changed` notification registered in `rpc.js`. Content-free —
  carries `{ run, runId, path, changeType }` for client-side
  filtering, no payload of the changed data itself.
- `ClientConnection#onEntryChanged` subscribes to `entry.changed`,
  looks up the run's project, and forwards a pulse if the entry
  belongs to the client's project. One DB lookup per entry write
  per connected client; cheap.
- New integration test `entries_since.test.js` covers the four
  modes: nothing-past-since, since-with-insertion-order, chunked
  catch-up via limit, and browse mode preserves alphabetical.

**Why this shape:**

Notifications were a parallel mechanism that violated "everything
is an entry." Each typed notification (run/state, run/progress,
run/proposal) packaged information that already lives in the entry
store and runs/turns tables. Same pattern as the search-prefetch
fix and the action-failure-contract alignment: a special-case wire
path replaced by the universal entry-driven flow. The WebSocket
downgrades from "channel of truth" to "go look" hint; the entry
store is the source of truth and the audit log.

**Tests:** 282 unit + 237 integration green.

### Action-failure contract (landed 2026-04-28)

Resolved the bespoke-action-failure-paths Open Item via framework
alignment, not patch-around. Principle:

**The action entry IS its outcome.** Plugin authors finalize their
action's own log entry at `entry.resultPath` with body, state, and
outcome. Success and failure share one shape. The framework reads
post-handler `state="failed"` entries as strikes — no `error.log.emit`
call from plugin authors. `error.log.emit` is the framework's tool
for actionless failures (parser warnings, dispatch crashes, runtime
watchdog, budget overflow). Cycle detection stays silent.

**Framework changes:**

- `TurnExecutor#record` now writes filter-rejected entries to store
  (was: returned in-memory only, model never saw them). Recording-
  filter rejection is now visible to the model the same way
  handler-time rejection is.
- `error.js#verdict` strike attribution: queries store for the
  post-handler state of each recorded entry; any `state="failed"`
  counts as a strike. Either channel (action-entry state=failed or
  `error.log.emit`'s `turnErrors` increment) advances the streak.

**Plugin migrations to single-call shape:**

- `policy.js` dropped its `error.log.emit` dual-write — recording
  filter returns the entry with state=failed; framework writes it.
- `get.js`, `set.js`, `unknown.js` — handler-time validation/dedup
  failures now write `state="failed"` to the action entry instead of
  emitting separate `<error>` entries.
- `update.js` — validation rejection writes `state="failed"` to the
  action entry; dropped the dead-code `attributes.rejected=true`
  signal (it never propagated correctly because handler's local
  `attributes` was scoped to the rummy.update() call, not the
  recorded entry; resolve() always saw `rejected=undefined`). The
  CC-5 status-200 navigation check now actually works.
- `TurnExecutor.js` — proposal/entry-failure error.log.emit calls
  removed; the action entry's own state=failed is the strike signal.

**Documentation:**

- SPEC `{#failure_reporting}` — contract, strike attribution, what
  `error.log.emit` is for, recording-filter behavior, cycle silence.
- SPEC `{#mode_enforcement}` — policy uses entry-state directly.
- PLUGINS.md `{#plugins_handler_outcomes}` — canonical handler shape;
  explicit "you don't call error.log.emit" for third-party authors.

**Tests:** 280 unit + 229 integration green. `get.test.js` and
`set_visibility.test.js` updated to assert the new shape (the old
tests had been pinned to the dual-channel pattern).

The eight previously-flagged "bespoke" action-failure sites
(`known.js`, `get.js`, `set.js`, `rm.js`, `TurnExecutor.js`) are now
genuinely exemplary — both visible AND strike-bearing through one
write each.

### Packet shape: `<context>` → user-side `<summarized>` + `<visible>` (landed 2026-04-28)

Bundled change driven by the audit's CC-1 finding plus the parked
`<summarized>` / `<visible>` proposal. Resolved both Open Items.

**What landed:**

- `known.js` no longer registers on `assembly.system`. Two new filters
  on `assembly.user`: `assembleSummarized` (priority 50) and
  `assembleVisible` (priority 75). System message stops carrying
  data-surface entries; system is now identity + tools + base
  instructions only.
- `<summarized>` renders each `category=data` entry whose visibility
  is `visible` or `summarized` under its scheme tag, with the plugin's
  summary projection as the tag body (truncated knowns, code symbols
  for files, page abstracts for URLs — whatever each plugin's
  `summary()` hook produces). Plus the named puncture: archived prompts
  pass through with `visibility="archived"` so the active prompt stays
  discoverable after demotion.
- `<visible>` renders each `category=data` entry whose visibility is
  `visible` under its scheme tag with the plugin's visible projection
  as the tag body. A visible entry exists in *both* blocks — summary
  projection up top (identity), full body below (working memory).
- `materializeContext` stores both projections (`vBody` / `sBody`) on
  each row so the two blocks read from the right one without
  re-projecting in the filter.
- Why: matches every major harness convention (Aider, Claude Code,
  Cursor, Codex all put codebase context user-side). Models are
  trained to expect dynamic file/repo content user-side. And the
  split keeps `<summarized>` cache-stable across promote/demote (the
  dominant intra-phase operation) — only `<visible>` mutates fast.
- SPEC.md `{#packet_structure}` and `{#scheme_category_split}`
  rewritten; plugin READMEs (known, log, env, sh, stream) updated.
- Tests: `ContextAssembler.test.js` and `message_assembly.test.js`
  rewritten to assert the new shape. 281 unit + 229 integration green
  post-change.

**Not yet done (sacred-prompt batch):**

Tooldoc updates teaching the model that summary lines live in
`<summarized>` and full bodies in `<visible>`, and that promote =
"add full body to `<visible>`" / demote = "remove from `<visible>`,
summary line stays." Belongs in the next focused instruction-edit
session.

### Comment hygiene sweep (landed)

Every multi-line comment in `src/` cut to one line, moved to docs, or
deleted. Final sweep across `src/agent/*`, `src/plugins/*/`,
`src/server/*`, `src/llm/*`, `src/sql/*`, and `src/hooks/*` found
zero remaining `/* */` blocks and zero ≥2-line `//` runs in
production code. The earlier targeted edits (`config.js`,
`telemetry.js`, `prompt.js`, `cli.js`, `error.js`, `instructions.js`,
`v_model_context.sql`, `001_initial_schema.sql`) had already drained
the surface. 509/509 unit + integration green post-sweep.

### E2E packet audit + system fixes (landed)

Comprehensive packet-level audit of every e2e test surfaced 13+
cross-cutting findings. Multiple system bugs identified and fixed.
See `E2E_ANALYSIS.md` for the full audit document.

**System fixes landed this session**:

- **Cycle detection empty-turn gate** (`error.js`) — fingerprint now
  always pushed (even for empty turns), so 3+ consecutive
  no-emission turns trip period-1 cycle detection.
- **Status 200 navigation check** (`instructions.js`) — `validateNavigation`
  rejects status 200 from non-Deployment phases.
- **Active prompt archive exception** (`v_model_context.sql`,
  `prompt/README.md`) — archived prompts (singular exception)
  flow through to packet with `visibility="archived"` and empty
  body, so the model can `<get>` to promote back. Resolved
  recurring "No prompt provided" failures.
- **`turn_context.visibility` CHECK constraint** relaxed to permit
  `'archived'` (was hardcoded to visible/summarized).
- **Telemetry `#turnLog` reset** moved from RPC-method-name check
  (legacy 1.x) to alias-change detection in `#logMessages` —
  multi-test dump pollution resolved.
- **Per-turn dump slicing** (`telemetry.js`) — `turn_NNN.txt` now
  contains only that turn's content (was cumulative).
- **`TestDb.create({ home })` option** — sets `RUMMY_HOME` BEFORE
  plugin construction so telemetry's `#turnsDir` initializes.
  Restored turn-dump capture for stories and hydrology tests.
- **SQL view sort** changed to `(category, scheme, turn,
  updated_at, path)` — entries within a scheme stay in turn-order;
  promote/demote no longer shifts position; cache-friendly on
  real-cache providers.
- **Config consolidation** (`src/agent/config.js`) — 9 required
  env-driven scalars (BUDGET_CEILING, LLM_DEADLINE_MS,
  LLM_MAX_BACKOFF_MS, FETCH_TIMEOUT, MAX_STRIKES, MIN_CYCLES,
  MAX_CYCLE_PERIOD, RUN_TIMEOUT_MS, THINK) consolidated. 11
  scattered `if (!X) throw...` removed across 8 consumer files.
  Single error message listing every missing/invalid var at boot.
- **Hydrology 16-turn cap removed** — state machine gets room to
  bounce per the user's principle.
- **`fcrmScore` removal** (`budget.js`) — opaque-to-model metric
  with no telemetry consumer eliminated.
- **`RUMMY_MAX_STALLS` and `RUMMY_MAX_UPDATE_REPEATS`** retired
  from `.env.example` and SPEC. Cycle detection (gate-fixed) is
  the unified mechanism.

**Test status**: 509/509 unit + integration green throughout. E2E
went from 26/31 (pre-session) to demonstrably-improved post-fix:
`factual answer from context` now passes (was the canonical "No
prompt provided" failure). Two more tests changed shape from
"system bug → fast assertion fail" to "test calibration tight →
timeout while engine works correctly" (`prompt coherence`,
`accepted edits visible on next turn`).

**Remaining work surfaced by audit (non-instruction)**:

- Test calibration: hydrology inner timeout 300s vs TIMEOUT 360s;
  stories TIMEOUT 480s tight for multi-run sub-tests on local
  gemma. Tweak per-test or move to `test/live/`.
- `<summarized>` / `<visible>` packet split (parked in Open Items) —
  parked; potentially powerful but invasive refactor.

### Instruction-side findings (gathering for a focused session)

Sacred prompts (`prompt.ask.md`, `prompt.act.md`,
`instructions.md`, `instructions_10N.md`, `*Doc.md`) get edited
together in a single deliberate pass, never piecemeal. As the audit
surfaces instruction-side issues, append here. When the list feels
saturated, request explicit go for a focused instruction-edit
session and work the batch.

- **CC-8a — Reasoning-vs-emission gap.** Model plans actions in
  `reasoning_content`, doesn't emit them. Cross-test pattern.
  Explanation-side fix.
- **CC-12a — `sh`/`env` MUST-clause repetition.** 6 negatives for
  2 binary distinctions. Tooldoc cleanup.
- **PF-2 — Persona_fork Definition stage.** Doesn't recognize
  fork-inherited knowns; gemma confabulates new unknowns.
  Likely instruction-side.
- **`repo://overview` file-op regression.** Open Item filed; the
  fix is partly packet-shape (system) and partly instruction-side
  (teach the model how to navigate the overview / when to expand).
  Cross-reference once packet-shape decision lands.
- **`<summarized>` / `<visible>` packet split — model orientation.**
  Tooldocs need to teach: summary lines live in `<summarized>` (your
  identity-keyed map of what exists); full bodies live in `<visible>`
  (your current working set). Promote `<get>`s a summarized entry into
  `<visible>`. Demote drops it back. The structural split changes how
  the model should reason about its working memory; tooldoc examples
  should reflect the new shape.

### terminal-bench 2.0 / Harbor wiring (2026-04-27, in flight)

**Goal.** Land rummy on the terminal-bench 2.0 leaderboard
(https://www.tbench.ai/leaderboard/terminal-bench/2.0). Submission
runs via Harbor (`harbor run --dataset terminal-bench@2.0 ...`),
not the legacy `terminal-bench` repo's `installed_agents/`.
Comparison: **rummy+grok vs codex+grok**, same model both sides,
harness-only delta. Cost-bound to ~$30–90 by avoiding the GPT-5.5
re-run (cite the public leaderboard number for that). User is fine
publishing negative results.

**Locked decisions.**
- Model alias: `xfast` = `openrouter/x-ai/grok-4.1-fast` via
  OpenRouter BYOK (`OPENROUTER_API_KEY`).
- Comparison harness: Codex (Harbor's `codex` adapter).
- Adapter approach: fork `laude-institute/harbor`, add
  `src/harbor/agents/installed/rummy.py` (BaseInstalledAgent subclass).
- CLI client: in-process, `src/plugins/cli/` plugin + bin
  (faster/simpler than subprocess+WebSocket, uses ProjectAgent
  directly via boot.completed hook).
- Env-var-everywhere: all config uses `RUMMY_*` prefix; CLI flags
  are 1:1 with env names (`--RUMMY_YOLO=1`, `--RUMMY_PROMPT="..."`).
  No second naming surface. Profile cascade via Node's
  `--env-file-if-exists=.env.tbench`.
- Test scaffolding lives in `test/tbench/`, mirrors `test/swe/`.

**Landed (this session):**
- AgentLoop boundary normalization: `RUMMY_NO_REPO`,
  `RUMMY_NO_WEB`, `RUMMY_NO_INTERACTION`, `RUMMY_NO_PROPOSALS`,
  `RUMMY_YOLO` env defaults trump-only-if-unset (`options ??
  process.env.X === "1"`). Both `ask`/`act` start path AND `inject`
  continuation path patched.
- `.env.example` documents the new run-attribute defaults
  (commented out, with profile-cascade note).
- `hooks.boot.completed` event — fires after DB open + plugin init
  + model bootstrap + hygiene, before SocketServer attaches. Plugin
  extension point per the standing rule.
- `src/plugins/cli/`: `cli.js` (subscribes to boot.completed,
  programmatic ProjectAgent kickoff, exit-on-terminal),
  `bin.js` (executable, env-shape arg parser, mirrors bin/rummy.js
  prelude), `README.md`. `package.json` registers `rummy-cli` bin.
- Smoke verified: invalid-arg → exit 2, missing required env → exit
  2, server-mode boot path clean. Integration: 228/228 green.

**Landed 2026-04-28:**
- Real LLM smoke ✓ — `rummy-cli --RUMMY_PROMPT="What is 2+2?"
  --RUMMY_MODEL=xfast --RUMMY_MODE=ask --RUMMY_YOLO=1
  --RUMMY_NO_INTERACTION=1 --RUMMY_NO_REPO=1 --RUMMY_NO_WEB=1
  --PORT=3050`. 4 turns, status 200, exit 0, stdout: `2 + 2 = 4`.
  Kickoff/turn-pipeline/terminal/exit path verified end-to-end on
  grok-4.1-fast.
- Two findings filed as Open Items:
  (a) **rummy-cli must imply YOLO by default** — without it, any
  proposal-emitting tool (including `<env>` in ask mode) hangs the
  in-process CLI forever.
  (b) **`PORT` env var doesn't follow the `RUMMY_` prefix
  convention** — rename to `RUMMY_PORT`.

**Landed 2026-04-28 (continued):**
- rummy-cli auto-yolo when `RUMMY_PROMPT` is set ✓ — operator can
  override with `--RUMMY_YOLO=0`. Re-smoke validated termination
  without explicit `--RUMMY_YOLO=1`.
- `PORT` → `RUMMY_PORT` rename ✓ — `service.js`, `.env.example`.
  Two lines, contained; no other callers.

**Next steps (in order):**
1. `test/tbench/` scaffolding: `setup.sh` (clones harbor fork,
   installs CLI, links rummy adapter), `runner.js` (orchestration),
   `agent/rummy.py` + `rummy-setup.sh.j2` (harbor adapter source
   we'll PR upstream once stable), `.env.tbench` template.
2. `package.json` `test:tbench:*` scripts.
3. Pre-flight: `harbor run --task hello-world --agent rummy
   --model openrouter/x-ai/grok-4.1-fast` (~$0.10).
4. Pre-flight: same for `--agent codex` to verify Codex+grok via
   OpenRouter works at all. Fall back to Goose / Aider if Codex+grok
   has friction.
5. Full eval: 89-task × 3-seed × both adapters (~$30–90).
6. Tabulate + writeup.

**Spirit clause (load-bearing):**
- Goal is harness analysis + general improvement, not a leaderboard
  number. Any tbench-driven change must be a *general* improvement
  benefiting any agent task — no benchmark-specific prompts,
  heuristics, or tools. Pitch must remain "rummy is a general agent
  that just happens to perform well at tbench," not "rummy is tuned
  for tbench."
- Pre-flight task selection must be a representative cross-section,
  never cherry-picked for likely passes.
- The harbor adapter (`rummy.py`) stays vanilla — it's a protocol
  bridge, not a benchmark booster.

**Risks / open questions:**
- Codex's Harbor adapter may not accept `openrouter/x-ai/grok-*`
  cleanly (Codex is OpenAI-tuned). Pre-flight resolves.
- Inside Harbor's docker sandbox, rummy's `<sh>`+YOLO flow needs
  to work robustly. YOLO landed but unproven at tbench scale.
- `RUMMY_MAX_LOOP_TURNS` is per-loop only (no per-run cap), so the
  default 99 is fine for tbench. Re-evaluate if per-loop drift
  becomes a problem.

**Story angles for the writeup:**
- "Same model, different harness — rummy beat / lost to Codex by X
  points." Cleanest harness-contribution claim.
- Caveat: Codex is OpenAI's harness, sandbagged off-distribution
  on grok. Document, don't hide.
- Cite leaderboard's published 82.0% Codex+GPT-5.5 number for
  context, no re-run on our side.
