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

- [ ] **`notification_log` table.** `rpc_log` captures
  request/response; `run/state` / `run/progress` / `run/proposal`
  fly out untracked. Mirroring the shape would let us replay
  notification streams for diagnosis.

- [ ] **Headless nvim e2e test.** Every new `run.state` telemetry
  field must be manually re-synced in `dispatch.lua` / `state.lua` /
  `statusline.lua`. A test that spins up a headless nvim against
  the server and asserts the statusline renders correctly for a
  known run would catch drift at contract time.

- [ ] **Stress test for `SocketServer.close()` drain.** Kick off N
  concurrent runs, call `close()` mid-flight, assert (a) the close
  awaits, (b) all run entries land terminal, (c) no Promises pin
  the event loop. Locks in the `abortAll` work.

- [ ] **AuditClient YOLO-redundancy audit.** With YOLO server-side,
  `AuditClient.#applySetToDisk` / `#applyRmToDisk` are redundant for
  YOLO runs. The non-YOLO path (rummy.nvim style) still uses them.
  Decide: keep for non-YOLO compatibility, scope explicitly, or
  deprecate as nvim moves to YOLO-by-default.

- [ ] **Three-tier ladder e2e.** Current e2e tests verify YOLO and
  basic dispatch; none specifically validate the
  archived → summarized → visible bulk-promote-skim-demote idiom on
  a real multi-file project.

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

- [ ] **`repo://overview` regression on file operations.** Replacing
  the per-file repo expansion with a single `repo://overview` entry
  cost the model competence on file ops — it no longer sees dozens
  of file entries in the packet, so it doesn't know what's there to
  `<get>`, can't infer naming patterns, and confabulates paths.
  Solvable but a new problem. Likely shape: keep the overview
  summary but restore visible-by-default file entries (or a
  summarized tier the model can promote selectively). Discuss
  before refactor — affects packet shape and budget math.

- [ ] **Productive-turn strike streak reset.** (CC-10 in the audit.)
  Today a strike (e.g. "Missing update") on turn N gets reset to 0
  the moment turn N+1 emits any commands. So a model can confabulate
  for two silent turns, emit one productive-but-unsourced turn, and
  the streak never accumulates toward `MAX_STRIKES`. Question:
  should silent-turn strikes persist across the streak (only a clean,
  non-silent, non-erroring turn resets), or is the current "any
  productive emission resets" the right call? Policy decision —
  affects how aggressively the watchdog terminates confabulation.

- [ ] **Tooldoc example weight.** (CC-13 in the audit.) System prompt
  is ~6KB / ~2K tokens, of which ~5.5KB is tool docs (10 tools × 5+
  examples each). Strong models pattern-match tools from one example;
  weaker models benefit from multiple. Worth measuring same prompts
  with 2-example vs 5-example tooldocs against grok and gemma to
  see if the example density is earning its cost. Benchmark, not a
  fix — frame as a measurement task.

- [ ] **Reasoning-runaway recovery test.** (Audit Open Question 4.)
  Hydrology turn 11 hit context limit on `completion_tokens` runaway.
  No system mechanism currently detects or recovers; per Rummy Way,
  letting the model error out and accumulate strikes is correct.
  But there's no test verifying that path actually terminates. Add
  a test that simulates a model returning ever-larger reasoning
  blocks until context overflow, asserts the run abandons cleanly.

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

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Append entries here only when there's an actually-ongoing
conversation worth tracking across sessions (an in-flight refactor
mid-stream, a deferred decision with a real follow-up, a debugging
thread that hasn't resolved). Landed work belongs in git history;
durable rules belong in the standing rules block above; durable
observations belong in the Lessons section. Don't chronicle what
the diff already records.*

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
- `<summarized>` renders one self-closing summary line per
  `category=data` entry whose visibility is `visible` or `summarized`.
  Plus the named puncture: archived prompts pass through with
  `visibility="archived"` so the active prompt stays discoverable
  after demotion. Carve-out is filter-level explicit, not generalized.
- `<visible>` renders full bodies of `category=data` entries whose
  visibility is `visible`. A visible entry exists in *both* blocks —
  summary line up top (identity), full body below (working memory).
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

**Risks / open questions:**
- Codex's Harbor adapter may not accept `openrouter/x-ai/grok-*`
  cleanly (Codex is OpenAI-tuned). Pre-flight resolves.
- Inside Harbor's docker sandbox, rummy's `<sh>`+YOLO flow needs
  to work robustly. YOLO landed but unproven at tbench scale.
- `RUMMY_MAX_TURNS=15` default likely too low for compile-heavy
  tbench tasks; bump in `.env.tbench`.

**Story angles for the writeup:**
- "Same model, different harness — rummy beat / lost to Codex by X
  points." Cleanest harness-contribution claim.
- Caveat: Codex is OpenAI's harness, sandbagged off-distribution
  on grok. Document, don't hide.
- Cite leaderboard's published 82.0% Codex+GPT-5.5 number for
  context, no re-run on our side.
