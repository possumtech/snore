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

- [ ] **Bespoke error path audit.** Sweep the codebase for
  model-facing error handling that bypasses `hooks.error.log.emit`.
  Covers:
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

- [ ] **AuditClient YOLO-redundancy audit.** With YOLO server-side,
  `AuditClient.#applySetToDisk` / `#applyRmToDisk` are redundant for
  YOLO runs. The non-YOLO path (rummy.nvim style) still uses them.
  Decide: keep for non-YOLO compatibility, scope explicitly, or
  deprecate as nvim moves to YOLO-by-default.

- [ ] **Three-tier ladder e2e.** Current e2e tests verify YOLO and
  basic dispatch; none specifically validate the
  archived → summarized → visible bulk-promote-skim-demote idiom on
  a real multi-file project.

- [ ] **`<summarized>` / `<visible>` split in packet structure.**
  Proposal (parked during 2026-04-27 audit): replace single `<context>`
  block with two stable blocks — `<summarized>` (every known entry's
  summary, immutable across promotes/demotes) and `<visible>` (full
  bodies of currently-promoted entries, append-on-promote /
  remove-on-demote). Each promoted entry exists in both. Separates
  identity ("what I know") from state ("what I'm actively reading"),
  which matches the expert / working-memory analogy and dramatically
  improves prefix-cache behavior since promote/demote — the most
  common operations — only mutate `<visible>`. Token cost: ~30 tokens
  × number of promoted entries (the duplicated summary). Worth
  investigating after the audit completes; currently parked.

- [ ] **Unit test failures in `src/plugins/budget/budget.test.js`.**
  At least one suite ("summarized aggregate line, no per-entry rows
  for summarized") fails on `assert(table.includes("summarized"))`.
  Pre-existing; not caused by tbench-CLI work. High priority but
  intentionally deferred to keep the in-flight CLI/tbench thread
  unblocked. Sweep all `src/**/*.test.js` failures, root-cause, fix.

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

- [ ] **Silent cycle-detection strikes.** Currently `error.js#verdict`
  emits a model-facing error entry with `message: "Loop detected"`
  (status 429) and overrides `CONTRACT_REMINDER` with `cycleReason`
  in the continue-reason. Two problems: (1) it tips off the watchdog
  mechanism — a model trying to obey can defeat fingerprinting with
  superficial variation, (2) any verbose "reconsider / use ask_user
  / etc." coaching gives the model a recipe to trick the harness into
  an infinite loop (e.g. ask_user may not even be wired in this run).
  Fix: cycle detection strikes silently. Telemetry-side 429 stays for
  the dev-facing log/run-state; the model gets no special message —
  just the strike, accumulating toward `MAX_STRIKES` abandonment.
  Watchdog enforces by *abandoning*, never by *telling*.

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

**Remaining work surfaced by audit, not yet fixed**:

- Reasoning-vs-emission gap (CC-8a) — model plans actions in
  `reasoning_content`, doesn't emit them. Cross-test pattern.
  Fix is explanation-side, requires instruction edits (sacred).
- `sh`/`env` MUST-clause repetition (CC-12a) — 6 negatives for 2
  binary distinctions. Instruction-side cleanup.
- Test calibration: hydrology inner timeout 300s vs TIMEOUT 360s;
  stories TIMEOUT 480s tight for multi-run sub-tests on local
  gemma. Tweak per-test or move to `test/live/`.
- Persona_fork PF-2: Definition stage doesn't recognize
  fork-inherited knowns; gemma confabulates new unknowns.
  Instruction edit territory.
- `<summarized>` / `<visible>` packet split (parked above) —
  parked; potentially powerful but invasive refactor.

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

**Next steps (in order):**
1. Real LLM smoke — `rummy-cli --RUMMY_PROMPT="..." --RUMMY_MODEL=xfast`
   trivial prompt (~$0.01) to verify the kickoff/terminal/exit path
   end-to-end.
2. `test/tbench/` scaffolding: `setup.sh` (clones harbor fork,
   installs CLI, links rummy adapter), `runner.js` (orchestration),
   `agent/rummy.py` + `rummy-setup.sh.j2` (harbor adapter source
   we'll PR upstream once stable), `.env.tbench` template.
3. `package.json` `test:tbench:*` scripts.
4. Pre-flight: `harbor run --task hello-world --agent rummy
   --model openrouter/x-ai/grok-4.1-fast` (~$0.10).
5. Pre-flight: same for `--agent codex` to verify Codex+grok via
   OpenRouter works at all. Fall back to Goose / Aider if Codex+grok
   has friction.
6. Full eval: 89-task × 3-seed × both adapters (~$30–90).
7. Tabulate + writeup.

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
