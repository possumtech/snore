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
Budget: two declarative demotion events replace per-write BudgetGuard.
Ceiling: `floor(contextSize × 0.9)`. 413 never reaches the client.
  - **Prompt Demotion**: first-turn materialization 413s → prompt → summary,
    re-materialize, continue. Still 413 → genuine failure, return 413.
  - **Turn Demotion**: end-of-turn materialization 413s → all full data
    entries at current turn → summary + 413; prompt also summarized; writes
    `budget://` entry (registered by budget plugin, `category='logging'`);
    enters in-memory recovery phase. Recovery: model restricted to
    get/set/known/unknown/rm/cp/mv/summarize/update; 3 consecutive turns
    without token reduction → hard 413. Token target = ceiling; met when
    assembled ≤ ceiling; prompt fidelity restored on exit.
  - **Previous-loop logging demotion**: at loop start, batch-demote all full
    logging entries from other loops to summary (keeps `<previous>` compact).
Token math: `ceil(text.length / RUMMY_TOKEN_DIVISOR)`. No tiktoken.
500-token size gate on known entries. Glob matching via picomatch.
Tool docs in annotated `*Doc.js` line arrays with rationales.
Lifecycle/action split in TurnExecutor — summarize/update/known/unknown
always dispatch, never 409'd. Both sent → update wins. Summarize
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

## Active: Post-MAB Fixes

### Context: What MAB Taught Us
- Taxonomy quality (paths + summaries) is solved: 7/7 semantic, 6/7 keyword-format
- Parser bug fixed: XmlParser + TurnExecutor now pass `summary` attr to DB
- "Folksonomic memory agent" identity fixed MAB taxonomy but broke normal work
- Model loads raw files into entries instead of reading then filing findings
- LLM 400 (context exceeded) surfaces as 500 — should be 413

### Fix 1: LLM 400→413 error handling
- **File**: `src/llm/OpenAiClient.js` line 33-37
- **Bug**: Any non-OK LLM response throws generic Error. A 400 "context exceeded"
  is not transient, so TurnExecutor rethrows at line 318, propagating as 500.
- **Fix**: Detect context-exceeded 400s in the LLM catch block (line 309-319).
  Return 413 status in the same shape as existing budget enforcement (line 264-272).
  This routes into the existing demotion/panic machinery.
- [ ] Implement
- [ ] Test: send oversized context to LLM, verify 413 not 500

### Fix 2: Preamble rebalancing
- **Problem**: "Folksonomic memory agent" makes model treat filing as primary job.
  On real projects, it ingests raw source files into entries instead of working.
- **Fix**: Identity should convey "read sources, extract findings into known://"
  not "ingest everything." Files are sources, known:// is where findings go.
- [ ] Revise preamble line 1
- [ ] Demo run on rummy_dev.db to verify normal agent behavior

### Fix 3: Previous-entry summarization
- **Problem**: Auto-demotion of previous loop entries strips context without
  model-written summary tags. The model should summarize before/as entries demote.
- [ ] Design approach
- [ ] Implement

## Deferred

- `src/plugins/progress/progress.js` — add recovery guidance
- Non-git file scanner fallback
