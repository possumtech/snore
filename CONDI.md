# Project Condi

Project Condi extends the agent's memory across runs by persisting `known` items as a keyed K/V store in SQLite. Recent values are injected into context automatically; older keys are discoverable via a full key index and retrievable on demand through the `recall` tool.

## Design Decisions

- **Only `known` is keyed.** Known items are conclusions, facts, and analysis — they have cross-run identity and recall value. Unknown items remain unkeyed strings; they serve as a steering mechanism that forces the model to articulate its uncertainty boundary each turn.
- **UPSERT, not append.** A known that's been superseded is wrong by definition. The store holds one value per key. No history.
- **The model is the ranking algorithm.** Rather than building an algorithmic eviction/promotion system, we give the model recent values and a full key index. It decides what to recall.

## Phase 1: Schema

Modify the `known` array from `string[]` to `{key, value}[]`.

Key constraint: `^_known_[a-z0-9_]{1,23}$`

Add to schema description:
> Known item keys must be lowercase, use underscores instead of spaces, and start with "_known_". Example: `_known_user_nickname`, `_known_auth_flow`. Values may reference other keys by name. Blank key ("") to remove.

## Phase 2: Persistence

Add a `known_entries` table (or equivalent) with UPSERT-on-key semantics. When the model emits known items, persist each key/value pair, overwriting any previous value for that key.

## Phase 3: Context Injection

Build a context plugin that, at the start of each run:

1. Injects a `<known>` block containing the previous run's key/value entries (full fidelity).
2. Injects a `<known_keys>` block listing all keys ever stored in the session (minus the full fidelity already served).

The model sees recent context in full and has a table of contents for everything else.

## Phase 4: Recall Tool

Add `recall` to the `todo` tool vocabulary. Accepts a key, returns its value from SQLite. No algorithm — just a lookup. The model discovers keys via the `<known_keys>` index and self-serves.

## Phase 5: Compressed Turn History

Replace full assistant turn history with a compressed state representation. Instead of sending every prior assistant response (reasoning, edits, tool calls), deliver:

1. **Known entries**: recent K/V (full fidelity) + all keys index.
2. **Unknowns**: previous turn's unknown list (current open questions).
3. **Summaries**: all turns' one-liner summaries in chronological order (narrative thread).
4. **Most recent assistant turn**: kept in full for behavioral continuity.

Everything before the most recent turn is dropped from history. The model gets what it knows, what it doesn't, the story of how it got here, and continuity with its last action — in a fraction of the tokens.

Gate this behind Phases 1-4 proving themselves. The K/V store must reliably capture the model's state before we thin the history it depends on.

## Future

With Phases 1-4 in place, the door is open for algorithmic enhancements:

- **Knowledge graph extraction**: the `_known_` prefix is a scannable anchor pattern. When the model writes `_known_auth_flow` inside another key's value or in its reasoning, that's an edge in a citation graph. Scan for `_known_` references across all values to build a graph of which knowledge depends on which other knowledge. Graph topology becomes the ranking policy — high-connectivity nodes are high-value, keys referencing files the model is currently working with are contextually relevant, keys appearing in reasoning content are actively used for inference. No algorithmic eviction needed; the graph structure *is* the eviction policy.
- **Smart context budgeting**: dynamically adjust how many recent entries get full injection based on context size.
- **Simulation harness**: replay recorded runs to test and optimize caching/eviction strategies offline.
- **Janitorial turns**: dedicated turns where the model consolidates, merges, or prunes its own key space.

These are worth pursuing once real usage data from Phases 1-5 reveals where the bottlenecks are.
