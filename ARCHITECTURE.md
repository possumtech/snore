# RUMMY: Architecture Specification

This document is the authoritative reference for Rummy's design. The system prompt
files (`system.ask.md`, `system.act.md`) define model-facing behavior. This document
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
    , meta JSON
    , relevance INTEGER NOT NULL DEFAULT 0
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
- `meta` — JSON metadata. Files store symbols here. Tool results store the original command/args. Edits store file, search, replace.
- `relevance` — integer, default 0. Reserved for future heat engine / context budgeting.

### 1.2 Domains & States

**File domain** — project files bootstrapped at run start:

| State | Meaning | Model sees |
|-------|---------|------------|
| `full` | Full content, editable | `file` |
| `readonly` | Full content, not editable | `file:readonly` |
| `active` | Client-promoted (editor focus) | `file:active` |
| `ignore` | Excluded from context | *(hidden)* |
| `symbols` | Signature summaries only | `file:symbols` |

**Known domain** — model-emitted knowledge (`/:known/*` keys) and internal state:

| State | Meaning | Model sees |
|-------|---------|------------|
| `full` | Value loaded | `full` |
| `stored` | Key exists, value not in context | `stored` |

The special key `/:unknown` uses domain `known`, state `full`. It stores the
previous turn's unknown list as a JSON array. Not a `/:known/*` key — it's an
internal mechanism for persisting unknowns between turns.

**Result domain** — tool call results, summaries, and notifications (`/:[tool]/*` keys):

| State | Meaning | Model sees |
|-------|---------|------------|
| `proposed` | Awaiting user approval | *(hidden until resolved)* |
| `pass` | Succeeded/accepted | `stored` |
| `info` | Informational notification | `stored` |
| `warn` | Rejected/partial | `stored` |
| `error` | Failed | `stored` |
| `summary` | Summary text | `stored` |

The model sees a simplified projection. The server maps `{domain, state}` to a
model-facing state string at query time. `file:ignore` and `proposed` entries
are hidden from the model entirely. All resolved result entries appear as `stored`
— the model can `read` them to recall the full value.

### 1.3 Key Namespaces

Keys use the `/:` sentinel to distinguish system keys from file paths. No
relative file path starts with `/:`, so the prefix is unambiguous. Regex: `/^\/:/`.

| Prefix | Namespace | Examples |
|--------|-----------|---------|
| *(none)* | File paths | `src/app.js`, `package.json` |
| `/:known/` | Knowledge entries | `/:known/auth_flow`, `/:known/db_adapter` |
| `/:[tool]/` | Tool result keys | `/:read/4`, `/:edit/7`, `/:run/12`, `/:summary/3` |

Result keys use the tool name as prefix and a sequential integer per run.
Tracked by `runs.next_result_seq`. Self-documenting: `/:read/4` tells you
it was the 4th result key generated, produced by the `read` tool.

Knowledge key constraint: `^/:known/[a-z0-9_]+$`. Short lowercase slugs.
Prefer descriptive names over abbreviations — `/:known/oauth2_token_rotation`
over `/:known/auth_rot`.

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

- **Accept** → state changes from `proposed` to `pass`. Value updated with output.
- **Reject** → state changes from `proposed` to `warn`. Value updated with rejection reason.
- **Error** → state changes from `proposed` to `error`. Value updated with error details.

The model sees the resolved entry as `stored` next turn. It can `read` the key
to see the full resolution output.

After all proposed entries are resolved:
- Any `warn` (rejection) → server returns `{ status: "resolved" }`, client decides next step.
- All `pass` → server auto-resumes the run (model needs a continuation turn).
- No actionable results → run completes.

---

## 2. Native Tool Calling

The model communicates exclusively through tool calls. No structured JSON in the
content body. No message history. Content is suppressed.

### 2.1 Tools

**Shared (ask + act):**

| Tool | Params | Required |
|------|--------|----------|
| `known` | `entries: [{key, value}]` | Yes |
| `summary` | `text: string` (1-80 chars) | Yes |
| `unknown` | `items: string[]` | No |
| `read` | `key: string, reason: string` | No |
| `drop` | `key: string, reason: string` | No |
| `env` | `command: string, reason: string` | No |
| `prompt` | `question: string, options: string[]` | No |

**Act-only (extends shared):**

| Tool | Params |
|------|--------|
| `run` | `command: string, reason: string` |
| `delete` | `key: string, reason: string` |
| `edit` | `file: string, search: string\|null, replace: string` |

Tool definitions live in `src/domain/schema/tools/*.json` (one file per tool),
composed by `src/domain/schema/ToolSchema.js`. Server-side validation via AJV
enforces constraints (`minLength`, `maxLength`, `minItems`) that OpenAI strict
mode cannot express. All tools use `strict: true` for constrained decoding on
supporting providers; unsupported keywords are stripped at API send time.

### 2.2 How Tools Become Known Entries

There are no separate "tool result" objects. Every tool call writes to the known
store. The model sees results as entries in the known array next turn.

**`known`** — each `{key, value}` entry is UPSERTed into the store with domain
`known`, state `full`.

**`summary`** — creates a `/:summary/N` entry with domain `result`, state `summary`,
and the text as value.

**`unknown`** — stores the items array as `/:unknown` (domain `known`, state `full`).
If not called, `/:unknown` is deleted.

**`read`** — for file keys: reads file from disk, updates the known entry value with
file contents, sets state to `full`. For `/:known/*` or `/:[tool]/*` keys: promotes
state to `full` (value already stored, just making it visible). Creates a
`/:read/N` result entry for the log.

**`drop`** — for file keys: demotes to `symbols` (if symbols available) or removes
the entry. For system keys: sets state to `stored` (clears value from context but
key remains discoverable). No result key generated (not a logged action).

**`env`** — creates a `/:env/N` entry with domain `result`, state `pass`, and
command output as value. The `meta` field stores the original command.

**`edit`** — creates a `/:edit/N` entry with domain `result`, state `proposed`.
The `meta` field stores `{file, search, replace}`. Blocks the turn loop until
the client resolves it.

**`run`** — creates a `/:run/N` entry with domain `result`, state `proposed`.
Blocks until resolved. On resolution, value is updated with command output.

**`delete`** — creates a `/:delete/N` entry with domain `result`, state `proposed`.
Blocks until resolved.

**`prompt`** — creates a `/:prompt/N` entry with domain `result`, state `proposed`.
Blocks until user responds. On resolution, value is the selected answer.

### 2.3 Namespace Routing

`read`, `drop`, and `delete` accept a `key` parameter and route by prefix:

| Tool | File path key | `/:known/*` key | `/:[tool]/*` key |
|------|---------------|-----------------|------------------|
| `read` | Read from disk, set to `file:full` | Set to `known:full` | Set to `result:pass` (recall) |
| `drop` | Demote to `file:symbols` if available, else remove | Set to `known:stored` | Set to `result:stored` |
| `delete` | Delete from disk, remove entry | Remove entry | Remove entry |

### 2.4 Enforcement Layers

1. **Tool definitions** — `strict: true` constrained decoding on tool argument schemas.
2. **Content suppression** — `tool_choice: "required"` + empty-object `response_format` shim. If the model produces content, it's forced to `{}`.
3. **Prompt instructions + examples** — system prompt describes tool purposes and constraints.
4. **Server-side validation** — confirms `known` and `summary` are present. Rejects and retries.

### 2.5 Server Execution Order

The model emits all tool calls as a parallel batch. The server processes in strict order:

1. **Execute action tools** — `read`, `drop`, `env`, `run`, `delete`, `edit`, `prompt`. Generate result keys (`/:read/1`, `/:edit/2`). Write entries to known store. Non-proposed tools (read, drop, env) resolve immediately. Proposed tools (edit, run, delete, prompt) block the loop.
2. **Process unknown** — store as `/:unknown` entry for next turn. Delete `/:unknown` if model didn't call `unknown`.
3. **UPSERT model's known entries** — process each `{key, value}` from the `known` tool call.
4. **Store summary** — create `/:summary/N` entry.
5. **Done** — results are now in the known store. Next turn's context assembly reads from it.

---

## 3. Model Context

No message history. The model's entire context is assembled each turn from the
known store and system prompt. Two messages: `system` + `user`.

### 3.1 System Message Contents

1. **Role description** — from `system.ask.md` or `system.act.md`
2. **Summary log** — all result-domain entries ordered by `id`, formatted as `[{tool, target, status, key, value}]`. Summary entries have full text; others have empty value (recallable). The `tool` field is derived from key prefix. The `target` field is derived from `meta` (command, file, key, or question).
3. **Unknown list** — previous turn's `/:unknown` value, if present
4. **Known entries** — `[{key, state, value}]` with model-facing state projection. Includes file keys, `/:known/*` entries, and `/:[tool]/*` result keys. `file:ignore` and `proposed` entries are hidden.

### 3.2 User Message

The current user input (prompt).

### 3.3 File Bootstrap

At run start, the server populates `known_entries` from the repo map. This is how
files enter the known store — the model never sees a separate file listing.

| Source | Domain | State | Value |
|--------|--------|-------|-------|
| Client-promoted `activate` | `file` | `active` | Full file contents |
| Client-promoted `readOnly` | `file` | `readonly` | Full file contents |
| Client-excluded `ignore` | `file` | `ignore` | Empty |
| Agent-read (from `read` tool) | `file` | `full` | Full file contents |
| Root file or heat-promoted | `file` | `symbols` | `name(params)` per line |
| Other indexed files | Not bootstrapped — discoverable via `read` if model knows the path |

The repo map tables (`repo_map_files`, `repo_map_tags`) serve as indexing
infrastructure for the bootstrap. They are read-only from the known store's
perspective.

### 3.4 Heat-Based Promotion

Files at `symbols` state are selected based on **heat** — cross-references
derived from `known_entries.meta` (symbol data stored on file entries). The
`relevance` field on `known_entries` stores the computed heat score. The
`turn` field tracks the most recent turn that engaged with each file.

Heat computation and context budgeting are future work. The `relevance` field
is inert (default 0) until the heat engine is implemented.

---

## 4. State Scopes

| Scope | Lifetime | Contains |
|-------|----------|----------|
| **Project** | Until deleted or re-indexed | File index, symbols |
| **Run** | Open-ended conversation | `known_entries`, `turns` |
| **Turn** | Single LLM request/response | Entries written with that turn number |

### 4.1 Project Scope

- `repo_map_files` — file metadata (path, hash, size, symbol_tokens)
- `repo_map_tags` — symbol definitions extracted by ctags

These are indexing infrastructure. The model never sees them directly — they
feed the bootstrap that populates the known store.

### 4.2 Run Scope

- `known_entries` — the unified state machine. All keyed state.
- `turns` — usage stats (prompt_tokens, completion_tokens, cost). Operational, not model-facing.
- `runs.next_result_seq` — sequential counter for result key generation
- `runs.next_turn` — sequential counter for turn numbers

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
| `run/resolve` | `run`, `resolution: {key, action, output?, answer?}` | Resolve a proposed entry by its key |
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
| `run/step/completed` | `run`, `turn`, `files`, `cumulative` | Turn finished. `cumulative` has `{ prompt_tokens, completion_tokens, total_tokens, cost }`. |
| `run/progress` | `run`, `turn`, `status` | Turn progress: `thinking`, `processing` |
| `editor/diff` | `run`, `key`, `type`, `file`, `search`, `replace` | Proposed edit (raw tool args) |
| `run/command` | `run`, `key`, `type`, `command` | Proposed command |
| `ui/prompt` | `run`, `key`, `question`, `options` | Model question |
| `ui/render` | `text`, `append` | Streaming output |
| `ui/notify` | `text`, `level` | Notification |

Notifications reference entries by `key` (e.g., `/:edit/3`), not by finding ID.

### 5.3 Run Lifecycle

```
ask / act  →  turns  →  tool calls  →  known entries
                                            │
                              run/resolve ──┘ (per entry key: accept/reject)
                                            │
         ◄─────────────────────────────────┘ (auto-resume if all accepted)
```

Findings gate: the application checks for proposed entries (§1.5) before each
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

| Concern | OpenAI | OpenRouter | Ollama |
|---------|--------|------------|--------|
| `strict: true` | Yes | Provider-dependent | No |
| `tool_choice: "required"` | Yes | Provider-dependent | Not enforced |
| `response_format` shim | Yes | Provider-dependent | No |
| Parallel tool calls | Yes | Provider-dependent | Model-dependent |

Ollama: all constraints are server-side. Arguments returned as parsed objects
(not JSON strings) — the server normalizes both formats.

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
1. `src/application/plugins/` — internal core
2. `src/plugins/` — bundled
3. `~/.rummy/plugins/` — user-installed

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
| `run.progress` | `{ sessionId, run, turn, status }` | Turn progress |
| `run.command` | `{ sessionId, run, key, type, command }` | Command proposed |
| `run.step.completed` | `{ run, sessionId, turn, projectFiles, cumulative }` | Turn finished |
| `ask.started` / `ask.completed` | `{ sessionId, model, prompt, ... }` | Ask lifecycle |
| `act.started` / `act.completed` | `{ sessionId, model, prompt, ... }` | Act lifecycle |
| `ui.render` | `{ sessionId, text, append }` | Streaming output |
| `ui.notify` | `{ sessionId, text, level }` | Notification |
| `ui.prompt` | `{ sessionId, run, key, question, options }` | Model question |
| `editor.diff` | `{ sessionId, run, key, type, file, ... }` | Proposed edit |
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
| `ajv` | JSON Schema validation (server-side enforcement layer) |

Symbol extraction uses `ctags` (universal-ctags CLI). Token counting: `content.length / 4`.
Git operations shell out to `git` CLI.

---

## 11. Terminology

| Term | Definition |
|------|------------|
| **Project** | A codebase. Owns file index, symbols, references. |
| **Session** | A client connection. Owns config (persona, system prompt, skills). |
| **Run** | An open-ended conversation. Owns `known_entries` and turns. |
| **Turn** | A single LLM request/response cycle. |
| **Known Entry** | A keyed entry in the unified state machine. |
| **Domain** | The entry's namespace: `file`, `known`, or `result`. |
| **State** | The entry's status within its domain. Server-internal; the model sees a projection. |
| **Result Key** | A `/:[tool]/N` key generated for each tool call. Sequential per run. |
| **Rumsfeld Loop** | The turn cycle: the model must declare `known`, `unknown`, and `summary` every turn. |
