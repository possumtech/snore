# RUMMY: Architecture Specification

This document is the authoritative reference for Rummy's design. The system prompt
files (`prompt.ask.md`, `prompt.act.md`) define model-facing behavior. This document
defines everything else: data model, protocol, context management, plugins, and testing.

---

## 1. The Known Store

All model-facing state lives in one table: `known_entries`. Files, knowledge,
tool results, findings, summaries — everything is a keyed entry with a domain
and state. There are no separate findings tables, pending context queues, file
promotion tables, or message history. The known store IS the model's memory.

### 1.1 Schema

```sql
CREATE TABLE known_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT
    , run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE
    , turn INTEGER NOT NULL DEFAULT 0
    , key TEXT NOT NULL
    , value TEXT NOT NULL DEFAULT ''
    , domain TEXT NOT NULL CHECK (domain IN ('file', 'known', 'result'))
    , state TEXT NOT NULL
    , hash TEXT
    , meta JSON
    , tokens INTEGER NOT NULL DEFAULT 0
    , refs INTEGER NOT NULL DEFAULT 0
    , write_count INTEGER NOT NULL DEFAULT 1
    , created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , CHECK (
        (domain = 'file' AND state IN ('full', 'readonly', 'active', 'ignore', 'symbols'))
        OR (domain = 'known' AND state IN ('full', 'stored'))
        OR (domain = 'result' AND state IN ('proposed', 'pass', 'info', 'warn', 'error', 'summary'))
    )
);
CREATE UNIQUE INDEX idx_known_entries_run_key ON known_entries (run_id, key);
CREATE INDEX idx_known_entries_domain_state ON known_entries (run_id, domain, state);
CREATE INDEX idx_known_entries_turn ON known_entries (run_id, turn);
```

**Columns:**
- `turn` — integer sequence number. For files, the most recent turn that engaged with the file (heat signal). For results, the turn that produced them. Not a FK — just a number.
- `hash` — content hash (SHA-256) for change detection. The file scanner compares this against the current disk hash to detect modifications without re-reading contents.
- `meta` — JSON metadata. Files store symbols here. Tool results store the original command/args.
- `tokens` — integer, computed by SQLite on UPSERT: `length(value) / 4`. Tracks the token cost of including this entry in context.
- `refs` — integer, default 0. Cross-reference count. Reserved for the relevance engine.
- `write_count` — integer, incremented on every UPSERT. Tracks volatility (oscillation detection).

### 1.2 Domains & States

**File domain** — project files bootstrapped at run start:

| State | Meaning | Model sees |
|-------|---------|------------|
| `full` | Full content, editable | `file` |
| `readonly` | Full content, not editable | `file:readonly` |
| `active` | Client-promoted (editor focus) | `file:active` |
| `ignore` | Excluded from context | *(hidden)* |
| `symbols` | Signature summaries only | `file:symbols` |

**Known domain** — model-emitted knowledge (`/:known:*` keys) and internal state:

| State | Meaning | Model sees |
|-------|---------|------------|
| `full` | Value loaded | `full` |
| `stored` | Key exists, value not in context | `stored` |

Unknowns are individual `/:unknown:N` entries (domain `known`, state `full`).
Each `unknown("text")` call creates a sticky entry that persists until the model
drops it via `drop("/:unknown:N")`. The server deduplicates on insert.

**Result domain** — tool command results, summaries, and notifications (`/:[tool]:*` keys):

| State | Meaning | Model sees |
|-------|---------|------------|
| `proposed` | Awaiting user approval | *(hidden until resolved)* |
| `pass` | Succeeded/accepted | `stored` |
| `info` | Informational notification | `stored` |
| `warn` | Rejected/partial | `stored` |
| `error` | Failed | `stored` |
| `summary` | Summary text | `stored` |

The model sees a projection controlled by the `turn` field (see §3.3). `file:ignore`
and `proposed` entries are hidden. Result entries show their actual status
(pass/warn/error/summary) in the context. The model can `read` any result key
to recall the full value.

### 1.3 Key Namespaces

Keys use the `/:` sentinel to distinguish system keys from file paths. No
relative file path starts with `/:`, so the prefix is unambiguous. Regex: `/^\/:/`.

| Prefix | Namespace | Examples |
|--------|-----------|---------|
| *(none)* | File paths | `src/app.js`, `package.json` |
| `/:known:` | Knowledge entries | `/:known:auth_flow`, `/:known:db_adapter` |
| `/:[tool]:` | Tool result keys | `/:read:4`, `/:edit:7`, `/:run:12`, `/:summary:3` |

Result keys use the tool name as prefix and a sequential integer per run.
Tracked by `runs.next_result_seq`. Self-documenting: `/:read:4` tells you
it was the 4th result key generated, produced by the `read` tool.

Knowledge key constraint: `^/:known:[a-z0-9_]+$`. Short lowercase slugs.
Prefer descriptive names over abbreviations — `/:known:oauth2_token_rotation`
over `/:known:auth_rot`.

### 1.4 UPSERT Semantics

The known store uses INSERT OR REPLACE keyed on `(run_id, key)`. Each write
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
with htmlparser2 (forgiving HTML/XML parser). Any text between tool tags is
captured as `/:reasoning:N` (hidden from model, available for audit).

### 2.1 Tool Commands

**Shared (ask + act):**

| Tag | Format | Required |
|-----|--------|----------|
| `<summary>` | `<summary>text</summary>` | Yes |
| `<known>` | `<known key="/:known:slug">value</known>` | No |
| `<unknown>` | `<unknown>text</unknown>` | No |
| `<read>` | `<read key="path"/>` | No |
| `<drop>` | `<drop key="path"/>` | No |
| `<env>` | `<env command="cmd"/>` | No |
| `<ask_user>` | `<ask_user question="q" options="a, b, c"/>` | No |

**Act-only (extends shared):**

| Tag | Format |
|-----|--------|
| `<run>` | `<run command="cmd"/>` |
| `<delete>` | `<delete key="path"/>` |
| `<edit>` | `<edit file="path">SEARCH/REPLACE blocks</edit>` |

Edit uses git merge conflict format inside the tag body:

```
<edit file="src/config.js">
<<<<<<< SEARCH
const port = 3000;
=======
const port = 8080;
>>>>>>> REPLACE
</edit>
```

Tool commands are defined in the system prompt (`prompt.act.md`, `prompt.ask.md`)
with examples. The server parses them from the response content via htmlparser2.
No JSON schema, no AJV, no `strict: true`, no `tool_choice`.

### 2.2 How Commands Become Known Entries

Every parsed command writes to the known store. The model sees results as
entries in the context next turn.

**`<known>`** — UPSERTs the key/value pair into the store with domain `known`,
state `full`. The model emits one tag per entry.

**`<summary>`** — creates a `/:summary:N` entry with domain `result`, state `summary`.

**`<unknown>`** — each tag creates a sticky `/:unknown:N` entry (domain `known`,
state `full`). Unknowns persist across turns until explicitly dropped by the model
via `<drop key="/:unknown:N"/>`. The server deduplicates on insert — identical text
is not re-registered. Unknowns appear in context position 7 (before the prompt)
every turn. The server warns and retries (up to 3 times) if the model attempts
to complete with unresolved unknowns and no investigation tools called.

**`<read>`** — promotes the key by setting `turn` to the current turn number.
The value is already in the store (from the file scanner or a previous write).
Promotion makes it visible in the model's context next turn. One integer update.

**`<drop>`** — demotes the key by setting `turn` to 0 (purgatory). The value stays
in the store but disappears from the model's context. One integer update.

**`<env>`** — creates a `/:env:N` entry with domain `result`, state `proposed`.
The client executes the command and resolves with output.

**`<edit>`** — the server computes a unified diff from the file's current content
(in known_entries) and the model's SEARCH/REPLACE blocks via HeuristicMatcher.
Creates a `/:edit:N` entry with state `proposed`. The `meta` field stores
`{file, blocks, patch, warning, error}`. The patch is sent to the client for review.

**`<run>`** — creates a `/:run:N` entry with domain `result`, state `proposed`.
The client executes and resolves with output.

**`<delete>`** — creates a `/:delete:N` entry with domain `result`, state `proposed`.
The client confirms and resolves.

**`<ask_user>`** — creates a `/:ask_user:N` entry with domain `result`, state `proposed`.
The client shows the question and resolves with the selected answer.

### 2.3 Promotion Model

`read` and `drop` operate on the `turn` field, not on state:

| Command | Effect |
|---------|--------|
| `<read key="x"/>` | Set `turn` to current turn → value appears in context |
| `<drop key="x"/>` | Set `turn` to 0 → value hidden from context (purgatory) |

All other action commands (`env`, `edit`, `run`, `delete`, `ask_user`) create new
result entries as `proposed`. The `delete` command for `/:known:*` or `/:[tool]:*`
keys removes the entry from the store entirely.

### 2.4 Enforcement Layers

1. **Prompt instructions + examples** — system prompt describes tool commands with format and examples. The model is told "You must respond with tool commands and may ONLY respond with tool commands."
2. **htmlparser2 parsing** — forgiving parser recovers from unclosed tags, missing self-closing slashes, and malformed XML. Warns but does not reject.
3. **Server-side validation** — confirms `<summary>` is present. Injects `"..."` placeholder if missing. Rejects and retries only on completely empty responses (no commands at all).
4. **Unknowns gate** — if the model has unresolved `/:unknown:*` entries and called no investigation commands (`read`, `env`, etc.), the server warns and retries up to 3 times. Investigating resets the counter. After 3 idle warnings, the run completes anyway. The internal prompt on continuation turns shows "N unresolved unknowns."
5. **Reasoning capture** — any free-form text between tags is captured as `/:reasoning:N` (audit only, hidden from model).

### 2.5 Server Execution Order

The server parses all XML commands from the response, then processes in strict order:

1. **Store audit entries** — create `/:system:N`, `/:user:N`, `/:prompt:N` entries before the LLM call.
2. **Execute action commands** — `read` promotes (set turn), `drop` demotes (set turn to 0). `env`, `run`, `delete`, `edit`, `ask_user` generate result keys and store as `proposed`. `edit` also computes a unified diff patch via HeuristicMatcher.
3. **Process unknowns** — create `/:unknown:N` entries, deduplicated against existing unknowns.
4. **Process known entries** — UPSERT each `<known>` tag's key/value pair.
5. **Store summary** — create `/:summary:N` entry.
6. **Emit `run/state`** — build and send the client notification with history, proposed, unknowns, and telemetry.

---

## 3. Model Context

No message history. The model's entire context is rendered as markdown in the
system prompt. On the first turn, the user message carries the prompt. On
continuation turns, the user message is empty — the prompt is in the context
as a `/:prompt:N` entry.

### 3.1 System Message Contents

1. **Role description + tool commands** — from `prompt.ask.md` or `prompt.act.md`
2. **Context** — markdown rendered from the K/V store by ContextAssembler

### 3.2 Context Ordering

The context array is ordered to optimize the model's attention gradient.
Stable background at the top, actionable items at the bottom:

1. **Active non-file keys** — `/:known:*` at turn > 0 (working memory)
2. **Stored non-file keys** — `/:known:*` at turn 0 (discoverable, key only)
3. **Stored file paths** — files at turn 0 (project index, path only)
4. **Symbol files** — files with `file:symbols` state
5. **Full files** — files at turn > 0 (actual code being worked on)
6. **Chronological results** — tool command results and summaries in id order
7. **Unknowns** — previous turn's `unknown` entries (uncertainty boundary)
8. **User prompt** — `/:prompt:N` (the actual task, always last)

### 3.3 Expansion Rule

- `turn > 0` → expanded (value included in context)
- `turn == 0` → collapsed (key only, no value — purgatory)

`read(key)` promotes by setting turn to current turn. `drop(key)` demotes by
setting turn to 0. All files start at turn 0 unless promoted by the client,
the model, or the relevance engine.

### 3.4 File Bootstrap

At run start, the file scanner populates `known_entries` from disk. This is how
files enter the known store — the model never sees a separate file listing.

| Source | Domain | State | Value |
|--------|--------|-------|-------|
| Client-promoted `activate` | `file` | `active` | Full file contents |
| Client-promoted `readOnly` | `file` | `readonly` | Full file contents |
| Client-excluded `ignore` | `file` | `ignore` | Empty |
| Agent-read (from `read` tool) | `file` | `full` | Full file contents |
| Root file or heat-promoted | `file` | `symbols` | `name(params)` per line |
| Other indexed files | Not bootstrapped — discoverable via `read` if model knows the path |

### 3.5 File Change Detection

Each turn, the server scans the project's files and compares against
`known_entries.hash`:

1. Scan project for all files and their current hashes
2. Across all active runs, add/update/delete file entries to match disk state
3. Update the `turn` field on files that are: client-promoted (`active`),
   model-read (`full`), or newly modified (hash changed)

Files whose `turn` matches the current turn were recently engaged — this is
the heat signal for future context budgeting.

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
| **Session** | Client connection | Config (persona, system prompt, skills, temperature) |
| **Run** | Open-ended conversation | `known_entries`, `turns` |
| **Turn** | Single LLM request/response | Entries written with that turn number |

### 4.1 Project Scope

- `projects` — project path, name, git hash, last indexed timestamp

No separate file index tables. File metadata (path, hash, symbols) lives in
`known_entries` as file-domain entries. The project table is structural only.

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

#### File Visibility (Project-Scoped)

| Method | Params | Description |
|--------|--------|-------------|
| `activate` | `pattern` | Bootstrap file as `file:active` |
| `readOnly` | `pattern` | Bootstrap file as `file:readonly` |
| `ignore` | `pattern` | Bootstrap file as `file:ignore` |
| `drop` | `pattern` | Remove client constraint |
| `fileStatus` | `path` | Get file's current state |
| `getFiles` | — | Get project tree with states |

#### Run Execution

| Method | Params | Description |
|--------|--------|-------------|
| `ask` | `prompt`, `model?`, `run?`, `projectBufferFiles?`, `noContext?`, `fork?` | Non-mutating query |
| `act` | `prompt`, `model?`, `run?`, `projectBufferFiles?`, `noContext?`, `fork?` | Mutating directive |
| `run/resolve` | `run`, `resolution: {key, action: 'accept'\|'reject', output?}` | Resolve a proposed entry by its key |
| `run/abort` | `run` | Abandon run |
| `run/rename` | `run`, `name` | Rename a run. `[a-z_]{1,20}`, must be unique. |
| `run/inject` | `run`, `message` | Inject context (creates `/:inject/N` info entry) |
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
    {"key": "/:read/1", "tool": "read", "target": "src/auth.js", "status": "pass"},
    {"key": "/:summary/1", "tool": "summary", "status": "summary", "value": "Previous summary."},
    {"key": "/:edit/3", "tool": "edit", "target": "src/config.js", "status": "proposed"}
  ],
  "unknowns": [
    {"key": "/:unknown/1", "value": "Which session store is configured"}
  ],
  "proposed": [
    {"key": "/:edit/3", "type": "edit", "meta": {"file": "src/config.js", "patch": "---unified diff---"}}
  ],
  "telemetry": {
    "modelAlias": "kimi",
    "model": "moonshotai/kimi-k2.5",
    "temperature": 0.7,
    "context_size": 131072,
    "prompt_tokens": 3400,
    "completion_tokens": 280,
    "total_tokens": 3680,
    "cost": 0.0024
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
"third-party" at the registration level.

### 7.1 Plugin Contract

A plugin is a `.js` file that exports a default class with a static `register` method:

```js
export default class MyPlugin {
    static register(hooks) {
        // Register tools, RPC methods, turn processors, event listeners, filters
    }
}
```

Plugin directories (loaded in order):
1. `src/plugins/` — bundled core and community plugins
2. `~/.rummy/plugins/` — user-installed

Within each directory, the loader scans subdirectories for files named `index.js`
or matching the directory name (e.g., `tools/tools.js`). Test files are skipped.

### 7.2 Registries

#### Tool Registry (`hooks.tools`)

Register tools the model can invoke:

```js
hooks.tools.register("mytool", {
    modes: new Set(["ask", "act"]),
    category: "act",
});
```

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
        // ctx.setContext(projectId, sessionId, projectPath)
        // ctx.rpcRegistry (for discover)
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

**Methods**: `get(name)`, `has(name)`, `discover()`.

### 7.3 Turn Processors (`hooks.onTurn`)

Inject content into the turn context before the LLM sees it:

```js
hooks.onTurn(async (rummy) => {
    if (rummy.noContext) return;
    const node = rummy.tag("mycontent", { source: "myplugin" }, ["data"]);
    rummy.contextEl.children.push(node);
}, 10);  // priority: lower = runs first
```

#### RummyContext API (`rummy`)

| Property | Type | Description |
|---|---|---|
| `db` | SqlRite | Database with all prepared queries |
| `project` | Object | `{ id, path, name }` |
| `type` | String | `"ask"` or `"act"` |
| `sessionId` | String | Current session ID |
| `runId` | String | Current run ID |
| `turnId` | Number | Current turn ID |
| `sequence` | Number | Turn sequence number |
| `noContext` | Boolean | True in Lite mode |
| `contextSize` | Number | Token budget |
| `system` | Object | System node `{ tag, attrs, content, children }` |
| `contextEl` | Object | Context node |
| `user` | Object | User node |
| `assistant` | Object | Assistant node |
| `tag(name, attrs?, children?)` | Function | Create a node |

### 7.4 Events

Fire-and-forget notifications. All handlers run; return values ignored.

```js
hooks.project.init.completed.on(async (payload) => {
    console.log(`Project initialized: ${payload.projectPath}`);
}, 5);
```

| Hook | Payload | When |
|---|---|---|
| `project.init.started` | `{ projectPath, projectName, clientId }` | Before project setup |
| `project.init.completed` | `{ projectId, sessionId, projectPath, db }` | After project setup |
| `project.files.update.started` | `{ projectId, pattern, constraint }` | Before file state change |
| `project.files.update.completed` | `{ projectId, projectPath, pattern, constraint, db }` | After file state change |
| `run.started` | `{ run, sessionId, type }` | Run created |
| `run.progress` | `{ sessionId, run, turn, status }` | Turn progress (thinking/processing/retrying) |
| `run.state` | `{ sessionId, run, turn, status, summary, history, unknowns, proposed, telemetry }` | Turn state update |
| `ask.started` / `ask.completed` | `{ sessionId, model, prompt, ... }` | Ask lifecycle |
| `act.started` / `act.completed` | `{ sessionId, model, prompt, ... }` | Act lifecycle |
| `ui.render` | `{ sessionId, text, append }` | Streaming output |
| `ui.notify` | `{ sessionId, text, level }` | Notification |
| `run.turn.audit` | `{ ... }` | Debug audit data |
| `llm.request.started` | `{ ... }` | LLM call started |
| `llm.request.completed` | `{ ... }` | LLM call finished |
| `rpc.started` | `{ method, params, id, sessionId }` | RPC call received |
| `rpc.completed` | `{ method, id, result }` | RPC call succeeded |
| `rpc.error` | `{ id, error }` | RPC call failed |

### 7.5 Filters

Transform data through a chain. Each handler returns the (possibly modified) value.

```js
hooks.llm.messages.addFilter(async (messages, context) => {
    return [{ role: "system", content: "Extra" }, ...messages];
}, 5);
```

| Hook | Value | Context | Purpose |
|---|---|---|---|
| `run.config` | Config object | `{ sessionId }` | Modify run configuration |
| `llm.messages` | Message array | `{ model, sessionId, runId }` | Transform LLM input |
| `llm.response` | Response object | `{ model, sessionId, runId }` | Transform LLM output |
| `socket.message.raw` | Raw buffer | — | Transform incoming WebSocket data |
| `rpc.request` | Parsed request | — | Transform RPC request |
| `rpc.response.result` | Result object | `{ method, id }` | Transform RPC response |
| `agent.warn` | Warning rules array | `{ flags, tools, ... }` | Modify warning rules |
| `agent.action` | Action table array | `{ flags, tools, warnings, ... }` | Modify state table |

#### Agent State Table Hooks

Plugins can modify the warning rules and action table that control the Rumsfeld Loop:

```js
hooks.agent.warn.addFilter(async (rules, context) => {
    rules.push({
        when: context.tools.length > 10,
        msg: "Too many tools in one turn.",
    });
    return rules;
});

hooks.agent.action.addFilter(async (table, context) => {
    table.splice(-1, 0, {
        when: context.someCondition,
        action: "continue",
    });
    return table;
});
```

### 7.6 Examples

#### Custom Tool Plugin

```js
export default class WeatherPlugin {
    static register(hooks) {
        hooks.tools.register("weather", {
            modes: new Set(["ask", "act"]),
            category: "act",
        });
    }
}
```

The model can now call the `weather` tool. The server creates a `/:weather/N`
known entry as `proposed`, and the client resolves it.

#### Custom RPC Method Plugin

```js
export default class StatsPlugin {
    static register(hooks) {
        hooks.rpc.registry.register("getStats", {
            handler: async (params, ctx) => {
                const runs = await ctx.db.get_run_by_id.all({});
                return { totalRuns: runs.length };
            },
            description: "Get project statistics",
            requiresInit: true,
        });
    }
}
```

#### Context Injection Plugin

```js
export default class TimestampPlugin {
    static register(hooks) {
        hooks.onTurn(async (rummy) => {
            const node = rummy.tag("timestamp", {}, [new Date().toISOString()]);
            rummy.contextEl.children.push(node);
        }, 99);
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

### 9.1 Configuration

```env
RUMMY_MAP_MAX_PERCENT=10        # Percent of model context window for known entries
RUMMY_MAP_TOKEN_BUDGET=4000     # Hard cap in tokens
RUMMY_DECAY_THRESHOLD=12        # Turns before attention decay
RUMMY_RETENTION_DAYS=31         # Days to keep completed runs
RUMMY_FETCH_TIMEOUT=30000       # LLM fetch timeout (ms)
RUMMY_RPC_TIMEOUT=10000         # Non-long-running RPC timeout (ms)
```

---

## 10. Dependencies

| Dependency | Purpose |
|---|---|
| `@possumtech/sqlrite` | SQLite (author's own anti-ORM) |
| `ws` | WebSocket server |
| `htmlparser2` | XML parsing for model response tool commands |
| `tiktoken` | Token counting (o200k_base encoding, with `length/4` fallback) |

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
| **State** | The entry's status within its domain. Server-internal; the model sees a projection. |
| **Result Key** | A `/:[tool]:N` key generated for each tool command. Sequential per run. |
| **Rumsfeld Loop** | The turn cycle: the model uses `<known>` to persist knowledge, `<unknown>` to declare uncertainty, and `<summary>` to report status. Forces discovery before modification. |
