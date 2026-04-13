# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

> **"Model behavior" is never an acceptable explanation for a test failure.**
> When a model misbehaves, the system failed — suboptimal context, poorly
> designed test conditions, insufficient reinforcement of correct behavior.
> Every failure is a system bug until proven otherwise. Investigate the
> context the model saw, the instructions it was given, and the constraints
> it was operating under. If you can't explain exactly why the model did
> what it did, you haven't finished debugging.

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
No monolithic assembler. Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).
14 model tools: think, unknown, known, get, set, env, sh, rm, cp, mv,
ask_user, update, summarize, search. Tool priority ordering (think first,
search last). Unified tool exclusion via `resolveForLoop(mode, flags)`.
Budget: ceiling = `floor(contextSize × 0.9)`. The 10% headroom is the
system's operating room for graceful overflow handling.
  - **Prompt Demotion**: new prompt exceeds ceiling → summarize the prompt,
    model runs in the headroom and manages its own context.
  - **Turn Demotion**: post-dispatch context exceeds ceiling → demote all
    entries from this turn to summary (all schemes except budget), write
    `budget://` entry listing what was demoted. Model sees it next turn
    and adapts. No per-write gating — tools run uninterrupted, demotion
    happens after.
  - **LLM rejection**: turn-1 token estimate drift causes LLM to reject
    what the budget check approved → `isContextExceeded` catch, same
    demotion pattern, uses the 10% headroom for recovery.
  - **Previous-loop entries**: model-managed. Preamble instructs model to
    demote `<previous>` entries to summary with descriptive tags.
Token math: `ceil(text.length / RUMMY_TOKEN_DIVISOR)`. No tiktoken.
500-token size gate on known entries. Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Both sent → last signal wins. Summarize
overridden only when actions fail (4xx/5xx). `<think>` / `<thought>` tags
for model reasoning — inner tool calls captured as rawBody, never dispatched.
Preamble: XML format, conclude every turn, summaries approximate.
Four entry roles: data (knowns), logging (current/previous), unknown,
prompt. Default category: logging. `<prompt mode="ask|act">`.
Each plugin owns its own views.
PLUGINS.md: third-party developer guide, §0-§11. plugin_spec.test.js:
30 compliance tests. Hooks: tool.before/after, entry.recording filter,
turn.completed, loop.started/completed, run.created, context.materialized.
Concurrent loop protection: AbortController created at top of
`#drainQueue` before first await — closes the race on `#activeRuns`.
`normalizePath` lowercases scheme component. `<previous>` sorted
chronologically by source_turn (prompt before logging within same turn).
`progress://` scheme removed; `<progress turn="N">` is structural only.
`context_tokens` back-filled from LLM `prompt_tokens` post-response.
Budget enforcement uses actual `prompt_tokens` from last API response when
available — falls back to `ceil(chars / RUMMY_TOKEN_DIVISOR)` on turn 1.
Audit entries (assistant://, system://, user://, model://, reasoning://,
content://) written at `fidelity: "archive"` — excluded from model context
by both model_visible=0 scheme registration and explicit archive filter.

## Benchmark Plan

### What we're measuring

Rummy's memory management under pressure. The claim: a small local model
running inside Rummy's context system can answer questions about documents
too large to fit in its context window — because panic mode compresses and
retrieves rather than failing. The benchmarks test whether that claim holds.

Hardware: local llama server, Gemma 4 26B Q3, 32K context, ~45s/chunk.
Token divisor: 2 (approximate). Results are system + model combined.

---

### Status

**Bug fixes applied (2026-04-12)**:
- `budget.enforce` now uses actual `prompt_tokens` from last API response
  instead of the `ceil(chars/2)` estimate. The estimate was 7x off for
  structured/XML-heavy content, causing false 413s on the gemma run.
- Audit entries written at `fidelity: "archive"` — belt-and-suspenders
  alongside the existing model_visible=0 exclusion.
- `RUMMY_CONTEXT_LIMIT` / `--context-limit` supported in both MAB and LME
  runners. `test:grok` script loads `.env.grok` for xAI credentials.

**Next run**: re-run MAB with gemma now that false-413 root cause is fixed:
```
npm run test:mab -- --split Conflict_Resolution
```

**Parallel validation**: run grok against Conflict_Resolution with capped
context to confirm context management works at speed:
```
npm run test:grok -- --split Conflict_Resolution
```

### Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

CR-MH (Conflict_Resolution multi-hop) is what the `test:mab` CR split runs.
**The ceiling is ~5–6%.** Any score is meaningful noise at this difficulty.
What we're actually measuring: does the model file, retrieve, and reason
correctly — not the absolute score.

Taxonomy health check (fast, no questions):
```
npm run test:grok:taxonomy
npm run test:mab:taxonomy
```

---

### MAB (MemoryAgentBench)

Four splits. Only two are tractable on this hardware for a credible run.

**Phase 1 — Conflict_Resolution (run overnight)**
```
npm run test:mab -- --split Conflict_Resolution
```
- 8 rows, ~782 chunks, 800 questions, ~10h
- Full split — every row, publishable
- Tests contradiction detection and resolution: the hardest retrieval task
- If panic fires, we see whether the model compresses intelligently or stalls

**Phase 2 — Accurate_Retrieval subset (run alongside or after)**
```
npm run test:mab -- --split Accurate_Retrieval --row 0-4
```
- 5 of 22 rows, ~1535 chunks, ~450 questions, ~19h
- Not a full split but row 0 alone (985K chars, 100 questions) is a meaningful
  standalone stress test — largest context in the dataset
- Tests baseline fact retrieval: did the model save the right things?

**Skip — Long_Range_Understanding**: 110 rows, ~250h. Not tractable.

**Skip — Test_Time_Learning**: interesting (knowledge updates over time) but
6 rows averaging 317 chunks each = ~24h. Run after CR and AR.

**Minimum credible MAB result**: Phase 1 only (CR full) + AR row 0.
CR full gives 800 questions across 8 rows. AR row 0 gives 100 questions
on the largest document in the dataset. Together: ~16h, ~900 questions.

---

### LME (LongMemEval)

Two splits. Oracle is structured differently (pre-extracted facts, likely
much faster). Check before committing.

```
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const rows = readFileSync('test/lme/data/longmemeval_oracle.ndjson','utf8')
  .trim().split('\n').map(l=>JSON.parse(l));
console.log(Object.keys(rows[0]));
console.log(JSON.stringify(rows[0]).length, 'chars row 0');
"
```

If oracle rows are small (<20K chars each): run 50-100 rows overnight.
If similar size to `_s_cleaned`: run rows 0-19 as a diagnostic sample.

```
npm run test:lme -- --split longmemeval_oracle --row 0-49
```

LME tests temporal reasoning and session-level memory (personal history
questions across many conversations). Complements MAB's document retrieval.

---

### What to look for in results

1. **Panic cycle counts**: how often does context overflow occur, and does
   the model recover? A high panic rate that still resolves is a success
   story for the system. A high panic rate with 413s is a tuning problem.

2. **Folksonomic quality**: are `known://` paths topic-first and reusable
   across questions, or are they verbatim sentence slugs? Check the DB.

3. **Score vs context pressure**: do rows with larger contexts (more chunks,
   more panics) score lower? If yes, that's the frontier for Step 3.

4. **The 500-token buffer**: watch for any panic loops that still 413 on
   turn 1. If we see them, the buffer needs to increase.

---

### Smart Housekeeping (Step 3)
- Model makes informed decisions about what to demote before hitting 90%
- Step 3 of ENFORCED → FUNCTIONAL → SMART

---

### Community Debut Post (Latent Space)

Publish after Phase 1 (CR full) completes. Tables populated incrementally.

**Post structure:**
1. What Rummy is — memory management yoke, not a RAG system
2. Architecture — hooks/filters, XML tags as plugins, folksonomic `known://` store
3. Fidelity system — full → summary → index → archive, reversible
4. Panic mode — the novel claim: model compresses its own context rather than hard-failing
5. Hardware context — Gemma 4 27B Q3, 32K, local llama, ~45s/chunk
6. What we're not claiming — not competing with frontier models; measuring the delta between hard-413 and a working answer
7. Result tables (MAB CR, MAB AR, LME oracle) — TBD until runs complete
8. Reproducibility block — git clone → .env → test:mab

**Splitting plan:**
- Phase 1: `npm run test:mab -- --split Conflict_Resolution` (CR full, ~10h, 800q, overnight)
- Phase 2: `npm run test:mab -- --split Accurate_Retrieval --row 0` (AR row 0, ~3h, 100q, largest doc)
- Phase 3 (if time): `npm run test:lme -- --split longmemeval_oracle --row 0-49` (~2h, 50q)
- Minimum credible publish threshold: Phase 1 complete + Phase 2 complete = ~900 questions

**Key metrics to surface:**
- Panic recovery rate (panics triggered vs resolved)
- Score vs context pressure correlation
- Folksonomic quality (spot-check known:// paths in DB)

## Active: Budget Simplification

### Design (2026-04-12)

One rule: if context exceeds the 90% ceiling at any checkpoint, demote
and report. The 10% headroom is the system's operating room. No per-write
gating. Tools run uninterrupted; enforcement happens at boundaries.

**Two checkpoints, one pattern:**

1. **Post-dispatch** (Turn Demotion): model's tools all run. Post-dispatch
   check: over ceiling? Demote ALL entries from this turn to summary
   (every scheme except `budget`). Write `budget://` entry listing what
   was demoted. Model sees it next turn and adapts.

2. **Pre-LLM** (Prompt Demotion): new prompt + existing context exceeds
   ceiling. Summarize the prompt. Model runs in the 10% headroom with
   the summarized prompt and manages its own context.

**Safety net**: LLM rejects context on turn 1 (estimate drift) →
`isContextExceeded` catch → same demotion pattern, same headroom.

**AgentLoop recovery**: if pre-LLM 413 can't be resolved by Prompt
Demotion alone, AgentLoop batch-demotes all full entries, writes budget
entry, gives model recovery turns. Strike system: 3 turns without
progress → hard 413 to client. This is the only path where 413 reaches
the client.

**Previous-loop entries**: model-managed via preamble instruction. No
auto-demotion by the system.

### What Changed (this session)

- [x] XmlParser: `<known>` tag spreads all attrs (was dropping `summary`)
- [x] TurnExecutor: passes `attributes` to `upsert()` on both known paths
- [x] Preamble: folksonomic identity, "extract your findings", token info
- [x] Preamble: `<previous>` demotion instruction, promote/demote lines
- [x] Preamble reverted from aggressive MAB-overfit to near-original density
- [x] knownDoc: reverted to battle-tested examples (hedberg/rumsfeld),
  kept URI-identity signal (`known://` in header template)
- [x] Removed auto-demotion of previous loop logging (model-managed now)
- [x] LLM 400→413: `isContextExceeded` catch in TurnExecutor
- [x] AgentLoop 413 recovery loop (batch demote + budget entry + strikes)
- [x] Fixed recovery strike counting (was resetting on each 413)
- [x] `demote_turn_entries` SQL: no exceptions, demotes everything
- [x] `demote_all_full` SQL: no exceptions, batch demotes everything
- [x] Demotion no longer recalculates tokens — tokens is always full cost
- [x] Removed `tokens_full` column entirely — one concept: `tokens`
- [x] Preamble Info line: token amounts show full cost, demoted = free
- [x] `v_model_context` view carries `tokens` through to materialization
- [x] BudgetGuard class (for `BudgetExceeded` error + `delta` utility)
- [x] Budget README updated to reflect simplified design
- [x] SPEC.md updated (removed `tokens_full`)
- [x] Tests: 221 unit, 165 integration, 16 E2E — all green
- [x] Get handler: "loaded into `<knowns>`" → "promoted to full" (was teaching
  the model that `<get>` migrates files into a separate store)
- [x] Prompt summary: first 500 chars visible at summary fidelity, truncation
  notice if truncated (was invisible — model lost its instructions)
- [x] Budget entry language: "Demote irrelevant entries to free context"
  (was "archive what you don't need" — wrong vocabulary)
- [x] Preamble: tool call cap "up to 99" (gemma fired 2001 gets in one turn)

### Demo run failures diagnosed (rummy_dev.db, gemma, rummy.nvim)

**Run 1** (pre-fixes): `<env>ls -R` blocked everything via proposal. Dead run.
**Run 2**: model promoted 21 files, 413 recovery demoted everything including
  prompt. Model saw invisible prompt, stalled at "Ready for instructions."
**Run 3**: model fired 2001 `<get>` calls (empty `<think>`, zero reasoning).
  413 recovery loop ran 499 times — budget entry itself was 25K tokens.
  Model never got a turn. Turns 4-6: "Organizing context" with no action.

Root causes identified:
1. Get handler said "loaded into `<knowns>`" — taught file→known pipeline
2. Prompt invisible at summary fidelity — model lobotomized after demotion
3. No tool call cap — degenerate repetition loops
4. Budget entry listed all paths — entry itself exceeded context
5. Budget language said "archive" — model doesn't know "archive", knows "demote"
6. Gemma produced zero reasoning — can't diagnose without thinking output

### Session Summary (2026-04-12/13)

Major budget system overhaul driven by demo run failures. Key fixes:
- Budget math: `v_model_context` had duplicate tokens column; index entries
  were reporting full cost (33x overestimate). Fixed: tokens computed from
  projected body, index entries cost 0.
- Turn Demotion: post-dispatch enforce was using stale pre-dispatch
  `prompt_tokens`. Fixed: forces re-measurement after dispatch.
- Promotion: `promote_path`/`promote_by_pattern` now reset status to 200,
  so Turn Demotion catches re-promoted entries.
- `tokens_full` column removed entirely — one concept: `tokens` (always
  full body cost in `known_entries`, actual context cost in `turn_context`).
- `set_fidelity` SQL no longer recalculates tokens on fidelity change.
- Set handler: fidelity applied as post-write step, not routing decision.
  Bare body writes to existing files now diff against existing content.
- XmlParser: preserves HTML attributes on non-tool tags inside bodies.
  15-command cap enforced (`RUMMY_MAX_COMMANDS`).
- Proposal dispatch: 202 proposals no longer abort subsequent actions.
  All proposals from a turn queue for sequential client resolution.
- AgentLoop 413: properly completes loop (status 413) and run (status 200).
- Budget entry: shows overflow amount, per-entry token costs, ceiling.
- Progress: aligned with preamble vocabulary, lifecycle reminder added.
- Lifecycle: last signal wins (was: update always wins).
- Prompt summary: first 500 chars visible at summary fidelity.
- Think: proper plugin with tooldoc, gated by `RUMMY_THINK` env var.
- Preamble/tooldocs: complete rewrite with user — system.md collaboration.
  Structure: Preamble → Tool Commands → Tool Rules → Tool Usage.
- Get handler: "promoted to full" (was "loaded into knowns").
- Set tooldoc: SEARCH/REPLACE first, bare create last.
- Tests: 234 unit, 172 integration, 16 E2E — all green.

### Dispatch Restructuring Decision (2026-04-13)

The dispatch loop processes tools as a simple sequential queue in the
order the model emitted them. No lifecycle/action split. No reordering.

- Each tool either succeeds (200), fails (400+), or proposes (202)
- On failure: abort all remaining tools
- On proposal: push notification to client (WebSocket, same pattern as
  `run/progress`), await resolution inline, continue dispatch
- The `ask`/`act` RPC response is sent only when ALL tools complete
- Proposals are NOT batched — each is sent and resolved inline
- Post-dispatch: budget check (independent of tool outcomes)
- Lifecycle resolution: last summarize/update in `recorded` order wins

This replaces the legacy batch-proposal pattern where all tools
dispatched first, proposals accumulated, and the RPC returned 202
with a batch of proposed items. That pattern allowed tools to run
that depended on unresolved proposals — incorrect.

### TODO

**Documentation audit (next):**
- [ ] Audit all .md files for stale/incorrect content (AGENTS.md, SPEC.md,
  PLUGINS.md, README.md, plugin READMEs)
- [ ] Update AGENTS.md Current State section to reflect budget simplification,
  new preamble structure, removed tokens_full, etc.
- [ ] Update SPEC.md for current schema and behavior
- [ ] Freshen README.md for third-party review
- [ ] Verify plugin READMEs match current implementations
  (budget/README.md already updated, check others)
- [ ] Review PLUGINS.md third-party developer guide for accuracy

**Done (latest):**
- [x] Removed AgentLoop recovery loop — was bypassing all existing
  safety systems (stall detection, cycle detection, update repeats)
  via `continue`. Caused every infinite loop seen in demo runs.
- [x] 99 tool call cap enforced in XmlParser (`RUMMY_MAX_COMMANDS`).
  Bounds budget entry path listing by definition.
- [x] NULL scheme fix in `demote_all_full` (`COALESCE(scheme, '')`)
- [x] Think plugin: proper tooldoc, gated by `RUMMY_THINK` env var,
  first in tool order. Crashes if not set.
- [x] Unknown: wired `summary()` to `full()` (compact output)
- [x] Tool ordering: think → unknown → known → get → set → ...
- [x] E2E Story 13 rewritten for Turn Demotion (not recovery loop)

**Reasoning collection:**
- [ ] Verify reasoning output with `RUMMY_THINK=0` — does the model
  reason via API field when `<think>` tag is absent?
- [ ] Check llama.cpp server config for thinking budget

**Demo validation:**
- [ ] Fresh demo run with recovery loop removed — verify:
  - No infinite loops
  - Turn Demotion catches model-caused overflow
  - Model sees token counts, promotes selectively
  - Prompt visible at summary fidelity after demotion
  - Budget entries bounded (≤99 paths)
  - No `<env>` for directory listing
- [ ] Verify `<previous>` entries get model-written summary tags

**Prompt Demotion:**
- [ ] Verify both tiny-prompt (context at 99%) and monster-prompt
  (context at 75%) cases work correctly

### Testing Strategy

Write failing tests BEFORE implementing fixes. Each fix gets:
1. A failing test that reproduces the bug
2. The fix that makes it pass
3. Regression coverage going forward

Test locations:
- Unit: `src/**/*.test.js` (alongside source)
- Integration: `test/integration/`
- E2E: `test/e2e/` (real model, never mocked)

## Benchmark Plan

Benchmarks on hold until budget simplification is validated with demo runs.

### Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

### MAB Results (Grok, 32K context, Conflict_Resolution row 0)

- Taxonomy: 7/7 semantic paths, 6/7 keyword-format summaries
- Score: 1/100 (1.0%) — model retrieves correctly but trusts parametric
  knowledge over planted contradictions. CR-MH tests reasoning policy,
  not retrieval quality.
- The retrieval and taxonomy work. The 1% is not a system failure.

Taxonomy health check (fast, no questions):
```
npm run test:grok:taxonomy
npm run test:mab:taxonomy
```

## Deferred

- `src/plugins/progress/progress.js` — add recovery guidance
- Non-git file scanner fallback
- Community debut post (Latent Space) — after budget validation + LME run
