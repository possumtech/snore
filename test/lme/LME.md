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
5. The model's response is checked for containment of the valid answer (case-insensitive, strict substring match)

## Evaluation

Pass/fail. The model's response passes if the answer appears as a case-insensitive substring. No fuzzy matching, no LLM judge.

## Results

Each run produces a timestamped directory in `test/lme/results/`:

```
test/lme/results/2026-04-07T12-30-00-000Z/
├── results.ndjson   — per-row scores, token usage, timing, question details
├── lme.db           — full SQLite database with all agent state
└── last_run.txt     — raw SYSTEM/USER/ASSISTANT/USAGE dump (last turn)
```

Results are appended incrementally to `results.ndjson` so partial runs survive crashes.

## Auditing a Run

### Quick: check the report

The runner prints a summary after completion with per-type accuracy, token usage, and failed questions.

### Inspect a specific row's agent state

```bash
DB=test/lme/results/<timestamp>/lme.db

# What did the model save as knowledge?
sqlite3 "$DB" "
  SELECT path, substr(body, 1, 120)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_s_0')
    AND scheme = 'known'
  ORDER BY turn;
"

# How many tokens per turn?
sqlite3 "$DB" "
  SELECT sequence, prompt_tokens, completion_tokens, cached_tokens, cost
  FROM turns
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'lme_s_0')
  ORDER BY sequence;
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
