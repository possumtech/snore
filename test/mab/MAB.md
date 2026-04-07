# MemoryAgentBench (MAB)

Live benchmark of Rummy's memory management against the [MemoryAgentBench](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench) dataset.

## Setup

```bash
# Download the dataset (cached locally, ~130 MB)
npm run test:mab:get

# Optional: re-download from scratch
npm run test:mab:get -- --force
```

Data is stored in `test/mab/data/` (gitignored).

## Running

```bash
# Full benchmark (all 4 splits, 146 rows, ~14,600 questions)
npm run test:mab

# Single split
npm run test:mab -- --split Accurate_Retrieval

# Single row
npm run test:mab -- --split Accurate_Retrieval --row 0

# Row range
npm run test:mab -- --row 0-4

# Custom chunk size (default 4000 chars)
npm run test:mab -- --chunk-size 8000

# Override model
npm run test:mab -- --model xfast
```

The model defaults to `RUMMY_TEST_MODEL` from `.env.test` with standard cascading env rules.

## Splits

| Split | Rows | Questions/Row | Tests |
|---|---|---|---|
| Accurate_Retrieval | 22 | ~100 | Precise fact retrieval from long documents |
| Test_Time_Learning | 6 | ~200 | Adaptive learning during interaction |
| Long_Range_Understanding | 110 | 1-100 | Global comprehension from long contexts |
| Conflict_Resolution | 8 | ~100 | Detecting and updating outdated information |

## How It Works

For each benchmark row:

1. A fresh run is created with a descriptive alias (`mab_accu_0`, `mab_test_3`, etc.)
2. The context (273K–5.7M chars) is split into chunks and fed via `ask` prompts
3. The model is instructed to use `<known>` to save important facts
4. Each question is asked as a separate `ask` on the same run
5. The model's response is checked for containment of any valid answer (case-insensitive, strict substring match)

## Evaluation

Pass/fail. Each question has multiple valid answer strings. The model's response passes if any valid answer appears as a case-insensitive substring. No fuzzy matching, no LLM judge.

## Results

Each run produces a timestamped directory in `test/mab/results/`:

```
test/mab/results/2026-04-07T12-30-00-000Z/
├── results.ndjson   — per-row scores, token usage, timing, question details
├── mab.db           — full SQLite database with all agent state
└── last_run.txt     — raw SYSTEM/USER/ASSISTANT/USAGE dump (last turn)
```

Results are appended incrementally to `results.ndjson` so partial runs survive crashes.

## Auditing a Run

### Quick: check the report

The runner prints a summary after completion with per-split accuracy, token usage, and failed questions.

### Inspect a specific row's agent state

Open the preserved database and query what the model remembered:

```bash
DB=test/mab/results/<timestamp>/mab.db

# What did the model save as knowledge?
sqlite3 "$DB" "
  SELECT path, substr(body, 1, 120)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'mab_accu_0')
    AND scheme = 'known'
  ORDER BY turn;
"

# What was the full conversation for a specific turn?
sqlite3 "$DB" "
  SELECT path, substr(body, 1, 200)
  FROM known_entries
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'mab_accu_0')
    AND scheme IN ('system', 'user', 'assistant')
  ORDER BY turn, id;
"

# How many tokens per turn?
sqlite3 "$DB" "
  SELECT sequence, prompt_tokens, completion_tokens, cached_tokens, cost
  FROM turns
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'mab_accu_0')
  ORDER BY sequence;
"

# What was materialized into context for turn 5?
sqlite3 "$DB" "
  SELECT ordinal, path, category, tokens
  FROM turn_context
  WHERE run_id = (SELECT id FROM runs WHERE alias = 'mab_accu_0')
    AND turn = 5
  ORDER BY ordinal;
"
```

### Inspect the raw model interaction

```bash
cat test/mab/results/<timestamp>/last_run.txt
```

### Re-score from saved results

```bash
node -e "
  import { loadResults } from './test/mab/report.js';
  import { printReport } from './test/mab/report.js';
  const r = await loadResults('test/mab/results/<timestamp>/results.ndjson');
  printReport(r);
"
```

### Compare runs

```bash
# Side-by-side accuracy for two models
node -e "
  import { loadResults } from './test/mab/report.js';
  const a = await loadResults('test/mab/results/<timestamp-a>/results.ndjson');
  const b = await loadResults('test/mab/results/<timestamp-b>/results.ndjson');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    console.log(a[i].split, a[i].rowIndex,
      'A:', (a[i].score.accuracy * 100).toFixed(1) + '%',
      'B:', (b[i].score.accuracy * 100).toFixed(1) + '%');
  }
"
```
