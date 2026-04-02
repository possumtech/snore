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
disk scan → state: index (path only)
             ↓ client activate or <read>
           state: full (complete content visible)
             ↓ <store>
           state: stored (invisible, retrievable via <read>)
```

Default for every file on first scan: `index`. Only client-activated files
start at `full`. No root file exception. No `summary` state on initial scan —
`summary` is introduced later by the relevance engine's symbol extraction.

`<store>` always demotes to `stored`. `<read>` always promotes to `full`.
The cascade is: `full` → `stored` → (read) → `full`. Engine demotion
(future) adds intermediate states: `full` → `summary` → `index` → `stored`.

### URL / search result lifecycle

```
<search> → search://slug at state: pass (confirmation: "12 results")
         → creates https:// entries at state: summary (snippet as content)
             ↓ <read>
           state: full (fetched page content via Playwright)
             ↓ <store>
           state: stored (invisible, retrievable)
```

Search results are first-class `https://` entries, not dumped into a
`search://` content body. The `search://` entry is just a confirmation:
"12 results for query". Each result URL is a separate `https://` entry at
`summary` state with the snippet as content. The model can `<read>` any
URL to fetch the full page, `<store>` irrelevant results, `<delete>` noise.

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

### Rename: `<summary>` → `<summarize>`

The `<summary>` tool collides with the `summary` fidelity state. Rename the
tool to `<summarize>` (verb — tells the model what to do). The `summary`
state (noun) describes fidelity. The `summary://` scheme stays.

- `<summarize>Run completed</summarize>` → creates `summary://slug | summary`
- `src/app.js | summary` → file at summary fidelity (symbols visible)
- No ambiguity between tool and state.

### Implementation

#### Phase 1: State simplification (immediate)

- [ ] **Rename `symbols` → `summary`** — file state, schema, SQL, JS
- [ ] **Rename `<summary>` → `<summarize>`** — parser, prompt, tool registration,
      healer, tests
- [ ] **Add `index` and `stored` to file valid_states** — `["full", "summary", "index", "stored"]`
- [ ] **Add `summary` and `stored` to http/https valid_states** — `["full", "summary", "stored"]`
- [ ] **File scanner** — all new files default to `index`. Only `active`
      constraint promotes to `full`. Symbol extraction deferred to relevance engine.
- [ ] **v_model_context VIEW** — simplify: state determines fidelity directly,
      turn is freshness only, no computed fidelity CASE
- [ ] **`<read>` promotion** — changes state to `full`
- [ ] **`<store>` demotion** — always changes state to `stored`
- [ ] **ContextAssembler** — route by state-derived category
- [ ] **Update all tests**

#### Phase 2: Search restructuring

- [ ] **Search results as `https://` entries** — web plugin creates per-URL
      entries at `summary` state with snippet as content
- [ ] **`search://` confirmation only** — "12 results for query" at `pass` state
- [ ] **Update web plugin and TurnExecutor**
- [ ] **Update E2E tests**

#### Phase 3: Engine demotion (future, with relevance engine)

- [ ] **Symbol extraction sets `summary` state** — ctags/antlrmap results
      promote files from `index` to `summary`
- [ ] **Engine demotion cascade** — `full` → `summary` → `index` → `stored`
- [ ] **Decay by turn staleness** — turn field drives demotion decisions

### Trade-offs

**Pro:** One concept (state) determines visibility. No computed fidelity.
Simpler view. The relevance engine operates on state transitions, not
turn manipulation. Search results are first-class entries. `<summarize>`
and `summary` are unambiguous.

**Risk:** Every `WHERE turn > 0` check must change to `WHERE state IN (...)`.
If any are missed, entries appear or disappear incorrectly.

**Decisions made:**
- `<store>` always demotes to `stored` (invisible). Consistent for all entry types.
- All files enter DB with full content regardless of state. State controls
  what the model sees, not what's stored. No premature optimization.
- Symbol extraction is deferred to the relevance engine. No `summary` state
  on files until the engine exists. Files are `full` or `index` for now.
- No root file exception. Only client-activated files get `full`.

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

## Todo: File Constraint Security

Client file constraints have security and trust implications. Three levels:

| Constraint | Behavior | Enforcement |
|-----------|----------|-------------|
| `active` | Full fidelity, included even if not in git | ✓ scanner includes non-git files |
| `readonly` | Full fidelity, model warned, writes rejected | ⚠ label rendered but writes NOT rejected |
| `ignore` | Excluded from scan, invisible to model | ✓ scanner skips, but `<read>` not blocked |

### Implementation needed

- [ ] **ReadOnly enforcement** — server rejects writes to readonly files in
      TurnExecutor, same pattern as ask-mode enforcement. The `<act>` tag
      or context label should warn the model not to attempt writes.
- [ ] **Ignore enforcement** — `<read>` on an ignored file should fail or
      return "file is ignored" rather than silently promoting it.
- [ ] **Active outside project root** — paths like `../../config.txt` need
      to resolve correctly relative to projectPath. Security: never allow
      active constraint to escape a defined boundary.
- [ ] **Plugin documentation split** — README.md per plugin folder

---

## Todo: Remaining Cleanup

- [ ] **Delete prompt.ask.md, prompt.act.md** — replaced by prompt.md
- [ ] **Prompt carries model** — `prompt://` meta records model used
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
