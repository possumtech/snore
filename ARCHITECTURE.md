# RUMMY: Architecture Specification

This document is the authoritative reference for Rummy's design. The system prompt
files (`prompt.ask.md`, `prompt.act.md`) define model-facing behavior. This document
defines everything else: data model, protocol, context management, plugins, and testing.

---

## 1. The Known Store

All model-facing state lives in one table: `known_entries`. Files, knowledge,
tool results, summaries — everything is a keyed entry with a URI scheme
and state. No separate findings tables, no message history. The known store
IS the model's memory.

### 1.1 Schema

```sql
CREATE TABLE known_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT
    , run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
    , turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0)
    , path TEXT NOT NULL
    , value TEXT NOT NULL DEFAULT ''
    , scheme TEXT GENERATED ALWAYS AS (schemeOf(path)) STORED
    , state TEXT NOT NULL
    , hash TEXT
    , meta JSON
    , tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0)
    , tokens_full INTEGER NOT NULL DEFAULT 0 CHECK (tokens_full >= 0)
    , refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0)
    , write_count INTEGER NOT NULL DEFAULT 1 CHECK (write_count >= 1)
    , created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , CHECK (CASE
        WHEN scheme IS NULL
            THEN state IN ('full', 'symbols')
        WHEN scheme IN ('known', 'unknown')
            THEN state IN ('full', 'stored')
        WHEN scheme = 'edit'
            THEN state IN ('proposed', 'pass', 'warn', 'error')
        WHEN scheme IN ('run', 'env', 'delete', 'ask_user', 'move', 'copy')
            THEN state IN ('proposed', 'pass', 'warn')
        WHEN scheme IN ('read', 'drop')
            THEN state IN ('pass', 'info')
        WHEN scheme = 'summary' THEN state = 'summary'
        WHEN scheme IN ('system', 'user', 'reasoning', 'prompt', 'keys', 'inject', 'search')
            THEN state = 'info'
        WHEN scheme = 'retry' THEN state = 'error'
        WHEN scheme IN ('http', 'https')
            THEN state IN ('full')
        ELSE 0
      END)
);
CREATE UNIQUE INDEX idx_known_entries_run_path ON known_entries (run_id, path);
CREATE INDEX idx_known_entries_scheme_state ON known_entries (run_id, scheme, state);
CREATE INDEX idx_known_entries_turn ON known_entries (run_id, turn);
```

**Columns:**
- `path` — the entry's address. Bare file paths (`src/app.js`) or URIs (`known://auth`, `edit://7`).
- `scheme` — generated column: `schemeOf(path)`. Always correct by definition. Drives the CHECK constraint and indexed queries.
- `turn` — integer sequence number. Heat signal for files, production turn for results.
- `hash` — SHA-256 content hash for file change detection.
- `meta` — JSON metadata. Files store `{ symbols, constraint }`. Edits store `{ file, blocks, patch }`. Commands store `{ command }`.
- `tokens` — context cost at current fidelity. Updated on every state change (promote, demote, setFileState).
- `tokens_full` — cost of the raw value at full fidelity. Set on UPSERT, only changes when value changes.
- `refs` — cross-reference count. Reserved for the relevance engine.
- `write_count` — incremented on every UPSERT. Volatility tracking.

### 1.2 URI Schemes & States

Paths use URI scheme syntax. Bare paths (no `://`) are files. Everything else
uses `scheme://identifier`.

**Files** (`scheme IS NULL`) — project files bootstrapped at run start:

| State | Fidelity | Model sees |
|-------|----------|------------|
| `full` | full | `file` (with content) |
| `symbols` | summary | `file:symbols` (signatures only) |
| *(turn 0)* | index | path listed in File Index |

Client visibility constraints (`active`, `readonly`, `ignore`) are stored in the
`file_constraints` table (project-scoped), not in `known_entries.state`. The
FileScanner stores the constraint in `meta.constraint` for rendering labels.
Ignored files are excluded from scanning entirely.

**Knowledge** (`known://`, `unknown://`) — model-emitted:

| State | Meaning | Model sees |
|-------|---------|------------|
| `full` | Value loaded | `full` |
| `stored` | Key exists, value not in context | `stored` |

Unknowns are `unknown://N` entries. Sticky until the model drops them via
`<drop path="unknown://42"/>`. Server deduplicates on insert.

**Tool results** (`write://`, `run://`, `env://`, `delete://`, `ask_user://`, `move://`, `copy://`):

| State | Meaning |
|-------|---------|
| `proposed` | Awaiting user approval *(hidden until resolved)* |
| `pass` | Succeeded/accepted |
| `warn` | Rejected |
| `error` | Failed (edit only) |

**Internal** (`summary://`, `update://`, `system://`, `user://`, `prompt://`, `reasoning://`, `content://`, etc.):
- `summary://N` — state `summary` (run termination signal)
- `update://N` — state `info` (run continuation signal)
- `system://N`, `user://N`, `prompt://N`, `reasoning://N`, `content://N`, `keys://N`, `inject://N` — state `info`
- `retry://N` — state `error`

### 1.3 Path Namespaces

| Format | Namespace | Examples |
|--------|-----------|---------|
| bare path | File paths | `src/app.js`, `package.json` |
| `known://` | Knowledge | `known://auth_flow`, `known://db_adapter` |
| `unknown://` | Open questions | `unknown://1`, `unknown://42` |
| `[tool]://` | Tool results | `write://7`, `run://12`, `summary://3`, `update://5` |
| `http://`, `https://` | Fetched content | `https://docs.example.com/api` |

Result paths use the tool name as scheme and a sequential integer per run.
Tracked by `runs.next_result_seq`.

Knowledge path constraint: `known://[a-z0-9_]+`. Short lowercase slugs.
Prefer descriptive names — `known://oauth2_token_rotation` over `known://auth_rot`.

### 1.4 UPSERT Semantics

The known store uses INSERT OR REPLACE keyed on `(run_id, path)`. Each write
increments `write_count` (useful for detecting oscillation in future diagnostics).

There is no "empty value = delete" convention. Deletion uses the `delete` tool,
which removes the entry from the store entirely. A blank value is a legitimate
state (empty files, cleared entries).

### 1.5 State Lock

Application-level check: before calling the LLM, the server queries for proposed
entries (`KnownStore.getUnresolved()`). If any exist, the turn is blocked.
No database trigger — the check lives in code.

### 1.6 Resolution

When the client resolves a proposed entry via `run/resolve`:

- **`accept`** → state changes from `proposed` to `pass`. Value updated with output.
- **`reject`** → state changes from `proposed` to `warn`. Value updated with rejection reason.

The model sees the resolved entry as `stored` next turn. It can `read` the key
to see the full resolution output.

After all proposed entries are resolved:
- Any `warn` (rejection) → server returns `{ status: "resolved" }`, client decides next step.
- All `pass` → server auto-resumes the run (model needs a continuation turn).
- No actionable results → run completes.

---

## 2. XML Tool Commands

The model communicates via XML tags written directly in the response content.
No native tool calling API. No message history. The server parses the response
with htmlparser2 (forgiving HTML/XML parser). Free-form text between tool tags is
captured as `content://N` (assistant text) and `reasoning://N` (model thinking).
Both are hidden from the model but available for audit and client display.

### 2.1 Tool Inventory

The sacred prompts (`prompt.ask.md`, `prompt.act.md`) are the authoritative
tool reference. This section documents server behavior for each tool.

| Tool | ask | act | Body content | Scheme | States |
|------|-----|-----|-------------|--------|--------|
| `<unknown>` | yes | yes | open question text | `unknown` | `full`, `stored` |
| `<read>` | yes | yes | path (simple), or use attrs | `read` | `pass`, `info` |
| `<env>` | yes | yes | shell command | `env` | `proposed`, `pass`, `warn` |
| `<ask_user>` | yes | yes | comma-separated options | `ask_user` | `proposed`, `pass`, `warn` |
| `<search>` | yes | yes | search query | `search` | `info` |
| `<write>` | known:// only | files + known:// | content or SEARCH/REPLACE | `write` | `proposed`, `pass`, `warn`, `error` |
| `<move>` | yes | yes | destination path | `move` | `proposed`, `pass`, `warn` |
| `<copy>` | yes | yes | destination path | `copy` | `proposed`, `pass`, `warn` |
| `<drop>` | yes | yes | — | `drop` | `pass`, `info` |
| `<delete>` | yes | yes | — | `delete` | `proposed`, `pass`, `warn` |
| `<run>` | no | yes | shell command | `run` | `proposed`, `pass`, `warn` |
| `<update>` | yes | yes | brief status text | `update` | `info` |
| `<summary>` | yes | yes | final answer/result | `summary` | `summary` |

### 2.2 Unified Attribute System

Every store-facing tool uses the same attribute set. Pattern matching is via
`hedberg()` — auto-detects glob, regex, XPath, and JSONPath.

| Attribute | Meaning | Tools |
|-----------|---------|-------|
| `path` | Target path (hedberg pattern) | read, write, drop, delete, move, copy |
| `value` | Content filter (hedberg pattern) | read, write, drop, delete |
| `keys` | Preview mode — show matches, no changes | read, write, drop, delete |
| `question` | Question text | ask_user |

The parser accepts both attribute-style (`<read path="x"/>`) and body-style
(`<read>x</read>`) for applicable tools. Legacy attributes (`key=""`, `file=""`,
`to=""`) are silently remapped.

### 2.3 How Commands Become Known Entries

Every parsed command writes to the known store. The model sees results as
entries in the context next turn. Pattern-based commands operate on all matches.

**`<write>`** — the unified file + knowledge tool. Replaces old `<edit>` + `<known>`:
- Plain body → create or overwrite the entry at `path`
- SEARCH/REPLACE body → apply merge blocks via HeuristicMatcher
- `path` + `value` attrs → bulk-update matching entries
- File targets (scheme NULL): state `proposed` (client reviews)
- K/V targets (known://, etc.): state `pass` (applied immediately)

**`<unknown>`** — creates a sticky `unknown://N` entry (state `full`).
Persists across turns until explicitly dropped. Server deduplicates on insert.

**`<read>`** — promotes matching entries by setting `turn` to the current turn.
Values already exist in the store (from file scanner or previous write).
Promotion makes them visible in context next turn. With patterns, bulk-promotes.
URLs (`http://`, `https://`) are fetched via WebFetcher.

**`<drop>`** — demotes matching entries by setting `turn` to 0. Values stay
in the store but disappear from context. A dropped entry can be restored
with `<read>`. With patterns, bulk-demotes.

**`<delete>`** — removes entries from context AND permanently deletes them.
File targets: state `proposed` (client confirms). K/V targets: immediate removal.

**`<env>`** — creates an `env://N` entry, state `proposed`. The client executes
the command and resolves with output.

**`<run>`** — creates a `run://N` entry, state `proposed`. The client executes
and resolves with output. Act-only.

**`<ask_user>`** — creates an `ask_user://N` entry, state `proposed`. The client
shows the question with options and resolves with the selected answer.

**`<search>`** — web search via SearXNG. Stores results as `search://N` info entry.

**`<move>`** — reads source, writes to destination, removes source. File
destinations → proposed. K/V destinations → immediate.

**`<copy>`** — reads source, writes to destination. Source stays. Same file/K/V
split as move.

**`<update>`** — stores as `update://N` info entry. Signals the model is still
working. The run continues.

**`<summary>`** — stores as `summary://N` summary entry. Signals the model is
done. **The run terminates.**

**`keys` flag** — any store-facing tool with `keys` resolves the pattern and stores
the matching list as a `keys://N` info entry. No state change occurs. The entry
includes per-path token count and total:

```
23 paths (4812 tokens total)
src/auth.js (342)
src/config.js (128)
known://auth_flow (56)
```

### 2.4 Promotion Model

`read` and `drop` operate on the `turn` field, not on state:

| Command | Effect |
|---------|--------|
| `<read>x</read>` | Set `turn` to current turn → value appears in context |
| `<drop path="x"/>` | Set `turn` to 0 → value hidden from context (purgatory) |

Both support patterns: `<read path="src/*.js"/>` promotes all matching files.
`<drop value="deprecated"/>` demotes all entries containing "deprecated".

All other action commands (`env`, `run`, `delete`, `write`, `ask_user`) create new
result entries as `proposed`. The `delete` command for `known://*` or `[tool]://*`
paths removes the entry from the store entirely.

### 2.5 update/summary Termination Protocol

The model declares its own state via `<update/>` or `<summary/>`:

| Signal | Meaning | Run continues? |
|--------|---------|----------------|
| `<update>` only | Model is still working | Yes |
| `<summary>` only | Model is done | **No — run terminates** |
| Both present | Summary wins | **No — run terminates** |
| Neither present | Warn, increment stall counter | Yes (up to `RUMMY_MAX_STALLS`) |

Stall protection: if the model emits neither `<update>` nor `<summary>` for
`RUMMY_MAX_STALLS` consecutive turns (default 3), the run force-completes.

When neither is present, the server heals from the response content: plain text
becomes an update, empty responses get a `"..."` placeholder.

### 2.6 Enforcement Layers

1. **Prompt instructions + examples** — sacred prompts define tool commands with format and examples.
2. **htmlparser2 parsing** — forgiving parser recovers from unclosed tags, missing self-closing slashes, and malformed XML.
3. **Syntax flexibility** — the parser accepts both attribute-style and body-style for every tool. Legacy attributes are silently remapped.
4. **Response healing** (`ResponseHealer`) — every malformed response is recovered, never rejected. The server never throws on model output.
5. **Termination protocol** — `<summary>` terminates; `<update>` continues; neither → stall counter.
6. **Content capture** — free-form text between tags is captured as `content://N` (assistant text, hidden from model). Model thinking is captured as `reasoning://N`.

### 2.7 Response Healing Philosophy

Every malformed model response is a diagnostic opportunity, not a "model drift" excuse. When healing a response, ask in order:

1. **Can we recover?** Extract the data and continue.
2. **Can we warn usefully?** Log structured warnings that help future healing rules.
3. **Did our structure cause this?** Check if context formatting, prompt wording, or tool definitions nudged the model toward the failure.
4. **Did we miss something in prompts?** Check examples, instructions, continuation prompts.
5. **Model drift is the LAST answer**, after all of the above have been ruled out.

The server must never throw on model output.

### 2.8 Server Execution Order

The server parses all XML commands from the response, then processes in strict order:

1. **Store audit entries** — create `system://N`, `user://N` or `prompt://N`, `reasoning://N`, `content://N` entries.
2. **Execute action commands** — `read` promotes, `drop` demotes, `search` queries. `env`, `run`, `delete`, `write`, `ask_user`, `move`, `copy` generate result keys.
3. **Process unknowns** — create `unknown://N` entries, deduplicated.
4. **Process writes** — UPSERT each `<write>` tag's path/value (plain or SEARCH/REPLACE).
5. **Store status** — create `summary://N` or `update://N` entry.
6. **Emit `run/state`** — send client notification with history, proposed, unknowns, and telemetry.

---

## 3. Model Context

Two messages per turn. System carries stable truth (instructions + world state).
User carries the conversation (message history + current task). Models treat
system and user fundamentally differently — system is the behavioral contract,
user is high-signal task input. The current task (prompt or progress) is always
last in user — the highest-attention position.

### 3.1 Message Structure

```
system:
  <instructions>prompt.ask.md or prompt.act.md</instructions>
  <context>files, knowledge, unknowns (rendered from turn_context)</context>

user:
  <messages>chronological: prompts, tool results, updates, summaries</messages>
  <prompt>user question</prompt>        ← on first turn or new user input
  — OR —
  <progress>turn N/M, allowed tools</progress>  ← on continuation turns
```

**System** = instructions + context. Both are stable truth independent of the
current task. Instructions define the model's role and tools. Context is the
state of the world — files, knowledge, unknowns. Context is rendered from
`turn_context` and ends with unknowns (the uncertainty boundary).

**User** = messages + prompt/progress. Messages are the chronological conversation
log: previous user prompts, tool call results, updates, and summaries. The model
sees a narrative of what happened. The final element is always the current task:
either `<prompt>` (genuine user question) or `<progress>` (continuation status).

**Prompt** only appears when the user has asked something. It does not appear on
continuation turns.

**Progress** is ephemeral — it conveys turn count, token budget, and allowed tools
for the current continuation. Stored for audit but not part of the message history.

### 3.2 Context Materialization

Each turn, the engine materializes `turn_context` from `known_entries` via the
`v_model_context` VIEW. The VIEW joins the `schemes` table for fidelity rules
and uses `countTokens()` for accurate token counts. Ordinal assignment uses
`ROW_NUMBER()` to establish render order:

1. **Knowledge** — `known://*` at fidelity `full` (working memory)
2. **Stored keys** — `known://*` at fidelity `index` (discoverable, key only)
3. **File Index** — files at fidelity `index` (path listing)
4. **Symbol files** — files at fidelity `summary` (signatures only)
5. **Full files** — files at fidelity `full` (complete content)
6. **Unknowns** — `unknown://*` entries (uncertainty boundary, always last)

Results, summaries, updates, and prompts are NOT in context — they are in
messages (user message). The context is the model's world state; messages
are the conversation.

### 3.3 Fidelity

Each entry in `turn_context` has a `fidelity` level:

- **`full`** — complete content in context (file content, known values, results)
- **`summary`** — partial representation (file symbols/signatures)
- **`index`** — path/key listed, no content (file index, stored key listing)

Fidelity is derived from `scheme`, `state`, and `turn` via the `schemes` table
join in `v_model_context`. `read(key)` promotes by setting turn to current turn
(→ fidelity `full`). `drop(key)` demotes by setting turn to 0 (→ fidelity `index`).

### 3.4 File Bootstrap

At run start, the file scanner populates `known_entries` from disk. The scanner
checks `file_constraints` for client visibility rules: ignored files are skipped
entirely, and `active`/`readonly` constraints are stored in `meta.constraint`.

| Source | State | Turn | Value |
|--------|-------|------|-------|
| Agent-read (from `<read>`) | `full` | current | Full file contents |
| Root files (no `/` in path) | `full` | current | Full file contents |
| All other tracked files | `full` | 0 | Full file contents (path-only in context) |

Files at turn 0 appear as paths in the File Index. Files at turn > 0 appear with
full content in the Files section. The `symbols` state exists for use by
the Relevance Engine — a middle tier between full content and path-only. Symbols
are extracted by antlrmap/ctags and stored in `meta.symbols` on every file scan,
ready for when the Relevance Engine introduces heat-based promotion tiers.

### 3.5 File Change Detection

Each turn, the server scans the project's files and compares against
`known_entries.hash`:

1. Load `file_constraints` for the project — skip ignored files
2. Scan project for all non-ignored files and their current hashes
3. Across all active runs, add/update/delete file entries to match disk state
4. Store constraint in `meta.constraint` for VIEW rendering
5. Update the `turn` field on files that are model-read or newly modified

Files whose `turn` matches the current turn were recently engaged — this is
the heat signal for context budgeting.

The `refs` field will store cross-reference counts. The `hash` field enables
change detection without re-reading file contents. Both are inert (default 0 /
NULL) until the relevance engine and context budgeting are implemented.

Symbol extraction (ctags/antlrmap) runs when a file's hash changes. Symbols
are stored in `meta` on the file's known entry.

---

## 4. State Scopes

| Scope | Lifetime | Contains |
|-------|----------|----------|
| **Project** | Until deleted | Project path, name, git state |
| **Session** | Client connection | Config (persona, system prompt, skills, temperature, context limit) |
| **Run** | Open-ended conversation | `known_entries`, `turns` |
| **Turn** | Single LLM request/response | Entries written with that turn number |

### 4.1 Project Scope

- `projects` — project path, name, git hash, last indexed timestamp

No separate file index tables. File metadata (path, hash, symbols) lives in
`known_entries` as file-scheme entries. The project table is structural only.

### 4.2 Run Scope

- `known_entries` — the unified state machine. Files, knowledge, tool results, audit.
- `turns` — usage stats (prompt_tokens, completion_tokens, cost). Operational, not model-facing.
- `runs.next_result_seq` — sequential counter for result key generation
- `runs.next_turn` — sequential counter for turn numbers

Files are scanned from disk and written to `known_entries` per-run. Multiple
concurrent runs reference the same files as separate entries (different `run_id`,
same `key`). The file scanner updates all active runs in bulk when files change
on disk.

---

## 5. RPC Protocol

JSON-RPC 2.0 over WebSockets. The `discover` RPC returns the live protocol reference.

### 5.1 Methods

#### Session Setup

| Method | Params | Description |
|--------|--------|-------------|
| `ping` | — | Liveness check |
| `discover` | — | Returns method & notification catalog |
| `init` | `projectPath`, `projectName`, `clientId`, `projectBufferFiles?` | Initialize project and session |

#### Model Discovery

| Method | Params | Description |
|--------|--------|-------------|
| `getModels` | — | List available model aliases |
| `getModelInfo` | `model?` | Returns `{ alias, model, context_length, limit, effective, name, max_completion_tokens }` |

#### File Visibility (Project-Scoped)

Writes to `file_constraints` table. Constraints persist across runs.

| Method | Params | Description |
|--------|--------|-------------|
| `activate` | `pattern` | Set constraint to `active` (priority in context) |
| `readOnly` | `pattern` | Set constraint to `readonly` (edits blocked) |
| `ignore` | `pattern` | Set constraint to `ignore` (excluded from scanning) |
| `drop` | `pattern` | Remove constraint (revert to default) |
| `fileStatus` | `path` | Get file state + constraint |
| `getFiles` | — | Get project tree |

#### Run Execution

| Method | Params | Description |
|--------|--------|-------------|
| `ask` | `prompt`, `model?`, `run?`, `projectBufferFiles?`, `noContext?`, `fork?` | Non-mutating query |
| `act` | `prompt`, `model?`, `run?`, `projectBufferFiles?`, `noContext?`, `fork?` | Mutating directive |
| `run/resolve` | `run`, `resolution: {key, action: 'accept'\|'reject', output?}` | Resolve a proposed entry by its key |
| `run/abort` | `run` | Signal in-flight loop to stop via AbortController. Sets status to `aborted`. |
| `run/rename` | `run`, `name` | Rename a run. `[a-z_]+`, must be unique. |
| `run/inject` | `run`, `message` | Inject context (creates `inject://N` info entry) |
| `getRuns` | — | List runs for session |

All run params accept the **run name** (e.g. `ccp_1`), not a UUID. Model aliases
defined via `RUMMY_MODEL_{alias}` env vars.

#### Session Configuration

| Method | Params | Description |
|--------|--------|-------------|
| `systemPrompt` | `text` | Set system prompt override |
| `persona` | `text` | Set agent persona |
| `skill/add` | `name` | Enable skill |
| `skill/remove` | `name` | Disable skill |
| `getSkills` | — | List active skills |
| `setTemperature` | `temperature` | Set temperature (0-2) |
| `getTemperature` | — | Get temperature |
| `setContextLimit` | `limit` | Override context window (tokens). `null` resets to model default. Min 1024. |
| `getContext` | `model?` | Returns `{ model_max, limit, effective }` — model's max, session override, actual size used |

### 5.2 Notifications

| Notification | Payload | Description |
|---|---|---|
| `run/state` | See below | Primary turn update — sent after each turn |
| `run/progress` | `run`, `turn`, `status` | Turn status: `thinking`, `processing`, `retrying` |
| `ui/render` | `text`, `append` | Streaming output |
| `ui/notify` | `text`, `level` | Toast notification |

**`run/state` payload:**

```json
{
  "run": "kimi_1",
  "turn": 3,
  "status": "running",
  "summary": "Latest one-liner status.",
  "history": [
    {"path": "read://1", "tool": "read", "target": "src/auth.js", "status": "pass"},
    {"path": "summary://1", "tool": "summary", "status": "summary", "value": "Previous summary."},
    {"path": "edit://3", "tool": "edit", "target": "src/config.js", "status": "proposed"}
  ],
  "unknowns": [
    {"path": "unknown://1", "value": "Which session store is configured"}
  ],
  "proposed": [
    {"path": "edit://3", "type": "edit", "meta": {"file": "src/config.js", "patch": "---unified diff---"}}
  ],
  "telemetry": {
    "modelAlias": "kimi",
    "model": "moonshotai/kimi-k2.5",
    "temperature": 0.7,
    "context_size": 131072,
    "prompt_tokens": 3400,
    "completion_tokens": 280,
    "total_tokens": 3680,
    "cost": 0.0024,
    "context_distribution": [
      {"bucket": "system",  "tokens": 800,  "entries": 2},
      {"bucket": "files",   "tokens": 2400, "entries": 3},
      {"bucket": "keys",    "tokens": 120,  "entries": 45},
      {"bucket": "known",   "tokens": 340,  "entries": 5},
      {"bucket": "history", "tokens": 580,  "entries": 8}
    ]
  }
}
```

The client receives one notification per turn. `proposed` entries include `type`
(e.g., `"edit"`, `"run"`, `"ask_user"`) and `meta` with the patch/command/question.
The client routes by `type`, not by parsing key prefixes.
Resolution via `run/resolve` with `{ key, action: "accept"|"reject", output? }`.

### 5.3 Run Lifecycle

```
ask / act  →  turns  →  XML commands  →  known entries
                                            │
                              run/resolve ──┘ (per entry key: accept/reject)
                                            │
         ◄─────────────────────────────────┘ (auto-resume if all accepted)
```

Proposal gate: the application checks for proposed entries (§1.5) before each
turn. The client resolves each entry by its key (§1.6).

**Who applies edits to disk?** The client. The server proposes edits as known
entries. The client resolves them (accept/reject) and writes accepted changes
to its own filesystem. The server never touches the working tree.

### 5.4 Run Modes

| Mode | Params | Behavior |
|------|--------|----------|
| **Continue** | `run = <name>` | Same run, same known store |
| **New** | `run` omitted | Fresh run, fresh known store, file bootstrap |
| **Lite** | `noContext = true` | No file bootstrap |
| **Fork** | `fork = true` | New run, inherits parent's known store |

---

## 6. Provider Compatibility

Since tool commands are XML in the response content (not native tool calling),
provider compatibility is straightforward. Any provider that returns text
content works. No `strict: true`, `tool_choice`, or tool schema negotiation.

The server sends `{model, messages}` and parses the response content. Reasoning
content (`reasoning_content` field) is captured when providers return it.

### 6.1 Provider Configuration

| Prefix | Provider | Env vars |
|--------|----------|----------|
| *(none)* | OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` |
| `ollama/` | Ollama | `OLLAMA_BASE_URL` |
| `openai/` | OpenAI-compatible | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |

```env
RUMMY_MODEL_ccp=deepseek/deepseek-chat
RUMMY_MODEL_local=ollama/qwen3:latest
RUMMY_MODEL_DEFAULT=ccp
```

---

## 7. Plugin System

Plugins extend the server through a registration pattern. Core functionality
uses the same pattern — there is no distinction between "built-in" and
"third-party" at the registration level. The bundled plugins (tools, rpc,
symbols, telemetry, git, mapping, nvim) are loaded from `src/plugins/`.
User plugins are loaded from `~/.rummy/plugins/`.

### 7.1 Plugin Contract

A plugin is a `.js` file that exports a default class with a static `register` method:

```js
export default class MyPlugin {
    static register(hooks) {
        // Register tools, RPC methods, turn processors, event listeners, filters
    }
}
```

**Loading:** The loader scans each plugin directory for subdirectories containing
`index.js` or a file matching the directory name (e.g., `symbols/symbols.js`).
Test files are skipped. Plugins are loaded in directory order, then alphabetical.

**Deployment:** Drop a directory into `~/.rummy/plugins/`:
```
~/.rummy/plugins/
  my-plugin/
    my-plugin.js    ← exports default class with static register(hooks)
```

### 7.2 Registries

#### Tool Registry (`hooks.tools`)

Register XML tool commands the model can invoke:

```js
hooks.tools.register("weather", {
    modes: new Set(["ask", "act"]),
    category: "act",
});
```

The model writes `<weather city="London"/>` in its response. The server parses
the tag, creates a `weather://N` known entry as `proposed`, and the client
resolves it.

- `modes` — which run types this tool is available in.
- `category` — `"ask"` (direct execution), `"act"` (proposed for client), `"structural"` (metadata).

**Methods**: `get(name)`, `has(name)`, `actTools` (getter), `names` (getter), `entries()`.

#### RPC Registry (`hooks.rpc.registry`)

Register JSON-RPC methods:

```js
hooks.rpc.registry.register("myMethod", {
    handler: async (params, ctx) => {
        // ctx.projectAgent, ctx.modelAgent, ctx.db
        // ctx.projectId, ctx.sessionId, ctx.projectPath
        return { result: "value" };
    },
    description: "What this method does",
    params: { arg1: "description" },
    requiresInit: true,
});
```

Register notification metadata (for `discover` output):

```js
hooks.rpc.registry.registerNotification("my/notification", "Description.");
```

`discover` auto-generates from the registry. No manual catalog.

### 7.3 Turn Processors (`hooks.onTurn`)

Run logic before each LLM call. Priority controls execution order (lower = first).

```js
hooks.onTurn(async (rummy) => {
    if (rummy.noContext) return;
    // Access the K/V store
    const files = await rummy.store.getFileEntries(rummy.runId);
    // Inject content into context
    const node = rummy.tag("mycontent", {}, ["data"]);
    rummy.contextEl.children.push(node);
}, 10);
```

#### RummyContext API (`rummy`)

| Property | Type | Description |
|---|---|---|
| `db` | SqlRite | Database with all prepared queries |
| `store` | KnownStore | K/V store API (promote, demote, upsert, getValue, etc.) |
| `project` | Object | `{ id, path, name }` |
| `type` | String | `"ask"` or `"act"` |
| `sessionId` | String | Current session ID |
| `runId` | String | Current run ID |
| `turnId` | Number | Current turn ID |
| `sequence` | Number | Turn sequence number |
| `noContext` | Boolean | True in Lite mode |
| `contextSize` | Number | Token budget |
| `systemPrompt` | String | Built system prompt for this turn |
| `loopPrompt` | String | User/continuation prompt for this turn |
| `system` | Object | System node |
| `contextEl` | Object | Context node |
| `user` | Object | User node |
| `assistant` | Object | Assistant node |
| `tag(name, attrs?, children?)` | Function | Create a node |

The `store` property provides the full KnownStore API: `upsert`, `promote`,
`demote`, `remove`, `resolve`, `getValue`, `getMeta`, `getFileEntries`,
`getLog`, `countUnknowns`, `getUnresolved`, `hasRejections`.

The engine materializes `turn_context` from `known_entries` each turn via
the `v_model_context` VIEW (`INSERT INTO turn_context SELECT FROM v_model_context`).
Plugins read `turn_context` for the exact model view. The VIEW uses SQL
functions (`fidelityOf`, `countTokens`, `schemeOf`) registered at startup from
`src/sql/functions/`.

### 7.4 Events

Fire-and-forget notifications. All handlers run; return values ignored.

```js
hooks.run.step.completed.on(async (payload) => {
    console.log(`Turn ${payload.turn} completed for run ${payload.run}`);
}, 5);
```

| Hook | Payload | When |
|---|---|---|
| `project.init.started` | `{ projectPath, projectName, clientId }` | Before project setup |
| `project.init.completed` | `{ projectId, sessionId, projectPath, db }` | After project setup |
| `project.files.update.started` | `{ projectId, pattern, constraint }` | Before file state change |
| `project.files.update.completed` | `{ projectId, projectPath, pattern, constraint, db }` | After file state change |
| `run.started` | `{ run, sessionId, type }` | Run created |
| `run.progress` | `{ sessionId, run, turn, status }` | Turn progress: thinking, processing, retrying |
| `run.state` | `{ sessionId, run, turn, status, summary, history, unknowns, proposed, telemetry }` | Turn state update (one per turn) |
| `run.step.completed` | `{ sessionId, run, turn, flags }` | After each turn completes |
| `ask.started` | `{ sessionId, model, prompt, run }` | Ask run begins |
| `ask.completed` | `{ sessionId, run, status, turn }` | Ask run ends |
| `act.started` | `{ sessionId, model, prompt, run }` | Act run begins |
| `act.completed` | `{ sessionId, run, status, turn }` | Act run ends |
| `llm.request.started` | `{ model, turn }` | Before LLM API call |
| `llm.request.completed` | `{ model, turn, usage }` | After LLM API call |
| `ui.render` | `{ sessionId, text, append }` | Streaming output |
| `ui.notify` | `{ sessionId, text, level }` | Toast notification |
| `rpc.started` | `{ method, params, id, sessionId }` | RPC call received |
| `rpc.completed` | `{ method, id, result }` | RPC call succeeded |
| `rpc.error` | `{ id, error }` | RPC call failed |

### 7.5 Filters

Transform data through a chain. Each handler receives the value and context,
returns the (possibly modified) value. Priority controls order (lower = first).

```js
hooks.llm.messages.addFilter(async (messages, context) => {
    return [{ role: "system", content: "Extra instruction" }, ...messages];
}, 5);
```

| Hook | Value | Context | Purpose |
|---|---|---|---|
| `run.config` | Config object | `{ sessionId }` | Modify run configuration |
| `llm.messages` | Message array | `{ model, sessionId, runId }` | Transform LLM input |
| `llm.response` | Response object | `{ model, sessionId, runId }` | Transform LLM output |
| `file.symbols` | `Map<path, symbol[]>` | `{ paths, projectPath }` | Symbol extraction pipeline |
| `socket.message.raw` | Raw buffer | — | Transform incoming WebSocket data |
| `rpc.request` | Parsed request | — | Transform RPC request |
| `rpc.response.result` | Result object | `{ method, id }` | Transform RPC response |

### 7.6 Bundled Plugins

| Plugin | Directory | What it does |
|--------|-----------|-------------|
| **tools** | `src/plugins/tools/` | Registers the 10 core XML tool commands |
| **rpc** | `src/plugins/rpc/` | Registers 23 RPC methods + 4 notifications |
| **symbols** | `src/plugins/symbols/` | Symbol extraction via antlrmap (ANTLR4) + ctags fallback |
| **telemetry** | `src/plugins/telemetry/` | Debug logging on `run.step.completed` |
| **git** | `src/plugins/git/` | Git detection and status |
| **mapping** | `src/plugins/mapping/` | File scanning hooks |
| **nvim** | `src/plugins/nvim/` | Neovim integration |
| **engine** | `src/plugins/engine/` | Budget enforcement + turn_context materialization |

### 7.7 SQL Functions

Registered at startup via SqlRite's `functions` option. Available in all queries
and views. Source: `src/sql/functions/`.

| Function | Deterministic | Purpose |
|----------|--------------|---------|
| `schemeOf(path)` | Yes | Extract URI scheme from path (`"write://1"` → `"write"`, `"src/app.js"` → NULL) |
| `fidelityOf(scheme, state, turn)` | Yes | Classify entry into fidelity tier (`full`/`summary`/`index`/NULL) |
| `countTokens(text)` | Yes | Tiktoken o200k_base token count, `ceil(len/4)` fallback |
| `tierOf(scheme, state)` | Yes | Demotion priority tier (0–4) for budget enforcement |
| `langFor(path)` | Yes | File extension → syntax language name |
| `hedberg(pattern, string)` | Yes | Universal pattern matching — auto-detects glob, regex, XPath, JSONPath |

`schemeOf` powers the generated `scheme` column on `known_entries` and
`turn_context`. `fidelityOf` powers the `v_model_context` VIEW.

### 7.8 Examples

#### Replace Symbol Extraction (tree-sitter)

```js
import Parser from "web-tree-sitter";

export default class TreeSitterPlugin {
    static register(hooks) {
        hooks.file.symbols.addFilter(async (symbolMap, { paths, projectPath }) => {
            for (const relPath of paths) {
                if (symbolMap.has(relPath)) continue;
                const symbols = await extractWithTreeSitter(projectPath, relPath);
                if (symbols.length > 0) symbolMap.set(relPath, symbols);
            }
            return symbolMap;
        }, 40);  // priority 40 runs before default (50)
    }
}
```

The symbol array format: `[{ name, kind?, params?, line?, endLine? }]`.
`kind` is used for tree indentation (class/function/method). `line`/`endLine`
enable containment detection — methods between a class's line and endLine
are rendered as children.

#### Custom RPC Method

```js
export default class StatsPlugin {
    static register(hooks) {
        hooks.rpc.registry.register("getStats", {
            handler: async (params, ctx) => {
                const runs = await ctx.db.get_runs_by_session.all({
                    session_id: ctx.sessionId,
                });
                return { totalRuns: runs.length };
            },
            description: "Get run statistics for the current session",
            requiresInit: true,
        });
    }
}
```

#### Relevance Engine (turn processor)

```js
export default class RelevancePlugin {
    static register(hooks) {
        hooks.onTurn(async (rummy) => {
            if (rummy.noContext) return;
            const files = await rummy.store.getFileEntries(rummy.runId);
            for (const file of files) {
                // Promote high-ref files, demote stale ones
                if (file.refs > 3 && file.turn === 0) {
                    await rummy.store.promote(rummy.runId, file.key, rummy.sequence);
                }
            }
        }, 5);  // priority 5: runs early, before context assembly
    }
}
```

#### LLM Observability

```js
export default class MetricsPlugin {
    static register(hooks) {
        hooks.llm.request.started.on(async ({ model, turn }) => {
            console.log(`[metrics] LLM call: model=${model} turn=${turn}`);
        });
        hooks.llm.request.completed.on(async ({ model, turn, usage }) => {
            console.log(`[metrics] LLM done: ${usage?.total_tokens} tokens`);
        });
    }
}
```

---

## 8. Testing

| Tier | Location | Runner | LLM required? |
|------|----------|--------|---------------|
| Unit | `src/**/*.test.js` | `node --test` | No |
| Integration | `test/integration/**/*.test.js` | `node --test` | No |
| E2E | `test/e2e/**/*.test.js` | `node --test` | **Yes** |

E2E tests execute real turns against a live LLM. **E2E tests must NEVER mock
the LLM.** Coverage target: 80/80/80.

### 8.1 Environment Cascade

1. `.env.example` — load-bearing defaults (OPENROUTER_BASE_URL, PORT, etc.)
2. `.env` — local overrides (API keys, model aliases, DB path)
3. `.env.test` / `.env.dev` — mode-specific overrides

Always use `npm run test:*`. Never invoke node directly with a single env file.

---

## 9. Database Hygiene

On every startup, the server runs cleanup:

1. **`purge_old_runs`** — delete completed/aborted runs older than `RUMMY_RETENTION_DAYS` (default: 31). Cascades handle turns and known entries.
2. **`purge_stale_sessions`** — delete sessions with no runs.

### 9.1 Context Sizing

The context window is resolved per-turn: `min(session_override, model_max)`.

- **Model max** — reported by the provider catalog (OpenRouter) or `/api/show` (Ollama).
- **Session override** — set by the client via `setContextLimit({ limit: N })`. Stored in `sessions.context_limit`. Pass `null` to reset to model default.
- **Effective size** — passed as `rummy.contextSize` to turn processors and the Relevance Engine. The engine uses this budget to decide what to promote/demote.

The client retrieves sizing via `getContext({ model? })` → `{ model_max, limit, effective }`.

Token distribution is computed from `turn_context` via `get_turn_distribution`
and included in every `run/state` notification under
`telemetry.context_distribution`: `[{ bucket, tokens, entries }]`. Buckets:
`system`, `files`, `keys`, `known`, `history`.

### 9.2 Configuration

```env
RUMMY_MAX_TURNS=15              # Max continuation turns per run
RUMMY_MAX_UNKNOWN_WARNINGS=3    # Warnings before giving up on unknowns
RUMMY_MAX_REPETITIONS=3         # Identical summaries before force-completing
RUMMY_RETENTION_DAYS=31         # Days to keep completed runs
RUMMY_FETCH_TIMEOUT=120000      # LLM fetch timeout (ms)
RUMMY_RPC_TIMEOUT=30000         # Non-long-running RPC timeout (ms)
RUMMY_TEMPERATURE=0.7           # Default temperature (client can override)
```

---

## 10. Dependencies

| Dependency | Purpose |
|---|---|
| `@possumtech/sqlrite` | SQLite (author's own anti-ORM) |
| `ws` | WebSocket server |
| `htmlparser2` | XML parsing for model response tool commands |
| `tiktoken` | Token counting (o200k_base encoding, with `length/4` fallback). Registered as `countTokens()` SQL function via SqlRite. |

**Optional:** `@possumtech/antlrmap` — ANTLR4-based symbol extraction (formal grammars).
**CLI deps:** `ctags` (universal-ctags, fallback symbol extraction), `git` (file tracking, cached per HEAD hash).

---

## 11. Terminology

| Term | Definition |
|------|------------|
| **Project** | A codebase. Project path, name, git state. |
| **Session** | A client connection. Owns config (persona, system prompt, skills). |
| **Run** | An open-ended conversation. Owns `known_entries` and turns. |
| **Turn** | A single LLM request/response cycle. |
| **Known Entry** | A keyed entry in the unified state machine. |
| **Domain** | The entry's namespace: `file`, `known`, or `result`. |
| **State** | The entry's status within its scheme. Server-internal; the model sees a projection. |
| **Result Key** | A `[tool]://N` key generated for each tool command. Sequential per run. |
| **Rumsfeld Loop** | The turn cycle: the model uses `<write>` to persist knowledge, `<unknown>` to declare uncertainty, `<update>` to signal continued work, and `<summary>` to terminate. Forces discovery before modification. |
