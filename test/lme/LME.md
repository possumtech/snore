# LongMemEval (LME)

Live benchmark of Rummy's long-term memory against the [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) dataset (ICLR 2025).

## Setup

```bash
# Download the dataset (s + oracle splits, ~290 MB)
npm run test:lme:get

# Include the 2.7 GB medium split
npm run test:lme:get -- --all

# Re-download from scratch
npm run test:lme:get -- --force
```

Data is stored in `test/lme/data/` (gitignored).

## Running

```bash
# Full benchmark (500 rows, 1 question each)
npm run test:lme

# Specific split
npm run test:lme -- --split longmemeval_s_cleaned

# Single row
npm run test:lme -- --row 0

# Row range
npm run test:lme -- --row 0-9

# Filter by question type
npm run test:lme -- --type knowledge-update

# Custom chunk size (default 4000 chars)
npm run test:lme -- --chunk-size 8000

# Override model
npm run test:lme -- --model xfast
```

The model defaults to `RUMMY_TEST_MODEL` from `.env.test` with standard cascading env rules.

## Splits

| Split | Rows | Tokens/Row | Description |
|---|---|---|---|
| longmemeval_s_cleaned | 500 | ~115K | Standard evaluation (~30-40 sessions/row) |
| longmemeval_m_cleaned | 500 | ~1.5M | Stress test (~500 sessions/row) |
| longmemeval_oracle | 500 | minimal | Oracle — evidence sessions only (diagnostic ceiling) |

## Question Types

| Type | Memory Ability |
|---|---|
| single-session-user | Retrieve fact from a single user message |
| single-session-assistant | Retrieve fact from a single assistant response |
| single-session-preference | Generate personalized response from history |
| multi-session | Synthesize information across 2+ sessions |
| temporal-reasoning | Time-aware reasoning with explicit timestamps |
| knowledge-update | Recognize when user information changed over time |
| false-premise | Abstain — question asks about unknown information |

## How It Works

For each benchmark row:

1. A fresh run is created with a descriptive alias (`lme_s_0`, `lme_orac_3`, etc.)
2. The conversation history (haystack sessions with timestamps) is serialized and chunked
3. Chunks are fed via `ask` prompts; the model uses `<known>` to save facts
4. The question is asked as a separate `ask` on the same run (with `question_date` context)
5. The model's response is evaluated: substring match first, LLM judge as fallback

## Evaluation

Two-tier. First, strict substring containment (case-insensitive). If that fails and the model produced a response, an LLM judge evaluates whether the response correctly answers the question. Results are tagged `exact` or `judged` so the distinction is visible.

## Results

Each run produces a timestamped directory in `test/lme/results/`:

```
test/lme/results/2026-04-07T12-30-00-000Z/
├── results.ndjson   — per-row scores, token usage, timing, question details
├── lme.db           — full SQLite database with all agent state
└── last_run.txt     — raw SYSTEM/USER/ASSISTANT/USAGE dump (last turn)
```

Results are appended incrementally to `results.ndjson` so partial runs survive crashes.

## Diagnostic Audit

Run rows incrementally and build `test/lme/REPORT.md` with per-row analysis.

### Report Format

Each row gets its own section:

```markdown
### #0 — gpt4_2655b836 (temporal-reasoning) ✗
**Question:** What was the first issue I had with my new car after its first service?
**Expected:** GPS system not functioning correctly
**Got:** A GPS system issue on 3/22, which the dealership resolved by replacing the entire GPS unit.
**Turns used:** 5
**Context at question time:** 12 full, 8 summary, 4 index, 6 stored

**Diagnosis:** Evaluator — model answered correctly ("GPS system issue") but
the substring evaluator requires the exact rubric phrasing "GPS system not
functioning correctly". The LLM judge confirmed the answer is correct.

**Recommendation:** No architecture change needed. Evaluation limitation.
```

### Diagnosis Rules

The diagnosis for each failed question MUST be one of:

1. **Context problem** — necessary facts were demoted out of context.
   Recommendation: adjust cascade priority, visibility, or budget.
2. **Budget problem** — context floor exceeded model limit; run returned 500.
   Recommendation: identify what's consuming the floor (audit entries, stash indices, system prompt).
3. **Prompt problem** — model misunderstood the task or used wrong tools.
   Recommendation: adjust question prompt or system prompt.
4. **Ingestion problem** — facts were never saved during ingestion.
   Recommendation: adjust ingestion prompt or chunk size.
5. **Evaluator problem** — model answered correctly but evaluation failed.
   Recommendation: describe the mismatch (rubric format, paraphrase, etc.).
6. **Reasoning problem** — model had the facts but chained wrong.
   Recommendation: describe what went wrong. If the model had every
   necessary fact and still answered wrong, state that clearly.
7. **Unknown** — unable to determine root cause from available data.
   State what was checked and what remains unclear.

The diagnosis CANNOT be "model drift" or "model limitation." If the model
failed, something in the context, prompt, or design allowed it to fail.

## Auditing a Run (Quick)

### Inspect a specific row's agent state

```bash
DB=test/lme/results/<timestamp>/lme.db

# What did the model save as knowledge?
sqlite3 "$DB" "
  SELECT path, substr(body, 1, 120)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_orac_0')
    AND scheme = 'known'
  ORDER BY turn;
"

# What was the full conversation for a specific turn?
sqlite3 "$DB" "
  SELECT path, substr(body, 1, 200)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_orac_0')
    AND scheme IN ('system', 'user', 'assistant')
  ORDER BY turn, id;
"

# How many tokens per turn?
sqlite3 "$DB" "
  SELECT sequence, prompt_tokens, completion_tokens, cached_tokens, cost
  FROM turns
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_orac_0')
  ORDER BY sequence;
"

# Fidelity distribution at question time
sqlite3 "$DB" "
  SELECT visibility, count(*), sum(tokens)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_orac_0')
  GROUP BY visibility;
"
```

### Re-score from saved results

```bash
node -e "
  import { loadResults, printReport } from './test/lme/report.js';
  const r = await loadResults('test/lme/results/<timestamp>/results.ndjson');
  printReport(r);
"
```

### Compare runs

```bash
node -e "
  import { loadResults } from './test/lme/report.js';
  const a = await loadResults('test/lme/results/<timestamp-a>/results.ndjson');
  const b = await loadResults('test/lme/results/<timestamp-b>/results.ndjson');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    console.log(a[i].questionType, a[i].rowIndex,
      'A:', (a[i].score.accuracy * 100).toFixed(1) + '%',
      'B:', (b[i].score.accuracy * 100).toFixed(1) + '%');
  }
"
```
