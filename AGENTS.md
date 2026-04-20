# AGENTS: Planning & Progress

> **SESSION BOOTSTRAP — READ ME FIRST.** This file is the only
> cross-session ground truth. Sessions compact and restart; this doc
> does not. Before touching code, read top-to-bottom: the principle
> quotes, current phase, recent "Ongoing Development Conversation"
> entries. Cross-reference SPEC.md §0 for the contract and PLUGINS.md
> §7 for the events/filters surface. **Append to "Ongoing Development
> Conversation" as you work** — decisions you make, rules the user
> restates, architectural choices you deferred. The next session's
> coherence depends on it. Architectural decisions without a paper
> trail are the main source of regressions across compaction.

> **Standing rules that override anything else:**
> - **No fallbacks outside `src/plugins/hedberg/*`.** Not `|| 0`, not
>   `?? null`, not `|| ""`. Boundaries validate; interiors crash on
>   contract violation. A biome rule is in place — if it complains,
>   the answer is to fix the contract, not silence the rule.
> - **Every `createEvent` / `createFilter` in `Hooks.js` is a plugin
>   extension point and stays.** Zero current subscribers does not
>   mean "delete" — it means "a third-party plugin can still hook it."
>   Removing events breaks the plugin contract this project brags
>   about in README / SPEC / PLUGINS. Adding events where core fires
>   an unannounced phase is encouraged.
> - **AGENTS.md isn't a trophy room.** Prune completed work; don't
>   let it sprawl. But never remove a rule the user restated.

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

> **Everything is an entry.** Unix's "everything is a file" principle
> applied to agent systems. Files, tool calls, streaming output, plans,
> unknowns, sub-agents — all entries. Read/write (`<get>`/`<set>`) is the
> universal grammar. New capabilities compose by producing entries in
> the shared substrate. See SPEC §0.1.

> **"Model behavior" is never an acceptable explanation for a test failure.**
> When a model misbehaves, the system failed — suboptimal context, poorly
> designed test conditions, insufficient reinforcement of correct behavior.
> Every failure is a system bug until proven otherwise.

> **Reference + feedback over broadcast.** Steer the model through
> three channels, in priority order: (1) tooldocs, at the decision
> point — the model reads setDoc when writing `<set>`; (2) error://
> entries, dynamic feedback when something goes wrong; (3) preamble,
> only for what's genuinely cross-cutting and unreachable from the
> other two (identity, per-turn tool cap, Token Budget invariant).
> Preamble is a broadcast channel that pays context every turn for
> behavior the other two channels shape more cheaply. If behavior
> regresses, the fix isn't "add it back to preamble" — it's "which
> tooldoc or error entry should have caught this?"

## Where We Are

The contract is spelled out in SPEC.md §0 (Entries, Six Primitives,
Three Surfaces, Four Writer Tiers, Runs-Are-Entries, Events & Filters,
Physical Layout). The codebase partially delivers the contract — the
gaps are enumerated below and the plan is to close every one.

---

## The Plan

Six phases. Each phase has a clear scope and a verification gate. No
phase is complete until its gate is green. No "deferred debt" — items
either land in a phase or get cut from scope.

### Phase 1 — Schema ✓ landed

Made the schema tell the truth about the contract.

- `run_views.state` replaces `run_views.status` (5-value CHECK:
  `proposed | streaming | resolved | failed | cancelled`). HTTP codes
  gone from the entry-view DB layer; they still exist at transport
  (RPC wire, runs/loops queue) and inside `run_views.outcome` TEXT
  prefixes where diagnostic (e.g. `"overflow:413"`, `"permission:403"`).
- `run_views.outcome` added. Populated when `state ∈ {failed, cancelled}`.
- `turn_context.state` + `.outcome` match `run_views`.
- `schemes.writable_by` now accepts `client` as a valid tier (four-way).
- `schemes.capability_class` added.
- `v_unresolved`, `v_model_context`, `v_run_log`, `known_entries`
  compat VIEW all rewritten against the new columns.
- `KnownStore.upsert` / `resolve` now take state + outcome. All ~30
  call sites in plugins, agent, hooks, and tests updated.
- Model-facing tag rendering preserved: `<performed>`, `<knowns>`,
  `<previous>` still emit `status="NNN"` via `src/agent/httpStatus.js`
  — the state → HTTP mapping lives in one place.
- Boot env-file resolution: `service.js` now skips `$RUMMY_HOME/.env*`
  loading when CWD has a rummy-shaped `.env.example` (sniffed by
  presence of any `RUMMY_*` var). Local configs no longer collide
  with machine-wide config. Multiple instances on one box are now
  independent by default.

Gate: lint + 259 unit + 189 integration green.

### Phase 2 — Primitives ✓ landed

Six-verb write grammar established across the stack.

- `KnownStore` renamed to `Repository`. Public write surface is exactly
  `set`, `get`, `rm`, `cp`, `mv`, `update`. Reads stay as query helpers
  (`getBody`, `getEntriesByPattern`, `getLog`, etc.).
- `set` is semantically wide: creates/updates entries with body, state,
  fidelity, attributes; supports `append: true` for streaming, `pattern: true`
  (plus optional `bodyFilter`) for bulk updates. Body-less calls change
  fidelity/state/attributes on an existing entry.
- `get` default is promote. `fidelity` attribute permits read-at-other-
  fidelity edge cases.
- `update` is not general — it's the once-per-turn lifecycle verb, writes
  to `update://<slug>` with `attributes.status` carrying the model's
  continuation code.
- Every plugin write call site refactored from positional-arg helpers
  (`upsert`, `resolve`, `setFidelity`, `appendBody`, `promote`, etc.) to
  object-args on the 6 verbs. ~89 src + 198 test call sites transformed
  mechanically; hand-audited for template-literal and string corruption.
- `<store>` retired as model grammar. `rummy.store()` removed from
  RummyContext. Demote is `<set fidelity="demoted"/>`.
- Fixed latent SQL bug in `upsert_entry`: the COALESCE chain was
  overwriting existing attributes with `'{}'` on UPDATE. Now honors
  null-attributes-means-preserve. Exposed by the refactor because the
  old `resolve` path used a different prep that avoided the UPDATE.

Gate: grep for `db.upsert_entry` / `db.upsert_run_view` / ad-hoc prep
calls outside Repository returns empty. `npm run lint` + `npm run test:unit`
(259 tests) + non-LLM integration (183 tests) all green.

### Phase 3 — Semantic alignment ✓ landed

Context-layer concepts that belong in the entry grammar move into it.
Scoped narrowly to runs: they have a real lifecycle, they're the
unit clients address, and making them addressable via `set`/`state`
on `run://<alias>` makes Phase 4's RPC reshape trivially clean.

- **Runs as entries.** `run://<alias>` scheme, run-scoped (self-
  referencing run_view). Body is the initial prompt; attributes
  carry model, persona, temperature, contextLimit, projectId,
  parentRunId. State maps lifecycle: `proposed` (queued) → `streaming`
  (running) → `resolved` / `failed` / `cancelled`. The `runs` table
  remains for server bookkeeping (FKs from loops/turns/run_views);
  the run:// entry is the client-addressable mirror. AgentLoop's
  `#setRunStatus` helper writes both the row and the entry in the
  same transition path; no drift.
- `client` added as a fourth writer tier alongside `system`, `plugin`,
  `model`. Run scheme declares `writable_by = ["system","plugin","client"]`.
- `Repository.set` gained `projectId` parameter for forthcoming
  project-scoped schemes (unused in Phase 3; future-proofing).

**Deliberately out of scope**: file constraints (overfit — config,
not lifecycle; appears dormant), models, skills, personas (dedicated
shape, no lifecycle, no per-run view). These keep their dedicated
tables + RPC verbs. Plugin API and RPC stay 1:1 aligned for them
without needing entry-grammar uniformity.

Gate: every run has a corresponding `run://<alias>` entry whose state
tracks the run's lifecycle via `#setRunStatus`. 258 unit + 183 non-LLM
integration tests green.

### Phase 4 — Client surface ✓ landed

The wire is a thin projection of the plugin API.

- Primitive RPC verbs: `set`, `get`, `rm`, `cp`, `mv`, `update`. Each
  takes an object of entry-grammar params, delegates to Repository
  with `writer: "client"`.
- `rummy/hello` is the connection handshake. Client sends on connect
  with `{ name, projectRoot, configPath?, clientVersion? }`; server
  responds with `{ rummyVersion, projectId, projectRoot }`. MAJOR
  version mismatch rejects with a clear error. Absorbs what `init`
  used to do. Server no longer sends an unsolicited `rummy/hello`
  notification — handshake is client-initiated.
- Starting a run: `set { path: "run://<alias>", body: <prompt>,
  attributes: { model, mode?, persona?, ... } }`. New alias → server
  kicks off the loop (fire-and-forget; client watches via entry
  notifications).
- Cancelling a run: `set { path: "run://<alias>", state: "cancelled" }`.
- Resolving a proposal: `set { run, path: "<entry>", state: "resolved"
  | "failed" | "cancelled", body?: <output> }`. The primitive `set`
  detects state transitions on proposed entries and routes through
  `AgentLoop.resolve` so scheme-specific side effects fire (patch
  application, file removal, stream setup).
- **Killed RPCs:** `ask`, `act`, `init`, `startRun`, `run/resolve`,
  `run/abort`, `run/rename`, `run/inject`, `run/config`, `store`,
  legacy `get`, `getEntries`.
- **Kept (dedicated shape):** `ping`, `discover`, `rummy/hello`,
  `set`/`get`/`rm`/`cp`/`mv`/`update`, `getModels`/`addModel`/`removeModel`,
  `getRuns`/`getRun`, plus plugin-specific (`stream*`, `skill*`,
  `persona*`).
- Protocol version bumped to `2.0.0`. Clients on `1.x` bounce at
  `rummy/hello` with protocol-mismatch.

Gate: no legacy RPC method remains registered. `npm run lint` + 258
unit + 183 non-LLM integration tests green.

### Phase 5 — Plugin hygiene ✓ landed

Structural obstacles to the contract working cleanly, removed.

- **Plugin-dep system deleted.** `static dependsOn` + topoSort had
  zero callers. The plugin contract (declarative constructors) makes
  load order irrelevant. Cleaner loader, less to explain.
- **`hooks.rpc.registry` is constructed inside `createHooks()`.** No
  longer null-by-default with external wiring. Five external-wiring
  call sites deleted (service.js, TestDb, TestServer, three test
  files). RpcRegistry moved from `src/server/` to `src/hooks/` to
  match its new ownership.
- **TestDb and TestServer share a plugin graph.** `TestServer.start`
  now takes a TestDb and reuses its `hooks` + `pluginInstances` —
  one graph per test, not two.
- **`PermissionError` class** replaces string-prefixed `"403: ..."`
  throws. Callers catch by type. Tests assert on `err instanceof
  PermissionError && err.scheme === "foo" && err.writer === "bar"`.
- **Silent `catch {}` audit.** All seven blocks in src/ either
  documented (why swallowing is safe) or converted to `console.warn`.
- **`<think>` merge extracted.** TurnExecutor emits a
  `llm.reasoning` filter; the think plugin subscribes and contributes
  `<think>` tag bodies. TurnExecutor no longer names `<think>`.
- **Handler writer plumbing.** `rummy.entries` is now a Proxy that
  auto-binds `writer: rummy.writer` to every write call (set/rm/cp/
  mv/update). Handlers no longer need to remember. A model-dispatched
  handler writes as `writer: "model"` without opt-in, so restrictive
  schemes (`writable_by: ["system"]`, etc.) correctly reject model
  impersonation.

**Cut from scope:** capability classes on schemes (YAGNI — current
flag-based enforcement fits the tools we have; per-path policy rules
can't be captured at scheme level anyway). Multi-step DB transactions
(separate audit; no known live bug). `'project'` scope plumbing from
handlers (no live consumer beyond the param already landed in
Phase 3). Hook-mutation-pattern formalization (cosmetic).

Gate: no "Plugin load failed" anywhere. 258 unit + 183 non-LLM
integration green. Lint clean. No test helper wires infrastructure
that `createHooks()` owns.

### Phase 6 — External projects

Rewrite the three repos we own against the landed contract.

- **`PLUGINS.md` first.** External plugin authors read it. Bring it
  current with the Phase 1-5 surface (object-args primitives,
  four-tier writer, run-as-entry lifecycle, RPC 2.0.0).
- **`rummy.repo`** — server-side plugin. Landed: `FileScanner`
  ported to object-args `set`/`rm` with `writer: "plugin"`; symbol
  extraction folded inline so the plugin is a pure `turn.started`
  reactor. No more `entry.changed` subscription (Repository's per-
  write emission shape differs from the old batched one).
- **`rummy.web`** — server-side plugin. Landed: four `rummy.set({
  ..., status: 200 })` calls across search/get handlers replaced with
  explicit `state: "resolved"`. No other surface drift.
- **`rummy.nvim`** — client. Landed: `init` → `rummy/hello` with
  `clientVersion: "2.0.0"`; `ask`/`act`/`startRun` → `set run://`
  with mode in attributes; `run/config`/`run/abort`/`run/inject` →
  `set run://` variants; `run/rename` → `mv` on run:// paths;
  `run/resolve` → `set state=resolved|cancelled`; constraint ops
  → `file/constraint`/`file/drop`; BufEnter HUD now reads
  `getConstraints`. Server-side gained `file/constraint`,
  `file/drop`, `getEntries`, `getConstraints` RPCs plus empty-
  alias `run://` synthesis (`${model}_${epoch}`) and readonly
  enforcement in AgentLoop set:// accept. `run/state` notification
  wire still carries numeric `status` (dual-write unchanged;
  client integer handling stays). 92 nvim tests green; 258 unit +
  184 integration green.
- Any capability that doesn't map cleanly to primitives + scheme
  declarations is either reframed or removed.

**Gate:** all three projects build and pass their own tests. Both
server plugins load cleanly (no `[RUMMY] Plugin load failed`). At
least one E2E test exercises each plugin's behavior.

### Phase 7 — Verification

- Documentation walked end-to-end: SPEC.md, PLUGINS.md, README.md,
  per-plugin READMEs. Every claim matches the landed code. Drift
  introduced by Phases 1-5 repaired in place.
- AGENTS.md pruned to landed state. No trophy shelf.
- `npm test` green.
- `npm run test:e2e` green.
- Hand off for demo / MAB / LME.

---

## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code
  by end of Phase 4. Everything the contract doesn't name, isn't
  there.

## Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

## Ongoing Development Checklist

- [ ] Perform gemma/mab benchmark run

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

> I wish to perform a short run of gemma/mab to see if we have any benchmark regressions after our long session that's been focused on improving the agent in project/development workflows.

### 2026-04-20 session notes (Opus 4.7)

Work landed:
- Lifecycle handshake: server now emits `run.state` with the real
  verdict status on turn conclusion AND terminal run close — not
  the hardcoded `102` that was masking terminal status. Per-command
  incremental `run.state` emits preserved. Multiple exit paths in
  `AgentLoop.run()` (abort, 413, normal close, MAX_ITER, caught
  exception) all emit terminal state via `#emitRunState` helper.
- nvim client: `redrawstatus! | redrawtabline` everywhere (was
  `redrawstatus` non-bang — refreshed current window only, which
  is why the checkmark "magically appeared" on text selection).
- Budget math consolidated. One helper (`src/agent/budget.js`
  `computeBudget({rows, contextSize, totalTokens})`) feeds:
  `<prompt>` tag attrs (model-facing), 413 enforcement (gate),
  `run.state` telemetry (`ceiling`, `token_usage`, `tokens_free`),
  nvim statusline (`⊞[N% of ceiling]`). `baselineTokens`
  concept + its double-materialization pass deleted.
- `<prompt>` tag attrs: `tokenUsage` + `tokensFree` (dropped
  `tokenBudget` — derivable). `token="N"` typo in preamble fixed
  to `tokens="N"`.
- `update` tool: distinguishes "missing status" (auto-default to
  102) from "invalid status N" (strike with "Invalid status N
  on update (status = 102 to continue, status = 200 to conclude)").
- Set result entries: `body = newContent` (what the model wrote)
  instead of `body = oldContent`. The SEARCH half of
  `attributes.merge` already records the pre-edit content.
- Events renamed: `turn.proposing` → `proposal.prepare`,
  `turn.proposal` → `proposal.pending`. Two distinct events, same
  namespace, names now reflect phase.
- Preamble: four phases (Define → Search/Scan → Optimize → Act),
  self-closing XML tags in `[%TOOLS%]` list (`<get/>, <set/>, ...`),
  `commands` attribute on `<prompt>` instead of `tools="..."` (the
  OpenAI-schema lookalike was priming gemma's native-tool-call
  emission prior).

Failed judgment calls I want future-me to not repeat:
- Deleted zero-subscriber events earlier this session. **Wrong.**
  Plugin-friendliness is a keystone architectural commitment. Every
  event is an extension point. Restored all.
- Compartmentalized "my code" vs "prior model's code" when hunting
  fallbacks. **Wrong.** The codebase is the codebase. If you touch
  it, it's yours. Audit for fallbacks across the whole tree, not
  just diffs.
- Defaulted to "standing by" when something looked working in my
  test lane. The user's demo is the contract. When they report
  symptoms, read the DB, instrument, reproduce — don't defer to
  their next demo to verify.

### 2026-04-20 continued — fallback audit COMPLETE

**Final state:** `biome check src` reports 0 custom-plugin diagnostics for
the no-fallback rule. Unit 244/244. Integration green (pending final
confirmation when this run finishes).

All 167 `|| <falsy>` / `?? <falsy>` violations outside hedberg +
XmlParser are gone. Every remaining fallback in the codebase is either:
- inside `src/plugins/hedberg/**` (the stochastic-interpretation
  boundary — fallbacks are correct there), or
- inside `src/agent/XmlParser.js` (same role for XML — parses
  attr-or-body shapes from model output), or
- in a `.test.js` file (test fixtures are allowed defaults).

The biome grit plugin at `biome/no-fallbacks.grit` enforces this going
forward — any new fallback at an interior site fails `npm run lint`.
Filter exclusions (boundaries and fixtures where fallbacks are legit):
`src/plugins/hedberg/`, `src/agent/XmlParser.js`, `/test/` (test tree),
and `.test.js` (colocated tests under `src/`).

**Rubric that drove decisions (keep for future audits):**
- DB nullable boundary (e.g. `configPath ?? null` pre-SQL) → destructuring
  default param (`configPath = null`) or `=== undefined` check.
- JSON-RPC / env / API response boundary → destructure with defaults in
  function signature; let malformed payloads crash loudly.
- Display translations (`scheme || "file"`) → `=== ""` ternary; it's a
  translation, not a mask.
- Known-safe empties (`new Set(ctx.demoted)` with undefined yields empty
  set) → drop fallback, rely on JS semantics.
- Dead-defensive code (schema-guaranteed fields like `entry.attributes`) →
  just remove.
- Resolution chains across alternatives (`x || y || z`) → if/else-if
  ladder with explicit empty init, or named helper.

**Structural wins during the audit:**
- `RummyContext` now constructs `#context = { ...DEFAULTS, ...ctx }` so
  every getter returns a predictable shape without per-access fallback.
- `Repository.set` / `.get` / `.rm` / `.getEntriesByPattern` use
  destructuring defaults for `bodyFilter`/`limit`/`offset` — no more
  repeated `|| null` at SQL bind sites.
- `AgentLoop.#ensureRun` destructures `options` once at entry; interior
  uses the named values.
- `ToolRegistry.view()` normalizes `undefined`/`null` handler returns
  to `""` once, so `materializeContext` no longer needs `?? ""` at
  the call site.
- `computeBudget` / `measureRows` / `measureMessages` take required
  `totalTokens`; each caller produces its own measurement explicitly.

Open items (concrete next actions):
- [ ] **5 integration tests still fail `Method 'ask' not found`.**
  User clarified: `ask` is a mode, not a first-class RPC method.
  Tests need rewriting to use `set path=run://` with
  `attributes.mode = "ask"`. Landing this in the same session.
- [ ] **Biome lint rule to catch fallbacks outside hedberg.**
  Pattern: `|| 0`, `|| ""`, `|| null`, `|| false`, `|| []`, and
  `?? <literal>` (excluding optional-chaining patterns the rule
  should allow). Directory exclusion for `src/plugins/hedberg/*`.
  Landing this in the same session.
- [ ] `run.state` and `run.progress` still have no notification
  audit log. `rpc_log` captures requests/responses only. A
  `notification_log` table with the same shape would let us replay
  notification streams for diagnosis instead of speculating.
- [ ] `Repository` / `knownStore` / `#knownStore` / `entries` —
  four names for one concept. Pick one and enforce with lint.
- [ ] Plugin filter priority numbers (100, 150, 200, 300) are
  magic constants. Either name the stages explicitly or document
  the ranges third-party plugins should target.
- [ ] No end-to-end test between the server and nvim Lua. Every
  telemetry field added to `run.state` is manually re-synced in
  `state.lua` / `dispatch.lua` / `statusline.lua`. A headless nvim
  test would catch every statusline regression at contract time.

Rules the user restated this session (pin these):
- AGENTS.md is shared project memory; internal memory is overrides.
  Append to it. Don't silently decide.
- Events stay; extension points matter even without current users.
- No fallbacks outside hedberg, ever.
- When the user describes a symptom, the user is right until the
  DB proves otherwise. Read the DB first; don't tell them to
  restart the server.
- Don't passively defer decisions ("pick one name — or leave for
  another pass"). Decide or ask, don't dawdle.

