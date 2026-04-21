# LME Oracle Failure Forensics — Gemma

**v1 run — SUPERSEDED**: Ran 2026-04-13T23-52-15Z with buggy summarize tooldoc. Killed at row 53. DB preserved at `test/lme/results/2026-04-13T23-52-15-057Z/`. Log at `/tmp/lme_oracle_gemma_v1.log`. Failures below are from this v1 run. They informed the summarize tooldoc fix that removed the conflating "Installed express, updated config" example.

**v2 run — SUPERSEDED**: Summarize fix, but OLD unknown-affirmation language ("If unknown, affirm you don't know"). Ran 2026-04-14T02-55Z, killed at row 27 (17/27 = 63% — worse than v1's 77% at same point; diagnosed as over-aggressive unknown affirmation). Log at `/tmp/lme_oracle_gemma_v2.log`, DB at `test/lme/results/2026-04-14T02-55-08-131Z/`.

**v3 run — ACTIVE**: Summarize fix + revised unknown language ("Attempt to resolve unknowns before acting or answering"). The resolve-loop pattern. Log at `/tmp/lme_oracle_gemma.log`.

Hardware: RTX 5070 Ti 16GB consumer GPU
Model: gemma (12GB, 32k context)

Preamble and judge settings identical to grok run.

---

## v1 RUN — Pre-Fix Failures (SUPERSEDED)

---

## ⚠️ RUNNER BUG DISCOVERED

The LME runner extracts the final answer in this priority order:
1. `<summarize>` entry body
2. Raw `<assistant>` entry body (tags stripped)
3. `<content>` entry body

**Gemma uses `<summarize>` differently than grok.** Gemma writes meta-descriptions ("Answered question about previous work duration") to summarize actions, while her actual answers land in `<content>` and `<assistant>` entries. The runner picks up the meta-description, the judge sees useless text, the row fails even when the real answer is correct.

**Rows affected (DB verified):**
- Row 16: actual answer was "approximately **5 years**" — expected "4 years and 9 months". Would likely PASS under judge's math-equivalence clause. Summarize body ("Answered question about previous work duration") was what the judge evaluated.

**Gemma's reported score is understated.** Re-extraction from `content`/`assistant` entries in the DB will give the true number after the run completes.

**Fix deferred**: Continuing the run to completion for diagnostic data. Extraction logic will be adjusted and results re-scored from the DB.

---

## Failures (raw, as reported by runner)

### Row 15 — temporal-reasoning, sessions=6, 776s
**Q**: How many charity events did I participate in before the 'Run for the Cure' event?
**Expected**: 4
**Got (extracted)**: "You participated in 0 charity events before the 'Run for the Cure' event."
**Judge**: FAIL

**Analysis**: 6-session heavy row, 776s duration. Model said 0 events. Either an aggregation failure or the budget pressure under 32k context caused information loss. Requires DB inspection to determine root cause.

### Row 16 — temporal-reasoning, sessions=2, 95s
**Q**: How long have I been working before I started my current job at NovaTech?
**Expected**: 4 years and 9 months
**Got (extracted)**: "Answered question about previous work duration" ← summarize meta-description
**Got (actual, from DB)**: "approximately **5 years** of work experience before starting your current job at NovaTech"
**Judge**: FAIL (on meta-description, not actual answer)

**Analysis**: Would likely PASS under correct extraction with math-equivalence judge. 4y9m ≈ 5 years.

### Row 17 — temporal-reasoning, sessions=2, 118s
**Q**: Which book did I finish reading first, 'The Hate U Give' or 'The Nightingale'?
**Expected**: 'The Hate U Give'
**Got (extracted)**: "Comparing reading history and timestamps" ← update tool body
**Got (from DB)**: No final answer. Model ran `<get>` on reading_history and interests, emitted `<update>Comparing reading history and timestamps</update>` as meta-commentary, never produced a conclusion. Turn ended without resolving the question.

**Analysis**: Genuine failure — gemma got stuck in retrieval, emitted status updates, didn't produce an answer. This is a different failure mode than grok's aggregation errors. Gemma seems to use `<update>` as a "thinking aloud" channel, and the response extractor catches that text rather than a conclusion. A second issue: the answer loop terminated before producing content.

**Category**: Agent behavior — meta-commentary instead of answer. Could be: (a) gemma's interpretation of the preamble contract, (b) budget pressure terminating the turn early, or (c) gemma's lower instruction-following visibility relative to grok.

### Row 24 — temporal-reasoning, sessions=2, 88s
**Q**: How long had I been a member of 'Book Lovers Unite' when I attended the meetup?
**Expected**: Two weeks
**Got**: "I don't have enough information to answer that. I know you joined 'Book Lovers Unite' three weeks ago, but I don't know when the meetup took place."
**Judge**: FAIL

**Analysis**: Unknown affirmation fired correctly (gemma stated what she knew — joined 3 weeks ago) but couldn't locate the meetup date. Either meetup timing wasn't filed or wasn't recovered via search. The math: 3 weeks ago (joined) minus 1 week ago (meetup) = 2 weeks of membership. Either retrieval or temporal inference failed.

### Row 29 — temporal-reasoning, sessions=2, 65s
**Q**: Which airline did I fly with the most in March and April?
**Expected**: United Airlines
**Got**: "American Airlines (2 flights), United (1 flight), Southwest (1 flight)"
**Judge**: FAIL

**Analysis**: Same question grok got wrong in prior (lost) run. Gemma counted American 2, United 1 — but expected answer is United. Either counting error (missed United flights) or miscategorization. Same reasoning failure mode as grok.

### Row 32 — temporal-reasoning, sessions=2, 630s
**Q**: Which device did I set up first, the smart thermostat or the new router?
**Expected**: new router
**Got**: "Comparing setup dates for thermostat and router."
**Judge**: FAIL

**Analysis**: Same meta-commentary pattern as rows 16, 17. Gemma emitted an `<update>` body with status text and didn't produce a final answer. 630s duration suggests she got stuck looping or exhausted turns without reaching a conclusion. Response extraction picked up the meta-text.

### Row 38 — temporal-reasoning, sessions=2, 503s
**Q**: How long did I use my new binoculars before I saw the American goldfinches return?
**Got**: "I cannot determine the exact duration from the available information."
**Judge**: FAIL

**Analysis**: Unknown affirmation. Required two dates (binoculars purchase, goldfinch sighting) to compute duration. Either one or both not filed/retrieved. 503s suggests gemma searched hard before giving up.

### Row 40 — temporal-reasoning, sessions=3, 54s
**Q**: How many weeks have I been accepted into the exchange program?
**Got**: "You had been accepted for 5 weeks when you started orientation."
**Judge**: FAIL

**Analysis**: Gemma gave specific number (5 weeks) at a specific point ("when you started orientation") but expected answer likely wanted current/present-tense duration, not past-tense.

---

## v2 RUN — Summarize Fix Only (SUPERSEDED)

Restarted with summarize tooldoc fix. Watching for:
1. Return of meta-commentary pattern (should be suppressed)
2. New failure modes introduced by the fix
3. Accuracy vs v1 baseline

### Row 1 — temporal-reasoning, sessions=2 (v1: PASSED, v2: FAILED — REGRESSION)
**Q**: Which event did I attend first, 'Effective Time Management' workshop or 'Data Analysis using Python' webinar?
**Expected**: 'Data Analysis using Python' webinar
**Got**: "I cannot determine the order of events due to missing dates."
**Judge**: FAIL

**Analysis**: Clean unknown affirmation — no meta-commentary, no `<update>` meta-text. The summarize fix suppressed that pattern. But this row passed in v1 (127s, judged). Either (a) noise on a single row, or (b) the fix shifted gemma's confidence calibration toward more unknown affirmations on borderline cases. Too early to call.
