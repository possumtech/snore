# AGENTS: Planning & Progress

## Current State

URI-based K/V store (`known://`, `write://`, `summary://`, bare paths for files).
Pattern tools via hedberg (glob/regex/xpath/jsonpath on `path`/`value`, `keys` flag for preview).
Termination protocol: `<update/>` continues, `<summary/>` terminates.
ResponseHealer (stall counter, heal from content). CHECK constraints per scheme.
Web search (SearXNG) and URL fetch (Playwright + Readability + Turndown).
Move/copy across file and K/V namespaces. Write with SEARCH/REPLACE mode.
`turn_context` materialized view via `v_model_context` VIEW + SQL functions
(`countTokens`, `schemeOf`, `langFor`, `tierOf`, `fidelityOf`, `hedberg`).
Generated `scheme` column. `category` column on `turn_context`.
`file_constraints` table for client visibility (project-scoped).
Run state machine trigger on `runs.status`.
Sacred prompts locked (2026-03-31).

### E2E Testing Philosophy

E2E tests are **story-driven**. Each test file begins with a narrative describing
what the user is trying to accomplish — the story. The test succeeds if the story
succeeds, regardless of implementation details.

Assertions target outcomes ("the run completed," "the summary contains a relevant
answer"), not mechanics ("the model used `<read>`," "the entry state is `pass`").
This makes E2E tests immune to refactors that change tool names, schemes, or
internal state — as long as the story still works, the test passes.

When a refactor breaks an E2E test, ask: **did the story break, or did the
assertion?** If the story still works but the assertion checks an implementation
detail, fix the assertion. If the story broke, fix the implementation.

---

## Todo: Relevance Engine

`src/plugins/engine/engine.js` — an `onTurn` hook (priority 20) that manages
context budget and materializes `turn_context`. Runs after file scan and
existing plugins (priority 10), before context assembly (reads `turn_context`).

### Phase 0: Budget Enforcement (the engine) ✓

- [x] **Engine plugin** — `src/plugins/engine/engine.js`, priority 20.
- [x] **Token budget check** — fast `SUM(tokens)` query, early return if under budget.
- [x] **Demotion cascade** — results → file full→symbols → known → file symbols→path.
- [x] **Current-turn protection** — entries at `turn === sequence` are never touched.
- [x] **Demotion report** — injects `inject://` info entry with budget percentages.
- [x] **Schema: tokens split** — `tokens` (context cost) + `tokens_full` (raw value cost).
      All state-changing queries update `tokens`: promote restores to `tokens_full`,
      demote sets to `countTokens(path)`, setFileState(symbols) uses `countTokens(meta.symbols)`.
- [x] **Symbol file query fix** — `get_symbol_files` respects `turn > 0`.
      `get_stored_files` includes demoted symbols files.

### Phase 1: Integration Tests ✓

17 tests in `test/integration/engine.test.js`:

- [x] No-op when under budget / empty store
- [x] Over-budget trimming to fit budget
- [x] Results demoted before files
- [x] Files downgraded to symbols before known entries demoted
- [x] Current-turn protection (single entry + mixed turns)
- [x] Oldest turn first within same tier
- [x] Largest entries first within same turn
- [x] Entry persists in store after demotion
- [x] `tokens_full` preserved after demotion
- [x] Promote restores `tokens` to `tokens_full`
- [x] Demotion report injection + no report when unnecessary
- [x] Symbol file query: turn 0 hidden, turn > 0 visible, demoted in stored files

### turn_context + SQL Refactor ✓

Materialized `turn_context` table replaces the fragmented query pipeline.
SQL functions replace JS classification. File constraints separated from fidelity.

- [x] **turn_context table** — `scheme` (generated), `fidelity` (full/summary/index), `content`, `tokens`
- [x] **v_model_context VIEW** — CTEs + window functions + `fidelityOf()`, `countTokens()`
- [x] **SQL functions** — `countTokens`, `schemeOf`, `langFor`, `tierOf`, `fidelityOf` in `src/sql/functions/`
- [x] **Generated scheme** — `known_entries.scheme` is `GENERATED ALWAYS AS (schemeOf(path)) STORED`
- [x] **file_constraints table** — project-scoped client visibility (`active`/`readonly`/`ignore`)
- [x] **File states simplified** — only `full` and `symbols` in `known_entries` (no client concerns)
- [x] **tokens split** — `tokens` (context cost) + `tokens_full` (raw value cost)
- [x] **CHECK constraints** — all numeric fields, temperature/context_limit bounds, sequence minimums
- [x] **Engine materializes** — `INSERT INTO turn_context SELECT FROM v_model_context` + synthetic rows
- [x] **ContextAssembler** — routes by `scheme` + `fidelity`, constraint labels from `meta.constraint`
- [x] **Deleted** — `getModelContext()`, `getContextDistribution()`, 6 dead queries, `v_turn_history`, `bucketOf`

### Phase 2: Metrics

Instrumentation. Only built after the engine makes decisions worth measuring.
Separate `engine_metrics.db` — engine telemetry never pollutes model state.

- [ ] **Metrics plugin** — `src/plugins/engine/metrics.js`, wraps engine at priority 21.
      Records what the engine did each turn.
- [ ] **Schema** — `runs` and `turn_metrics` tables. Columns driven by actual engine
      signals (tokens before/after, entries demoted, utilization percentage).
- [ ] **Report script** — `test/engine/report.js`, queries metrics DB, prints comparison.

### Phase 3: Ref Counting & Preheat

Optimization to demotion priority. Makes structurally central files resist demotion.

- [ ] **Ref counting** — compute `refs` from `meta.symbols` cross-references. A promoted
      file that imports other files increases their `refs`. High-ref files resist demotion.
- [ ] **Preheat cascade** — when a file is promoted, auto-promote its direct imports at
      `symbols` fidelity. Capped at N entries to prevent budget blowout.

### Phase 4: Decay

Entries promoted but untouched for N turns get demoted automatically.

- [ ] **Turn-based decay** — configurable decay rate per scheme. `known://` decays
      slower than files (knowledge is stickier than code context).
- [ ] **Decay integration** — engine checks age before the budget cascade. Stale entries
      are demoted proactively, not just reactively when over budget.

---

## Todo: Schemes Table

Fidelity rules, scheme validity, valid states, and model visibility are hardcoded
across `fidelityOf.js`, `tierOf.js`, the `known_entries` CHECK constraint, and
`v_run_log`. Adding a scheme means editing three files and hoping they agree.

Replace with a `schemes` table — single source of truth for all scheme metadata.
`fidelityOf` becomes a query, the CHECK becomes a trigger, and adding a scheme
is an INSERT.

- [ ] **`schemes` table** — name, fidelity rule, model_visible, valid_states (JSON), category
- [ ] **`fidelityOf`** — rewrite as query against schemes table (or cache at startup)
- [ ] **CHECK constraint** — replace with BEFORE INSERT/UPDATE trigger that validates against schemes
- [ ] **`tierOf`** — derive from schemes.category instead of hardcoded switch
- [ ] **`v_run_log`** — exclusion list derived from `WHERE model_visible = 0`

## Todo: Integer Primary Keys

`runs.id`, `sessions.id`, and `projects.id` are TEXT UUIDs generated by
`crypto.randomUUID()`. This is unnecessarily expensive — 36-byte string keys on
tables with heavy joins (`known_entries`, `turns`, `turn_context` all join on
`run_id`). SQLite's `INTEGER PRIMARY KEY` is the rowid alias — zero-cost lookups,
8-byte keys, natural ordering.

- [ ] **Switch to INTEGER PRIMARY KEY AUTOINCREMENT** for runs, sessions, projects
- [ ] **Update all foreign keys** — `known_entries.run_id`, `turns.run_id`, `turn_context.run_id`, etc.
- [ ] **Update SessionManager** — remove `crypto.randomUUID()` calls, let SQLite assign IDs
- [ ] **Update AgentLoop** — use returned integer IDs instead of pre-generated UUIDs
- [ ] **Keep `alias`** — the human-readable run name (`kimi_1`) stays as the external identifier

---

## Future: Dependency Alternatives

**isomorphic-git** — Pure JS git implementation. Would eliminate all `execSync("git ...")`
subprocess spawns in `GitProvider.js`. Currently `ProjectContext.open()` caches results
keyed on HEAD hash, so the subprocess cost is amortized. Consider adopting if:
(a) git operations expand beyond `ls-files`/`rev-parse`, or (b) we need to run in
environments without git installed.

## Future: Knowledge Graph

Scan `known://*` values for URI references (file paths, `known://`, `https://`).
Build citation edges. High-connectivity knowledge nodes resist demotion. Deferred
until budget enforcement + ref counting are proven.

## Future: Stored Key Compression

Pattern-compress the `stored://` index. Instead of listing `known://users_dave`,
`known://users_bob`, `known://users_stacy` individually, show `known://users_*`.
Reduces noise in an ever-growing key space.
