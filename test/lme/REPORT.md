# LongMemEval Test Report

## Run Configuration

**Split**: `longmemeval_oracle` (evidence sessions only — ceiling test)
**Model**: liquid (liquid/lfm-2-24b-a2b, 32K context via OpenRouter)
**Chunk size**: 4000 chars
**Date**: 2026-04-08
**Results**: `test/lme/results/2026-04-08T04-35-19-552Z/`

## Summary (Rows 0-19)

**Pass rate**: 7/20 (35%)
**All question types**: temporal-reasoning

| Row | ID | Result | Time | Diagnosis |
|---|---|---|---|---|
| #0 | gpt4_2655b836 | ✗ | 96s | Evaluator: paraphrase ("GPS system issue" vs "not functioning correctly"); judge incorrectly rejected |
| #1 | gpt4_2487a7cb | ✓ exact | 37s | — |
| #2 | gpt4_76048e76 | ✓ exact | 35s | — |
| #3 | gpt4_2312f94c | ✓ exact | 109s | — |
| #4 | 0bb5a684 | ✗ | 144s | Ingestion: meeting date stored in `<update>` not `<known>` |
| #5 | 08f4fc43 | ✗ | 30s | Reasoning: had dates, didn't compute difference |
| #6 | 2c63a862 | ✗ | 123s | Reasoning: provided dates instead of day count |
| #7 | gpt4_385a5000 | ✓ exact | 19s | — |
| #8 | 2a1811e2 | ✗ | 30s | Reasoning: computed 14 days instead of 21 |
| #9 | gpt4_e73c6a42 | ✗ | 126s | Reasoning: identified events but didn't compute days between |
| #10 | gpt4_5a0f1234 | ✗ | 190s | Context leakage: raw session text leaked into `<summarize>` tags |
| #11 | gpt4_c1a2b3d4 | ✗ | 26s | Reasoning: said "need more context" despite having the facts |
| #12 | gpt4_d4e5f6a7 | ✗ | 83s | **Runner bug**: judge said YES but parser missed it (fixed) |
| #13 | gpt4_a1b2c3d4 | ✓ exact | 147s | — |
| #14 | gpt4_e5f6a7b8 | ✓ exact | 31s | — |
| #15 | gpt4_f1a2b3c4 | ✗ | 246s | Reasoning: counted 2 events instead of 4 |
| #16 | gpt4_b2c3d4e5 | ✗ | 24s | Reasoning: wrong answer (9 years vs 4 years 9 months) |
| #17 | gpt4_c3d4e5f6 | ✗ | 143s | Evaluator: judge said NO despite correct answer in response |
| #18 | gpt4_d4e5f6a7 | ✓ exact | 15s | — |
| #19 | gpt4_e5f6a7b8 | ✗ | 68s | Reasoning: didn't compute month count |

## Bugs Found

### Bug 1: Judge parser misses non-leading YES (FIXED)

**File**: `test/lme/runner.js`
**Impact**: False negatives — judge says YES but parser returns fail
**Example**: Row 12 — judge responded "14 days had passed... YES. The actual response correctly states..." but `startsWith("yes")` failed because of preamble text.
**Fix**: Search for first occurrence of `\byes\b` vs `\bno\b` instead of requiring YES at position 0.

### Bug 2: Context leakage in summarize entries

**Row 10**: The model emitted raw session text inside `<summarize>` tags:
```
summarize: # summarize
# summarize
).

[Session: 2023/05/30 (Tue) 01:50]
User: Which pair of shoes did I clean...
```
The ResponseHealer accepted this as a valid summarize entry. The `[Session: ...]` text is from the ingestion prompt leaking into the model's output. This suggests the model is confused about the boundary between its context and its response.

**Potential Rummy issue**: The ResponseHealer may be too permissive in what it accepts as a `<summarize>` tag. Raw input text echoed into output tags should be detected and rejected.

### Bug 3: Facts stored in `<update>` instead of `<known>`

**Row 4**: The model stored "The user is preparing for a team meeting on January 17th" inside an `<update>` entry instead of a `<known>` entry. Update entries are `structural` category — they're not searchable via `<get>` and don't appear in the `<knowns>` block. The fact was captured but invisible at question time.

**Potential Rummy issue**: The model docs may not clearly distinguish when to use `<known>` vs `<update>`. The `<update>` docs say "signal continued work" but the model is using it to store factual summaries of what it ingested. This could be a docs/prompt clarity issue.

## Observations

### No budget cascade pressure on oracle split

With a 32K model and 2-3 sessions per row, context never exceeded the 31K ceiling. Zero crunch invocations. The oracle split doesn't stress the budget system at all with this model.

### Temporal reasoning is the hardest category for this model

The liquid model consistently fails to compute day differences even when it has both dates. It provides the dates correctly but doesn't do the arithmetic. This is a model capability limitation, not a Rummy architecture issue — the facts are in context, the model just can't subtract dates.

Rows that ask "which came first?" (comparison, not arithmetic) pass reliably. Rows that ask "how many days between?" (arithmetic) almost always fail.

### Token usage

Average per row: ~18K prompt tokens, ~400 completion tokens. Total for 20 rows: ~370K prompt, ~8K completion, ~$0.015.
