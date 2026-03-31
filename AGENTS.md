# AGENTS: Planning & Progress

## Current State

URI-based K/V store (`known://`, `edit://`, `summary://`, bare paths for files).
Pattern tools via glorp (glob/regex on `path`/`value`, `keys` flag for preview).
ResponseHealer (forward motion, no unknowns gate). CASE WHEN CHECK constraints
per scheme. Web search (SearXNG) and URL fetch (Playwright + Readability + Turndown).
Move/copy across file and K/V namespaces. Edit search/replace attribute mode.
75 unit + 74 integration + 50 E2E.

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
      demote sets to `length(path)/4`, setFileState(symbols) uses `meta.symbols` length.
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

### turn_context Refactor ✓

Materialized `turn_context` table replaces the fragmented query pipeline.

- [x] **Schema** — `turn_context` table (run_id, turn, ordinal, path, bucket, content, tokens, meta)
- [x] **tokens split** — `tokens` (context cost) + `tokens_full` (raw value cost) in `known_entries`
- [x] **Engine materializes** — after budget enforcement, writes turn_context from known_entries
- [x] **ContextAssembler.assembleFromTurnContext()** — renders from turn_context rows
- [x] **TurnExecutor** — systemPrompt built before hooks, passed via RummyContext
- [x] **AgentLoop** — context_distribution reads from `get_turn_distribution`
- [x] **Deleted** — `getModelContext()`, `getContextDistribution()`, `get_context_distribution` SQL, `v_turn_history` view
- [x] **Tests** — 80 unit + 82 integration, all passing

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
