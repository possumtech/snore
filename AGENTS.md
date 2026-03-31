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
context budget. Runs after file scan and existing plugins (priority 10), before
context assembly (hardcoded after all hooks in TurnExecutor).

### Phase 0: Budget Enforcement (the engine)

The MVP. A plugin that prevents OOM by enforcing the token budget.

- [ ] **Engine plugin skeleton** — `src/plugins/engine/engine.js`, `export default class Engine`,
      `static register(hooks)`, `hooks.onTurn(callback, 20)`. No-op if `rummy.noContext`.
- [ ] **Token budget check** — sum `tokens` across all promoted entries (`turn > 0`).
      If total ≤ `rummy.contextSize`, return early — no intervention needed.
- [ ] **Demotion cascade** — when over budget, demote entries until total fits:
    1. Result entries (`edit://`, `run://`, `env://`, etc.) oldest turn first, highest tokens first
    2. Files at `full` → downgrade to `symbols` (oldest turn, lowest refs, highest tokens)
    3. `known://` entries → demote to `stored` (oldest turn, lowest refs)
    4. Files at `symbols` → downgrade to `path` (turn 0)
    5. Files at `path` → demote to `stored` (engine nuclear option, last resort)
- [ ] **Current-turn protection** — never touch entries where `turn === rummy.sequence`.
      The model's current-turn decisions are sacred.
- [ ] **`stored://` key maintenance** — when an entry is demoted to stored, append its
      path to the `stored://` value. When promoted back, remove it. Engine owns this key.
- [ ] **Demotion report** — after intervention, append a summary to the continuation prompt:
      `demoted: src/old.js, known://stale_note (budget: 96% → 78%)`. The model learns
      the budget is real and adapts.

### Phase 1: Integration Tests

In `test/integration/engine.test.js`, using the real store and `node:test`.

- [ ] **Over-budget trimming** — populate store with entries totaling 2x budget,
      run engine, assert total promoted tokens ≤ budget.
- [ ] **Cascade order** — verify files demote `full → symbols → path → stored`
      before knowledge entries are touched.
- [ ] **Current-turn protection** — entries at current turn survive even under pressure.
- [ ] **Stored key maintenance** — demoted keys appear in `stored://`, promoted keys
      are removed from it.
- [ ] **No-op when under budget** — engine makes zero changes when within budget.
- [ ] **Edge cases** — exactly at budget, single entry exceeds budget, empty store.

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
