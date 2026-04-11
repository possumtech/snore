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
13 model tools: get, set, known, unknown, env, sh, rm, cp, mv,
search, summarize, update, ask_user. Tool priority ordering (get first,
ask_user last). Unified tool exclusion via `resolveForLoop(mode, flags)`.
Budget: BudgetGuard at KnownStore layer gates every write during
dispatch. Pre-LLM check on assembled tokens. contextSize is the
ceiling, no margins. Token math: `ceil(text.length / RUMMY_TOKEN_DIVISOR)`.
No tiktoken. Panic mode: new prompt exceeds 90% of ceiling → model gets
restricted loop to free space to 50%, 3 strikes without reduction → hard 413.
500-token size gate on known entries. Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Both sent → update wins. Summarize
overridden when actions fail or when read actions (get/env/search) issued
in same turn (model cannot conclude before seeing results). `<think>` /
`<thought>` tags for model reasoning — inner tool calls captured as
rawBody, never dispatched.
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
154 unit tests passing.

## Benchmark Plan

### What we're measuring

Rummy's memory management under pressure. The claim: a small local model
running inside Rummy's context system can answer questions about documents
too large to fit in its context window — because panic mode compresses and
retrieves rather than failing. The benchmarks test whether that claim holds.

Hardware: local llama server, Gemma 4 26B Q3, 32K context, ~45s/chunk.
Token divisor: 2 (approximate). Results are system + model combined.

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

## Deferred

- Relevance engine (stochastic, separate project/plugin)
- Hedberg extraction to `@possumtech/rummy.hedberg` npm package
- Bulk operation aggregation (one entry per pattern operation)
- Non-git file scanner fallback

---

## Done: Session 2026-04-10/11 — Packet SDI Audit + E2E

40-item SDI audit. 36 fixed, 4 no-change. Summarize/read enforcement.
14/14 E2E passing. 154 unit tests passing.

## Done: Session 2026-04-09/10 — Budget Enforcement + Paradigm Shift

## Done: Session 2026-04-09 — Paradigm Audit

## Done: Session 2026-04-06/07

## Done: Earlier Sessions
