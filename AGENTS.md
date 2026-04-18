# AGENTS: Planning & Progress

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

### Phase 5 — Plugin hygiene

Remove every structural obstacle to the contract working cleanly.

- `registerPlugins` returns an instances Map; no module-global state.
- `initPlugins(db, hooks, instances)` takes the collection explicitly.
- `TestDb` and `TestServer` share a single plugin graph.
- Plugin constructors fully declarative — no infrastructure
  dereferences at construction time. `core.registerRpc(...)` helper
  on PluginContext replaces direct `hooks.rpc.registry.register`
  calls in plugin code (or `hooks.rpc.registry` is non-null from the
  moment `createHooks()` returns — whichever audit reveals is cleaner).
- Hook infrastructure null defaults eliminated (`hooks.rpc.registry`).
- Plugin-dep system (`static dependsOn`, topo sort) deleted — no
  callers, and the new contract doesn't need it.
- Typed errors: `PermissionError`, any other string-coded error
  becomes a class. Callers catch by type.
- Handlers plumb `writer: rummy.writer` to the store so restrictive
  schemes can distinguish model from plugin writes.
- `<think>` → `reasoning_content` merge extracts to a `think` plugin.
- `'project'` scope plumbing — projectId reaches Repository.
- Multi-step DB writes inside transactions.
- Every silent `catch {}` either documented or removed.
- `core.hooks.X = fn.bind(this)` direct mutations formalized as
  events/filters where more than one subscriber is conceivable; kept
  as direct assignment only where there's genuinely one slot.
- Capability classes declared on schemes, policy plugin rewritten as
  the single enforcer of the run's `restrictions` list.

**Gate:** no "Plugin load failed" output anywhere. `npm test` green.
No test helper wires infrastructure that `createHooks()` should own.

### Phase 6 — External plugins

Rewrite the plugins we own against the landed contract.

- `rummy.repo` rewritten to the new scheme permissions, new verb
  surface, new RummyContext shape.
- `rummy.web` rewritten same.
- Any capability that doesn't map cleanly to primitives + scheme
  declarations is either reframed or removed.
- Delete anything in either repo that has no reason to exist under
  the contract.

**Gate:** both plugins loadable, no `[RUMMY] Plugin load failed`,
their tests green, their behavior exercised by at least one E2E test.

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

