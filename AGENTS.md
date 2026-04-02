# AGENTS: Planning & Progress

## Current State

Unified `prompt.md` sacred prompt with `[%TOOLS%]` placeholder — tools
registered dynamically from ToolRegistry. Mode (ask/act) per-prompt, not
per-run. `<ask warn="...">` carries restrictions; `<act>` has none.
Search is a plugin tool (web plugin), not core.

URI-based K/V store (`known://`, `summary://`, bare paths for files).
Scheme registry: `prompt://` (loop identity), `ask://`, `act://`, `progress://`.
Pattern operations produce `pattern` state result entries.
`preview` attribute for dry-run pattern operations.

Termination: `<update/>` continues, `<summary/>` terminates, plain text → summary.
Loop defense: repetition detector + stall counter + `RUMMY_MAX_TURNS`.
Tool result content composed at write time.
RPC audit log + model response diagnostics + error logging.
AbortSignal threaded through full call chain.
Prompt queue (persistent `prompt_queue` table, FIFO per run).
Run state machine v2 (all terminal states restartable).

### Testing

158 unit + 97 integration + 9 autonomous E2E stories + 3 live protocol tests.
`--test-force-exit` prevents hanging. Catalog fetch eliminated from test setup.

---

## Todo: State Simplification (state IS fidelity)

### Problem

State and fidelity overlap. The `v_model_context` VIEW computes fidelity from
`state + turn + scheme` via a complex CASE expression. The turn field gates
visibility (turn 0 = invisible) instead of just tracking freshness. Three
concepts (state, turn, fidelity) determine one thing: what the model sees.

### Design

State IS what the model sees. No separate fidelity computation.

| State | Model sees | How you get there |
|-------|-----------|-------------------|
| `full` | Complete content | `<read>`, client activate, engine promote |
| `summary` | Symbols (files) or snippets (URLs) | Symbol extraction, search results, engine demote |
| `index` | Path listed, no content | Default for all new files |
| `stored` | Nothing (retrievable via `<read>`) | `<store>`, known entries demoted below index |

The `turn` field becomes purely a freshness signal — when was this entry last
touched? The relevance engine uses turn for staleness. Visibility is determined
by state alone.

### File lifecycle

```
disk scan → state: index (path only, symbols in meta)
             ↓ client activate or <read>
           state: full (complete content visible)
             ↓ engine demote or <store>
           state: summary (symbols visible, content stored)
             ↓ further demote
           state: index (path only)
```

Default for every file on first scan: `index`. If symbols extracted: `summary`.
Only client-activated files start at `full`. No root file exception.

### URL / search result lifecycle

```
<search> → creates https:// entries at state: summary (snippet as content)
             ↓ <read>
           state: full (fetched page content)
             ↓ <store>
           state: index (URL listed)
```

Search results are first-class `https://` entries, not dumped into a
`search://` content body. The `search://` entry itself is just a confirmation:
"12 results for query". Each result URL is a separate `https://` entry at
`summary` state with the snippet as content.

### v_model_context VIEW simplification

Before (fidelity computed from state + turn + scheme):
```sql
CASE
  WHEN s.fidelity = 'turn' AND ke.state = 'summary' AND ke.turn > 0 THEN 'summary'
  WHEN s.fidelity = 'turn' AND ke.turn > 0 THEN 'full'
  WHEN s.fidelity = 'turn' AND ke.turn = 0 THEN 'index'
  ...
END AS fidelity
```

After (state IS fidelity):
```sql
CASE
  WHEN ke.state IN ('full', 'summary', 'index') THEN ke.state
  WHEN ke.state = 'stored' THEN NULL  -- not visible
  ...
END AS fidelity
```

### Category mapping

| State | Category (for assembler routing) |
|-------|--------------------------------|
| `full` (file/http/https) | `file` |
| `summary` (file/http/https) | `file_summary` |
| `index` (file/http/https) | `file_index` |
| `full` (known) | `known` |
| `stored` (known) | `known_index` |
| `full` (unknown) | `unknown` |
| result states | `result` |
| structural states | `structural` |

### Assembler rendering

| Category | Renders as |
|----------|-----------|
| `file` | Code-fenced file content with language tag |
| `file_summary` | Symbol signatures or URL snippets |
| `file_index` | Comma-separated path listing |
| `known` | Bullet list: `* path — value` |
| `known_index` | Comma-separated path listing |
| `unknown` | Bullet list: `* value` |
| `result` | Tool result with status symbol |
| `structural` | Summary/update in chronological messages |

### Implementation

- [ ] **Rename `symbols` → `summary`** — schema, SQL, JS, tests
- [ ] **Add `index` to file valid_states** — `["full", "summary", "index"]`
- [ ] **Add `summary` to http/https valid_states** — `["full", "summary"]`
- [ ] **File scanner** — new files default to `index`. Symbol extraction
      promotes to `summary`. Only `active` constraint promotes to `full`.
- [ ] **v_model_context VIEW** — simplify: state determines fidelity directly,
      turn is freshness only
- [ ] **Engine demotion** — `full` → `summary` → `index`. Clear cascade.
- [ ] **`<read>` promotion** — changes state to `full`
- [ ] **`<store>` demotion** — changes state to `index` (files) or `stored` (known)
- [ ] **ContextAssembler** — route by state-derived category
- [ ] **Search results as `https://` entries** — web plugin creates per-URL
      entries at `summary` state. `search://` is just the confirmation.
- [ ] **Update all tests**

### Trade-offs

**Pro:** One concept (state) determines visibility. No computed fidelity.
Simpler view. The relevance engine operates on state transitions, not
turn manipulation. Search results are first-class entries manageable with
standard tools.

**Risk:** The `turn` field loses its visibility role. Code that checks
`turn > 0` for "is this visible?" must change to check `state`. The engine's
budget enforcement currently sorts by turn for staleness — that still works,
but demotion changes state instead of turn.

**Open question:** Should `<store>` set state to `index` (still listed) or
`stored` (invisible)? For files, `index` makes sense — the model should know
the file exists. For known entries, `stored` makes sense — the key disappears
from context entirely.

---

## Todo: Search as Plugin Model

Search demonstrates the plugin architecture for tool registration,
documentation injection, and scheme handling.

- [ ] **Web plugin registers `search` tool** — �� done
- [ ] **Web plugin injects tool docs** — ✓ done
- [ ] **Search results as `https://` entries** — part of state simplification
- [ ] **`results` attribute** — ✓ done (default 12, model can request fewer)
- [ ] **URL fetch via `<read>`** — ✓ done (web plugin handles http/https reads)
- [ ] **Plugin creates new schemes** — search:// confirmation entry
- [ ] **Plugin extends `<read>` behavior** — URL detection routes to WebFetcher

---

## Todo: Remaining Cleanup

- [ ] **Delete prompt.ask.md, prompt.act.md** — replaced by prompt.md
- [ ] **Prompt carries model** — `prompt://` meta records model used
- [ ] **Remove `write` scheme** — write acts on target paths directly
- [ ] **ARCHITECTURE.md full pass** — align with state simplification
- [ ] **Non-git file scanner** — fallback for non-git projects

---

## Todo: Relevance Engine (deferred)

### Phase 2: Metrics
- [ ] Metrics plugin, separate DB, turn-level telemetry

### Phase 3: Ref Counting & Preheat
- [ ] Cross-reference counting from `meta.symbols`
- [ ] Auto-promote imports at summary state

### Phase 4: Decay
- [ ] Turn-based staleness demotion via state transitions
- [ ] Configurable decay rate per scheme
