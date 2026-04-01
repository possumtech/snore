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

## Todo: E2E Story Suite

Replace the current scattered E2E collection with a focused suite of long,
chained story tests. Each story runs on a **single run** with many turns,
each turn exercising a different tool, building on context from previous turns.
Stories test whether the full pipeline — prompt assembly, tool dispatch, context
materialization, model comprehension — actually works under sustained use.

Every assertion targets **content and behavior**. If the model's answer is
correct, the test passes.

**Graceful recovery is not failure.** A turn where the model stumbles but the
system recovers (healer continues, next turn succeeds) is a passing test. Assert
on checkpoint outcomes — "after this sequence, the answer is X" — not on each
turn being flawless. However, if a specific tool interaction fails repeatedly
across test runs, isolate it: that's an infrastructure bug worth investigating,
not noise to ignore.

### Test Infrastructure

Shared `before()`: git-initialized temp project with known files:
- `src/app.js` — Express app on port 8080, `// TODO: add error handling`
- `src/config.json` — `{ "db": "postgres", "pool": 5, "host": "db.internal" }`
- `src/utils.js` — exports `greet()` returning "hello", `add(a, b)` returning a+b
- `notes.md` — "The project codename is: phoenix"
- `data/users.json` — `[{"name":"Alice","role":"admin"},{"name":"Bob","role":"viewer"}]`

### Story 1: Baseline — single-turn factual answer (ask)

The only single-turn test. Proves the simplest path works.

**Turn 1:** "What is the project codename in notes.md? Reply ONLY with the word."
- Assert: response contains "phoenix"

### Story 2: Research session (ask, ~8 turns)

A user explores an unfamiliar codebase. Read files, build knowledge, use that
knowledge to answer follow-up questions, search the web, drop stale context.

**Turn 1:** "Read src/config.json and tell me what database this project uses."
- Assert: response contains "postgres"

**Turn 2:** "Save that database config as a known entry, then read data/users.json
and tell me how many users have the admin role."
- Assert: response contains "1" (Alice)
- Assert: a known:// entry exists containing "postgres"

**Turn 3:** "Read all the JS files in src/ using a glob. Which one uses express?"
- Assert: response contains "app.js"

**Turn 4:** "What does the greet function in src/utils.js return?"
- Assert: response contains "hello"

**Turn 5:** "Search the web for 'Express.js error handling middleware'."
- Assert: run completes (search executed)

**Turn 6:** "Drop data/users.json from context — we're done with it."
- Assert: run completes

**Turn 7:** "Based on everything you've learned: what database does this project
use, what port does the app run on, and what's the project codename?"
- Assert: response contains "postgres", "8080", "phoenix"
- Validates: knowledge persists across turns, dropped files don't break recall
  of information already saved to known entries

### Story 3: Edit and build session (act, ~10 turns)

A user modifies code, manages files, and runs commands. Tests the full act-mode
lifecycle including proposals, acceptance, rejection, env, run, move, copy, delete.

**Turn 1:** "Read src/app.js and tell me what the TODO says."
- Assert: response mentions "error handling"

**Turn 2:** "Replace the TODO comment in src/app.js with `// error handler added`.
Use SEARCH/REPLACE."
- Assert: run reaches `proposed`
- Resolve: accept

**Turn 3 (auto-resumed after accept):** assert run completes after acceptance.

**Turn 4:** "Save the note 'app.js has been updated' to known://changelog."
- Assert: known://changelog exists

**Turn 5:** "Copy known://changelog to known://changelog_backup."
- Assert: known://changelog_backup exists with same content

**Turn 6:** "Move known://changelog_backup to known://archive."
- Assert: known://archive exists
- Assert: known://changelog_backup is gone

**Turn 7:** "Run `node -e \"console.log('build-ok')\"` to verify the build."
- Assert: proposed (run commands need approval)
- Resolve: accept with output "build-ok"

**Turn 8 (auto-resumed):** "Check the node version with env."
- Assert: env result exists

**Turn 9:** "Delete known://archive — we don't need it anymore."
- Assert: known://archive is gone

**Turn 10:** "Summarize everything you did in this session."
- Assert: response mentions the edit, the commands, the knowledge entries
- Validates: full act lifecycle — read, edit+propose+accept, known write,
  copy, move, run+propose+accept, env, delete, multi-turn coherence

### Story 4: Adversarial prompt coherence (ask, ~6 turns)

Tests that the model tracks which question it's supposed to answer across turns.
Each turn asks a completely different question. The model must answer the LATEST
question, not echo earlier ones.

**Turn 1:** "What is the project codename in notes.md? Reply ONLY with the word."
- Assert: response contains "phoenix"

**Turn 2:** "What port does src/app.js listen on? Reply ONLY with the number."
- Assert: response contains "8080", NOT "phoenix"

**Turn 3:** "How many users are in data/users.json? Reply ONLY with the number."
- Assert: response contains "2", NOT "8080"

**Turn 4:** "What is the database host in src/config.json? Reply ONLY with the hostname."
- Assert: response contains "db.internal", NOT "2"

**Turn 5:** "What is the pool size in src/config.json? Reply ONLY with the number."
- Assert: response contains "5", NOT "db.internal"

**Turn 6:** "What was the very first question I asked you? Reply with the topic, not the answer."
- Assert: response references "codename" or "notes.md" or "phoenix"
- Validates: message structure — model sees full history in `<messages>` but
  answers the current `<prompt>`. Earlier prompts are visible but not confused
  with the active question.

### Story 5: Unknown-driven investigation (ask, ~6 turns)

User asks a question the model can't answer from bootstrapped context alone.
Tests the unknown→investigate→resolve→answer cycle.

**Turn 1:** "What test framework does this project use? What are the npm scripts?
Register unknowns for anything you need to look up, then investigate."
- Assert: run completes (model should read package.json or run env)

**Turn 2:** "Now look at data/users.json and register an unknown about whether
there's an API endpoint that serves this data."
- Assert: unknown:// entry exists with a question about the API

**Turn 3:** "Read src/app.js to try to resolve your unknown about the API."
- Assert: run completes

**Turn 4:** "Drop any unknowns you've resolved. What do you know for certain
about this project's architecture?"
- Assert: response references concrete facts from files read
- Validates: unknowns created, investigated, resolved/dropped, model synthesizes

### Story 6: Lite mode sustained session (ask, noContext, ~4 turns)

No file context. Tests that multi-turn works without the engine, and that the
model tracks conversation across turns purely from message history.

**Turn 1:** "I'm going to give you three numbers across three messages. The first
number is 17. Just acknowledge."
- Assert: response acknowledges

**Turn 2:** "The second number is 23."
- Assert: response acknowledges

**Turn 3:** "The third number is 41."
- Assert: response acknowledges

**Turn 4:** "What is the sum of all three numbers I gave you?"
- Assert: response contains "81"
- Validates: multi-turn memory works in lite mode, message history is coherent

### Story 7: Abort mid-flight (ask)

Starts a multi-turn task, aborts it, verifies clean termination.

**Turn 1:** Start: "Carefully read every single file in this project one at a
time, summarize each individually with extensive detail, then cross-reference
all of them."
- Immediately send `run/abort` via RPC
- Assert: run status is `aborted`
- Validates: abort signal reaches fetch, run terminates, no stuck state

### Story 8: Rejection and recovery (act, ~6 turns)

Tests that rejecting a proposal doesn't corrupt state, and the model recovers.

**Turn 1:** "Delete notes.md"
- Assert: proposed

**Turn 2 (resolve reject):** Reject the deletion.
- Assert: run resumes

**Turn 3 (model responds to rejection):** assert run completes or continues

**Turn 4:** "Is notes.md still in the project? What does it say?"
- Assert: response contains "phoenix"
- Validates: rejection preserved the file, model can still read it

**Turn 5:** "Now write a new file called output.txt with the text 'test output'."
- Assert: proposed (file write needs approval)
- Resolve: accept

**Turn 6 (auto-resumed):** assert run completes
- Validates: accept works after a prior reject in the same run

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

## Todo: Message Structure Refactor

ContextAssembler currently renders everything into a single system message.
Refactor to the two-message architecture documented in ARCHITECTURE.md §3.1:

**System** = `<instructions/>` + `<context/>`
**User** = `<messages/>` + `<prompt/>` or `<progress/>`

- [ ] **Split turn_context into context vs messages** — context entries (files,
      knowledge, unknowns) go in system. Message entries (prompts, tool results,
      updates, summaries) go in user. The `category` column or `schemes.category`
      can drive the split.
- [ ] **Render context in system** — instructions (sacred prompt) + `<context>` tag
      wrapping files, knowledge, unknowns. Ends with unknowns.
- [ ] **Render messages in user** — `<messages>` tag wrapping chronological prompt,
      tool, update, summary entries. Followed by `<prompt>` or `<progress>`.
- [ ] **Prompt vs progress** — `<prompt>` only on turns with genuine user input.
      `<progress>` on continuation turns (ephemeral, stored for audit).
- [ ] **Remove prompt from context ordering** — prompts are no longer ordinal 8
      in v_model_context. They're in messages.
- [ ] **Update v_model_context VIEW** — exclude message-domain entries (results,
      summaries, updates, prompts) from the context view.
- [ ] **Update engine** — continuation injection goes to messages, not context.
- [ ] **Update ContextAssembler** — new `assembleFromTurnContext` builds two
      messages instead of one. Delete legacy `assemble()` if unused.
- [ ] **Update tests** — ContextAssembler tests, engine tests, E2E.

---

## Done: Abort Chain Fix ✓

AbortSignal now threads through the full call chain:
`AgentLoop.controller.signal` → `TurnExecutor.execute({signal})` →
`LlmProvider.completion(msgs, model, {signal})` → all 3 clients →
`AbortSignal.any([runSignal, timeoutSignal])` → `fetch({signal})`.

Startup cleanup: `abort_stuck_runs` query sets all `running`/`queued` runs
to `aborted` on boot. Called in `service.js` after DB hygiene.

- [x] **Thread AbortSignal through the call chain**
- [x] **Startup cleanup**
- [ ] **E2E test** — doom loop + abort story (in E2E story suite below)

### Non-git project file scanner gap

`ProjectContext.getMappableFiles()` returns nothing for non-git directories.
The file scanner only discovers files via `git ls-files`. Non-git projects have
zero files bootstrapped into context on the first run.

- [ ] **Fallback file discovery** — when `isGit` is false, walk the directory
      tree (respecting .gitignore-style patterns or a .rummyignore)
- [ ] **E2E test** — story test with non-git project verifying files are in context

---

## Done: Schemes Table ✓

`schemes` table is the single source of truth. `fidelityOf.js` and `tierOf.js`
deleted. CHECK constraint replaced with validation triggers. Views join schemes
for fidelity, tier, model_visible, and category. Adding a scheme = INSERT.

## Done: Integer Primary Keys ✓

`projects.id`, `sessions.id`, `runs.id` are INTEGER AUTOINCREMENT. UUIDs removed.
All FKs follow. RETURNING on create queries. Aliases remain the external identifier.

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
