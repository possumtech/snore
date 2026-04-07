# LongMemEval Test Report

**Split**: `longmemeval_oracle` (evidence sessions only — ceiling test)
**Model**: gemma (openai/gemma-4-26B, 16K context)
**Chunk size**: 4000 chars
**Date**: 2026-04-07

## Summary

| Row | Question ID | Type | Result | Eval | Diagnosis |
|---|---|---|---|---|---|
| #0 | gpt4_2655b836 | temporal-reasoning | ✓ | judged | Evaluator: paraphrase mismatch |
| #1 | gpt4_2487a7cb | temporal-reasoning | ✓ | exact | — |
| #2 | gpt4_76048e76 | temporal-reasoning | ✓ | exact | — |
| #3 | gpt4_2312f94c | temporal-reasoning | ✓ | exact | — |
| #4 | 0bb5a684 | temporal-reasoning | ✗ | — | Reasoning: facts in context but model said "I don't know" |
| #5 | 08f4fc43 | temporal-reasoning | ✓ | judged | Evaluator: compound rubric |
| #6 | 2c63a862 | temporal-reasoning | ✓ | judged | Evaluator: compound rubric |

**Factual accuracy**: 6/7 (86%)
**Evaluation pass rate**: 6/7 (86%)

## Rummy Issues Found

### Issue 1: `noInteraction` ReferenceError (FIXED)

`#executeLoop` in `AgentLoop.js:194` destructured `noContext` but not `noInteraction` from its parameter object. Line 265 references `noInteraction` as a bare variable — `ReferenceError`. The `#drainQueue` at line 176 passes it in, but `#executeLoop` never pulls it out.

**Impact**: Every `ask`/`act` call fails with status 500. Server is wedged.
**Fix**: Added `noInteraction` to the destructuring at line 194.

### Issue 2: Audit entries exempt from budget cascade (FIXED by user)

Model-visible audit entries (`ask://`, `progress://`) with `category: "prompt"` were not in `DEMOTION_ORDER`, making them immune to the budget cascade. Large ingestion prompts stored as `ask://` entries accumulated at full fidelity and couldn't be evicted. After 2 chunks, the audit trail alone exceeded 16K context.

**Impact**: Context floor exceeded model limit on every row. All calls return 500.
**Fix**: User added `result`, `structural`, `prompt` to `DEMOTION_ORDER` at tier 2.

## Row Details

### #0 — gpt4_2655b836 (temporal-reasoning) ✓ judged

**Question**: What was the first issue I had with my new car after its first service?
**Expected**: GPS system not functioning correctly
**Got**: Your car's GPS system was replaced by the dealership.

**Diagnosis**: Evaluator — model answered correctly (GPS system) but used different phrasing. LLM judge confirmed correctness. No architecture issue.

### #1 — gpt4_2487a7cb (temporal-reasoning) ✓ exact

**Question**: Which event did I attend first, the 'Effective Time Management' workshop or the 'Data Analysis using Python' webinar?
**Expected**: 'Data Analysis using Python' webinar
**Got**: The 'Data Analysis using Python' webinar first (around March 2023).

**Diagnosis**: Clean pass. 2 chunks, budget tier 1 active. Model retained event names and temporal ordering.

### #2 — gpt4_76048e76 (temporal-reasoning) ✓ exact

**Question**: Which vehicle did I take care of first in February, the bike or the car?
**Expected**: bike
**Got**: You took care of your bike first (mid-February).

**Diagnosis**: Clean pass. Two rounds of tier 1 demotion (15564 then 10000 tokens). Despite heavy context pressure, key fact retained.

### #3 — gpt4_2312f94c (temporal-reasoning) ✓ exact

**Question**: Which device did I got first, the Samsung Galaxy S22 or the Dell XPS 13?
**Expected**: Samsung Galaxy S22
**Got**: the date you bought the Samsung Galaxy S22 first.

**Diagnosis**: Clean pass. Two chunks with tier 1 active across multiple passes.

### #4 — 0bb5a684 (temporal-reasoning) ✗

**Question**: How many days before the team meeting I was preparing for did I attend the workshop?
**Expected**: 7 days. 8 days (including the last day) is also acceptable.
**Got**: I don't know how many days before the meeting you attended the workshop.

**Context at question time**:
- `known://Attended "Effective Communication..." workshop on January 10th` — summary fidelity, 0 tokens in turn_context
- `known://User is preparing for a team meeting on January 17th...` — full fidelity, 128 tokens
- 13 known entries at full, 5 at summary

**Diagnosis**: Reasoning problem. Both dates were in context — January 17th meeting at full fidelity with body, January 10th workshop in the entry path at summary fidelity. The path `known://Attended%20%22Effective%20Communication%20...%20workshop%20on%20January%2010th` contains the date but is URL-encoded. The model chose to say "I don't know" rather than computing the difference.

The model had both facts available but failed to connect them. The workshop date was only visible as a URL-encoded path slug (summary fidelity, body not rendered). A model with stronger reasoning might extract the date from the path, or the model could have used `<get>` to promote the entry.

### #5 — 08f4fc43 (temporal-reasoning) ✓ judged

**Question**: How many days had passed between the Sunday mass at St. Mary's Church and the Ash Wednesday service at the cathedral?
**Expected**: 30 days. 31 days (including the last day) is also acceptable.
**Got**: 30 days had passed.

**Diagnosis**: Evaluator — compound rubric. Model answered "30 days" which is correct. The expected answer string includes editorial text ("31 days... is also acceptable") that can't match by substring. LLM judge confirmed.

### #6 — 2c63a862 (temporal-reasoning) ✓ judged

**Question**: How many days did it take for me to find a house I loved after starting to work with a real estate agent?
**Expected**: 14 days. 15 days (including the last day) is also acceptable.
**Got**: (confirmed via judge)

**Diagnosis**: Same compound rubric pattern as #5. Model answered correctly.

## Observations

### Budget cascade is aggressive on 16K context

Tier 1 (full→summary) demotions occurred on every row during ingestion. Even the oracle split with 2-3 sessions triggers multiple demotion passes. The system prompt + tool docs + conversation history fills 16K quickly. This isn't a bug — it's working as designed — but it means many `<known>` entries are at summary fidelity by question time (path visible, body not rendered).

### Stall recovery is reliable but noisy

Every row triggers "Stalled: Same <update/> repeated 3 turns" during ingestion. The model tends to repeat `<update>ready</update>` without saving any `<known>` entries on some turns. The force-completion mechanism handles this without data loss, but it wastes 3 turns per stall.

### ResponseHealer is catching edge cases

Multiple rows show healer interventions: "plain text response treated as summary", "action-only response treated as summary", "missing <update>/<summarize>". The healer is doing its job — these would be silent failures without it.
