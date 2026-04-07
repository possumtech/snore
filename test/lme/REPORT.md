# LongMemEval Test Report

**Split**: `longmemeval_oracle` (evidence sessions only — ceiling test)
**Model**: gemma (16K context)
**Chunk size**: 4000 chars
**Date**: 2026-04-07

## Summary

| Row | Question ID | Type | Result | Eval | Root Cause |
|---|---|---|---|---|---|
| #0 | gpt4_2655b836 | temporal-reasoning | Correct answer, eval fail | ✗ | Evaluator: rubric substring mismatch |
| #1 | gpt4_2487a7cb | temporal-reasoning | Correct | ✓ | — |
| #2 | gpt4_76048e76 | temporal-reasoning | Correct | ✓ | — |
| #3 | gpt4_2312f94c | temporal-reasoning | Correct | ✓ | — |
| #4 | 0bb5a684 | temporal-reasoning | Correct answer, eval fail | ✗ | Evaluator: compound rubric not parsed |
| #5 | 08f4fc43 | temporal-reasoning | Correct answer, eval fail | ✗ | Evaluator: compound rubric not parsed |
| #6 | 2c63a862 | temporal-reasoning | Correct answer, eval fail | ✗ | Evaluator: compound rubric not parsed |
| #7 | gpt4_385a5000 | temporal-reasoning | Correct | ✓ | — |
| #8 | 2a1811e2 | temporal-reasoning | Correct answer, eval fail | ✗ | Evaluator: compound rubric not parsed |

**Factual accuracy**: 9/9 (100%)
**Evaluation pass rate**: 4/9 (44%)

## Row Details

### #0 — gpt4_2655b836 (temporal-reasoning) ✗ EVAL FAIL

**Question**: What was the first issue I had with my new car after its first service?
**Expected**: GPS system not functioning correctly
**Got**: A GPS system issue on 3/22, which the dealership resolved by replacing the entire GPS unit.

**Analysis**: The model correctly identified the GPS system issue and even provided the date and resolution. The answer is factually complete and correct. The evaluation fails because the response says "GPS system issue" rather than the exact rubric phrasing "GPS system not functioning correctly". Neither string is a substring of the other.

**Budget cascade**: 3 chunks ingested. Tier 1 demotions active during chunks 2 and 3 (11868/16384 tokens). Context pressure moderate.

**Conclusion**: Evaluator limitation. The model demonstrated correct knowledge retrieval and temporal reasoning. No architecture changes needed — the evaluation needs to handle paraphrase equivalence.

### #1 — gpt4_2487a7cb (temporal-reasoning) ✓ PASS

**Question**: Which event did I attend first, the 'Effective Time Management' workshop or the 'Data Analysis using Python' webinar?
**Expected**: 'Data Analysis using Python' webinar
**Got**: You attended the 'Data Analysis using Python' webinar first (around March 2023).

**Analysis**: Clean pass. The expected answer appears verbatim in the response. 2 chunks ingested, budget tier 1 demotions active (11036/16384). Model retained event names and temporal ordering correctly.

### #2 — gpt4_76048e76 (temporal-reasoning) ✓ PASS

**Question**: Which vehicle did I take care of first in February, the bike or the car?
**Expected**: bike
**Got**: The bike, which was repaired in mid-February.

**Analysis**: Clean pass. Short expected answer ("bike") easily matched as substring. 2 chunks, tier 1 demotions active (15564/16384 then 10000/16384 — two rounds of demotion). Despite heavy context pressure, the model retained the key fact.

### #3 — gpt4_2312f94c (temporal-reasoning) ✓ PASS

**Question**: Which device did I got first, the Samsung Galaxy S22 or the Dell XPS 13?
**Expected**: Samsung Galaxy S22
**Got**: You got the Samsung Galaxy S22 first.

**Analysis**: Clean pass. Expected answer is a specific noun phrase, easily matched. No notable budget pressure.

### #4 — 0bb5a684 (temporal-reasoning) ✗ EVAL FAIL

**Question**: How many days before the team meeting I was preparing for did I attend the workshop?
**Expected**: 7 days. 8 days (including the last day) is also acceptable.
**Got**: 7 days

**Analysis**: The model answered "7 days" which is the primary correct answer. The evaluation fails because the entire rubric string `"7 days. 8 days (including the last day) is also acceptable."` is used as the substring to match. The rubric is a natural-language description containing two acceptable answers, but the evaluator treats it as a single literal string.

**Conclusion**: The LME answer field contains compound rubrics for numeric questions. The evaluator needs to either: (a) split on sentence boundaries and check each, or (b) extract the primary answer before the period. No architecture issue.

### #5 — 08f4fc43 (temporal-reasoning) ✗ EVAL FAIL

**Question**: How many days had passed between the Sunday mass at St. Mary's Church and the Ash Wednesday service at St. Mary's Church?
**Expected**: 30 days. 31 days (including the last day) is also acceptable.
**Got**: 30 days

**Analysis**: Identical pattern to #4. Model answered "30 days" (correct). Rubric contains the answer but as part of a longer sentence. Evaluator substring check fails.

### #6 — 2c63a862 (temporal-reasoning) ✗ EVAL FAIL

**Question**: How many days did it take for me to find a house I loved after starting to work with a real estate agent?
**Expected**: 14 days. 15 days (including the last day) is also acceptable.
**Got**: It took 14 days.

**Analysis**: Same compound rubric pattern. "14 days" is correct but "14 days. 15 days (including the last day) is also acceptable." is not a substring of "It took 14 days."

### #7 — gpt4_385a5000 (temporal-reasoning) ✓ PASS

**Question**: Which seeds were started first, the tomatoes or the marigolds?
**Expected**: Tomatoes
**Got**: The tomatoes were started first (on February 20th), whereas the marigold seeds...

**Analysis**: Clean pass. Single-word answer "Tomatoes" matched easily. Fastest row (42s) — only 2 chunks, minimal budget pressure.

### #8 — 2a1811e2 (temporal-reasoning) ✗ EVAL FAIL

**Question**: How many days had passed between the Hindu festival of Holi and the Sunday mass at St. Mary's Church?
**Expected**: 21 days. 22 days (including the last day) is also acceptable.
**Got**: 21 days passed between the Holi celebration on February 26th and the Sunday mass...

**Analysis**: Same compound rubric pattern as #4, #5, #6. Model answered correctly.

## Conclusions

### Finding 1: Evaluator cannot handle compound rubrics

5 of 5 failures are evaluation artifacts. The LME dataset uses natural-language rubric strings like `"7 days. 8 days (including the last day) is also acceptable."` as the answer field. The MAB-style substring evaluator expects the answer to be a discrete value that appears verbatim in the response. It needs to be adapted for LME's rubric format — either by splitting compound answers on sentence boundaries or by extracting the primary answer (text before the first period).

### Finding 2: Factual accuracy is 100% on oracle split

The model correctly answered every question across 9 rows. The `<known>` ingestion captured all required facts, and the model retrieved them at question time despite active budget cascade demotions on every row.

### Finding 3: Budget cascade is aggressive but not destructive

Tier 1 (full→summary) demotions occurred during ingestion on 7/9 rows, even on the oracle split with only 2-3 sessions per row. The 16K context window is tight for this workload. Despite this, no facts were lost — the model's summaries retained the information needed to answer correctly.

### Finding 4: "Stalled" recovery is working

Every row triggered "Stalled: Same <update/> repeated 3 turns" — the model tends to repeat `<update>ready</update>` during ingestion. The force-completion mechanism handled this cleanly without data loss.

### Next Steps

1. Fix the evaluator to handle compound rubrics
2. Run `longmemeval_s_cleaned` rows 0-9 (53 sessions, real haystack noise) to test under realistic conditions
3. Test non-temporal question types (single-session-user, knowledge-update, etc.)
