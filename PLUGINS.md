# PLUGINS.md — Plugin Development Guide

Every `<tag>` the model sees is a plugin. Every scheme is registered by
its owner. Every operation — model, client, plugin — flows through the
same tool handler. No exceptions without documentation in EXCEPTIONS.md.

## §0 Quickstart

A complete tool plugin in four parts: register, handle, render, document.

```js
// src/plugins/ping/ping.js
import docs from "./pingDoc.js";

export default class Ping {
    #core;

    constructor(core) {
        this.#core = core;
        core.ensureTool();
        core.registerScheme({ category: "logging" });
        core.on("handler", this.handler.bind(this));
        core.on("full", this.full.bind(this));
        core.filter("instructions.toolDocs", async (docsMap) => {
            docsMap.ping = docs;
            return docsMap;
        });
    }

    async handler(entry, rummy) {
        const now = new Date().toISOString();
        await rummy.set({
            path: entry.resultPath,
            body: `pong ${now}`,
            status: 200,
            attributes: { path: entry.path },
        });
    }

    full(entry) {
        return entry.body;
    }
}
```

```js
// src/plugins/ping/pingDoc.js
const LINES = [
    ["## ping",
        "Header — model sees this as the tool name"],
    ["<ping/>",
        "Simplest invocation — no path, no body"],
    ["* Returns server timestamp",
        "One-line description of what the tool does"],
];
export default LINES.map(([text]) => text).join("\n");
```

Install external plugins via npm + env var:

```env
RUMMY_PLUGIN_PING=@myorg/rummy.ping
```

## §1 Plugin Contract

A plugin is a directory under `src/plugins/` containing a `.js` file
that exports a default class. The class name matches the file name.
The constructor receives `core` (a PluginContext) — the plugin's
complete interface with the system.

```js
export default class MyTool {
    #core;

    constructor(core) {
        this.#core = core;
        core.ensureTool();
        core.registerScheme({ category: "logging" });
        core.on("handler", this.handler.bind(this));
        core.on("full", this.full.bind(this));
        core.on("summary", this.summary.bind(this));
        core.filter("instructions.toolDocs", async (docsMap) => {
            docsMap.mytool = docs;
            return docsMap;
        });
    }

    async handler(entry, rummy) {
        // What the tool does (rummy is per-turn RummyContext)
    }

    full(entry) {
        return entry.body;
    }

    summary(entry) {
        return entry.body;
    }
}
```

File naming: `src/plugins/mytool/mytool.js`. Class name = file name.
Tool docs: `src/plugins/mytool/mytoolDoc.js` (annotated line arrays).

External plugins install via npm and load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
RUMMY_PLUGIN_REPO=@possumtech/rummy.repo
```

## §2 Unified API

The model, the client, and plugins all use the same interface. Each
tier is a superset of the one below. `name` (model) = `method` (client)
= method name (plugin). The params shape is the same at every tier.

```
Model:  <rm path="file.txt"/>           → { name: "rm", path: "file.txt" }
Client: { method: "rm", params: { path: "file.txt" } }
Plugin: rummy.rm({ path: "file.txt" })
```

All three tiers go through the same tool handler. Budget enforcement
applies equally. A client `get` is subject to the same budget check
as a model `<get>`.

## §3 Registration

All registration happens in the constructor via `core.on()`,
`core.filter()`, `core.ensureTool()`, and `core.registerScheme()`.

### §3.1 core.ensureTool()

Declares this plugin as a model-facing tool. Required for the tool
to appear in the model's tool list. Called automatically by
`core.on("handler", ...)` but must be called explicitly for tools
without handlers (e.g., `summarize`, `update`, `unknown`).

### §3.2 core.registerScheme(config?)

Registers this plugin's scheme in the database. Called once in the
constructor.

```js
core.registerScheme({
    modelVisible: 1,     // 1 or 0 — appears in v_model_context
    category: "logging",  // "data", "logging", "unknown", "prompt"
});
```

All fields optional. `core.registerScheme()` with no args gives a
sensible result-type scheme.

### §3.3 core.on(event, callback, priority?)

| Event | Payload | Purpose |
|-------|---------|---------|
| `"handler"` | `(entry, rummy)` | Tool handler — called when model/client invokes this tool |
| `"full"` | `(entry)` | Full fidelity projection — what the model sees at full |
| `"summary"` | `(entry)` | Summary fidelity projection — what the model sees at summary |
| `"turn.started"` | `(ctx)` | Turn beginning — write prompt/progress/instructions entries |
| `"turn.response"` | `(result, rummy)` | LLM responded — write audit entries, commit usage |
| `"turn.proposing"` | `(rummy)` | All dispatches done — materialize file edit proposals |
| `"entry.created"` | `({ runId, path, scheme })` | Entry created during dispatch |
| `"entry.changed"` | `({ runId, path, changeType })` | Entry content, fidelity, or status modified |
| Any `"dotted.name"` | varies | Resolves to the matching hook in the hook tree |

```js
// One-liner examples
core.on("handler", async (entry, rummy) => { /* tool logic */ });
core.on("full", (entry) => entry.body);
core.on("summary", (entry) => entry.body?.slice(0, 200));
core.on("turn.started", async (ctx) => { /* write entries */ });
core.on("turn.response", async (result, rummy) => { /* audit */ });
core.on("entry.changed", ({ runId, path, changeType }) => { /* react */ });
```

### §3.4 core.filter(name, callback, priority?)

| Filter | Signature | Purpose |
|--------|-----------|---------|
| `"instructions.toolDocs"` | `(docsMap) → docsMap` | Add tool documentation (docsMap pattern) |
| `"assembly.system"` | `(content, ctx) → content` | Contribute to system message |
| `"assembly.user"` | `(content, ctx) → content` | Contribute to user message |
| `"llm.messages"` | `(messages) → messages` | Transform final messages before LLM call |
| `"llm.response"` | `(response) → response` | Transform LLM response |
| Any `"dotted.name"` | varies | Resolves to the matching filter in the hook tree |

```js
// One-liner examples
core.filter("assembly.system", async (content, ctx) => {
    return `${content}\n<mytag>${myData}</mytag>`;
}, 400);
core.filter("assembly.user", async (content, ctx) => {
    return `${content}\n<status>${myStatus}</status>`;
}, 150);
core.filter("instructions.toolDocs", async (docsMap) => {
    docsMap.mytool = docs;
    return docsMap;
});
```

The `ctx` object passed to assembly filters:

```js
ctx = {
    rows,              // turn_context rows (materialized entries)
    loopStartTurn,     // First turn of current loop
    type,              // "ask" or "act"
    tools,             // Set of active tool names
    contextSize,       // Model context window size
    lastContextTokens, // Assembled tokens from previous turn
}
```

### §3.5 Tool Docs

Each tool plugin has a `*Doc.js` file with annotated line arrays.
Text goes to the model. Rationale stays in source. Registered via
the `instructions.toolDocs` filter using the docsMap pattern:

```js
import docs from "./mytoolDoc.js";

core.filter("instructions.toolDocs", async (docsMap) => {
    docsMap.mytool = docs;
    return docsMap;
});
```

The instructions plugin filters by the active tool set — tools
excluded by mode or flags are automatically omitted from the docs.

### §3.6 handler(entry, rummy)

The handler receives the parsed command entry and a per-turn
RummyContext:

```js
entry = {
    scheme,       // Tool name ("set", "get", "rm", etc.)
    path,         // Entry path ("set://src/app.js")
    body,         // Tag body text
    attributes,   // Parsed tag attributes
    resultPath,   // Where to write the result
}
```

Multiple handlers per scheme. Lower priority runs first. Return
`false` to stop the chain.

### §3.7 full(entry) / summary(entry)

Returns the string the model sees for this tool's entries at the
given fidelity. Every tool MUST register `full`. `summary` is
optional — if unregistered, falls back to `attributes.summary`
(model-authored keyword description) or empty string.

At summary fidelity, `attributes.summary` is prepended above the
plugin's summary output automatically by ToolRegistry.view().

## §4 Two Objects

Plugins interact with two objects at different scopes:

**PluginContext** (`core`) — startup-scoped. Created once per plugin.
Used for registration (`on()`, `filter()`, `registerScheme()`,
`ensureTool()`). Available as `this.#core` throughout the plugin's
lifetime.

**RummyContext** (`rummy`) — turn-scoped. Passed to handlers per
invocation. Has tool verbs, per-turn state, database access.

### §4.1 Tool Verbs (on RummyContext)

| Method | Effect |
|--------|--------|
| `rummy.set({ path, body, status, fidelity, attributes })` | Create/update entry |
| `rummy.get({ path })` | Promote to full fidelity |
| `rummy.rm({ path })` | Delete permanently |
| `rummy.mv({ path, to })` | Move entry |
| `rummy.cp({ path, to })` | Copy entry |

### §4.2 Query Methods

| Method | Returns |
|--------|---------|
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | Status code or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` |
| `rummy.getEntries(pattern, body?)` | Array of matching entries |

### §4.3 Properties

| Property | Type | Scope |
|----------|------|-------|
| `rummy.entries` | KnownStore instance | Both |
| `rummy.db` | Database | Both |
| `rummy.runId` | Current run ID | RummyContext |
| `rummy.projectId` | Current project ID | Both |
| `rummy.sequence` | Current turn number | RummyContext |
| `rummy.contextSize` | Model context window | RummyContext |
| `rummy.noRepo` | Skip filesystem scanning | RummyContext |

## §5 Tool Display Order

Tools are presented to the model in priority order:
gather → reason → act → communicate.

Defined in `ToolRegistry.TOOL_ORDER`. The `resolveForLoop(mode, flags)`
method handles all exclusions through one mechanism:

| Flag | Excludes |
|------|----------|
| `mode === "ask"` | `sh` |
| `noInteraction` | `ask_user` |
| `noWeb` | `search` |

## §6 Hedberg

The hedberg plugin exposes pattern matching and interpretation
utilities on `core.hooks.hedberg` for all plugins to use:

```js
const { match, search, replace, parseSed, parseEdits,
    normalizeAttrs, generatePatch } = core.hooks.hedberg;
```

| Method | Purpose |
|--------|---------|
| `match(pattern, string)` | Full-string pattern match (glob, regex, literal) |
| `search(pattern, string)` | Substring search |
| `replace(body, search, replacement, opts?)` | Apply replacement |
| `parseSed(input)` | Parse sed syntax (any delimiter) |
| `parseEdits(content)` | Detect edit format (merge conflict, udiff, sed) |
| `normalizeAttrs(attrs)` | Heal model attribute names |
| `generatePatch(path, old, new)` | Generate unified diff |

## §7 Events & Filters

**Events** are fire-and-forget. All handlers run. Return values ignored.
**Filters** transform data through a chain. Lower priority runs first.
All hooks are async.

### §7.1 Project Lifecycle

| Hook | Type | When |
|------|------|------|
| `project.init.started` | event | Before project DB upsert |
| `project.init.completed` | event | After project created |

### §7.2 Run & Loop Lifecycle

| Hook | Type | When |
|------|------|------|
| `run.created` | event | Run just created in DB |
| `ask.started` | event | Run requested in ask mode |
| `act.started` | event | Run requested in act mode |
| `loop.started` | event | Loop execution beginning |
| `run.config` | filter | Before run config applied |
| `run.progress` | event | Status change (thinking, processing) |
| `run.state` | event | After each turn — full state snapshot |
| `run.step.completed` | event | Turn resolved, no proposals pending |
| `loop.completed` | event | Loop execution finished (any exit path) |
| `ask.completed` | event | Ask run finished |
| `act.completed` | event | Act run finished |

### §7.3 Turn Pipeline

Hooks fire in this order every turn:

| # | Hook | Type | When |
|---|------|------|------|
| 1 | `turn.started` | event | Plugins write prompt/progress/instructions entries |
| 2 | `context.materialized` | event | turn_context populated from v_model_context |
| 3 | `assembly.system` | filter | Build system message from entries |
| 4 | `assembly.user` | filter | Build user message from entries |
| 5 | `budget.enforce` | hook | Measure assembled tokens, 413 if over |
| 6 | `llm.messages` | filter | Transform messages before LLM call |
| 7 | `llm.request.started` | event | LLM call about to fire |
| 8 | `llm.response` | filter | Transform raw LLM response |
| 9 | `llm.request.completed` | event | LLM call finished |
| 10 | `turn.response` | event | Plugins write audit entries |
| 11 | `entry.recording` | filter | Before each entry is stored (validate/transform) |
| 12 | `tool.before` | event | Before tool handler dispatch |
| 13 | Tool handler dispatch | — | Lifecycle always, actions sequential |
| 14 | `tool.after` | event | After tool handler dispatch |
| 15 | `entry.created` | event | After each new entry dispatched |
| 16 | `entry.changed` | event | After entry content, fidelity, or status modified |
| 17 | `turn.proposing` | event | All dispatches done — materialize proposals |
| 18 | `turn.completed` | event | Turn fully resolved with final status |

### §7.4 Entry Events

| Hook | Type | When |
|------|------|------|
| `entry.recording` | filter | Before entry stored. Return `{ status: 4xx }` to reject. |
| `entry.created` | event | New entry added during dispatch |
| `entry.changed` | event | Entry content, fidelity, or status modified |

`entry.recording` is a filter — plugins can validate, transform, or
reject entries before they hit the store. Payload:
`{ scheme, path, body, attributes, status }`. Return the object
(modified or not). Set `status >= 400` to reject.

`entry.changed` fires on any mutation to an existing entry — body
update, fidelity change, status change, attribute update. Payload:
`{ runId, path, changeType }`. Subscribers include the budget plugin
(remeasure context) and the repo plugin (detect file changes on disk).

### §7.5 Budget

| Hook | Type | When |
|------|------|------|
| `budget.enforce` | hook | After assembly, before LLM call. Returns 413 if over context limit. |

The budget plugin measures `countTokens()` on assembled messages —
the actual content being sent to the LLM. No estimates, no DB token
math. The assembled message IS the measurement.

**DB tokens vs assembled tokens:** The `tokens` column on entries is
strictly for DISPLAY — showing token counts in `<knowns>` tags so
the model can reason about entry sizes. It is NEVER used for budget
decisions. Budget math uses only assembled message token counts.
These are two separate numbers that must never be conflated.

### §7.6 Client Notifications

| Hook | Type | When |
|------|------|------|
| `ui.render` | event | Text for client display |
| `ui.notify` | event | Status notification |

## §8 Entry Lifecycle

Every entry follows the same lifecycle regardless of origin:

1. **Created** — `known_entries` row with scheme, path, body, status
2. **Dispatched** — tool handler chain executes
3. **Status set** — handler sets 200, 202, 400, 413, etc.
4. **Materialized** — `v_model_context` projects into `turn_context`
5. **Assembled** — filter chain renders into system/user messages
6. **Visible** — model sees the entry in its context

Entries at `archive` fidelity skip steps 4-6 (invisible to model).
Entries at `index` fidelity render as path-only tags (no body).
Entries at `summary` fidelity render with `attributes.summary`
prepended above the plugin's summary view output.

### §8.1 Streaming Entries

Producers whose output arrives over time (shell commands, web fetches,
log tails, file watches) use the **streaming entry pattern**. The
lifecycle extends beyond 202→200:

```
202 Proposal (user decision pending)
  → accept → 200 (log entry: action happened)
           + 102 data entries (one per channel, growing)
                  → 200/500 on completion
```

**Producer plugin contract:**

1. On dispatch, create a **proposal entry** at `{scheme}://turn_N/{slug}`
   at status=202, category=logging. Body empty; `summary=command` attr.
2. On user accept, `AgentLoop.resolve()` transitions the proposal entry
   to status=200 (it becomes the **log entry**) and creates **data
   entries** at `{path}_1`, `{path}_2`, etc. at status=102,
   category=data, fidelity=demoted, empty body.
3. Producer/client calls `stream { run, path, channel, chunk }` RPC to
   append chunks to the appropriate channel.
4. When the producer is done, `stream/completed { run, path, exit_code? }`
   transitions all `{path}_*` data entries to terminal status (200 on
   exit_code=0 or omitted; 500 otherwise) and rewrites the log entry
   body with final stats. For client-initiated cancellation, the
   client calls `stream/aborted { run, path, reason? }` instead —
   transitions channels to 499 (Client Closed Request).

**Channel numbering:** Unix file descriptor convention — `_1` is the
primary stream (stdout for shell, body for fetch, lines for tail);
`_2` is alternate/error (stderr, redirects, anomalies); `_3`+ for
additional producer-specific streams.

**The `stream` plugin** owns the RPC infrastructure. Producer plugins
only need to:
- Create the proposal entry on dispatch (status=202)
- Rely on `AgentLoop.resolve()` to create data channels on accept
- Let clients/external producers call `stream`, `stream/completed`,
  and `stream/aborted`

No scheme registration or tooldoc for the stream plugin itself — it's
pure RPC plumbing shared across all streaming producers.

## §9 Bundled Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `get` | Core tool | Load file/entry into context |
| `set` | Core tool | Edit file/entry, fidelity control |
| `known` | Core tool + Assembly | Save knowledge, render `<knowns>` section |
| `rm` | Core tool | Delete permanently |
| `mv` | Core tool | Move entry |
| `cp` | Core tool | Copy entry |
| `sh` | Core tool | Shell command (act mode only). Streaming producer — see §8.1 |
| `env` | Core tool | Exploratory command. Streaming producer — see §8.1 |
| `stream` | Internal | Generic streaming-entry RPC (`stream`, `stream/completed`, `stream/aborted`) for sh/env and future producers |
| `ask_user` | Core tool | Ask the user |
| `search` | Core tool | Web search (via external plugin) |
| `summarize` | Structural | Signal completion |
| `update` | Structural | Signal continued work |
| `unknown` | Structural + Assembly | Register unknowns, render `<unknowns>` |
| `previous` | Assembly | Render `<previous>` loop history |
| `performed` | Assembly | Render `<performed>` active loop work |
| `progress` | Assembly | Render `<progress>` telemetry + warnings |
| `prompt` | Assembly | Render `<prompt mode="ask|act">` tag |
| `hedberg` | Utility | Pattern matching, interpretation, normalization |
| `instructions` | Internal | Preamble + tool docs + persona assembly |
| `file` | Internal | File entry projections and constraints |
| `rpc` | Internal | RPC method registration |
| `telemetry` | Internal | Audit entries, usage stats, reasoning_content |
| `budget` | Internal | Context ceiling enforcement (413), panic mode, BudgetGuard |
| `think` | Internal | Model reasoning tag (`model_visible = 0`) |
| `mcp` | Core tool | Model Context Protocol server management |

Removed: `crunch` (dead code, replaced by model-owned context management),
`store` (merged into `set` fidelity attributes).

## §10 External Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Repo | `@possumtech/rummy.repo` | Git-aware file scanning and symbol extraction |
| Web | `@possumtech/rummy.web` | Web search and URL fetching via searxng |

Loaded via `RUMMY_PLUGIN_*` env vars. External plugins have access
to the same PluginContext API as bundled plugins.

## §11 RPC Methods

Client-facing JSON-RPC 2.0 over WebSocket. All tool methods go through
the same handler chain as model commands.

### §11.1 Wire Format

```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "get", "params": { "path": "src/app.js", "run": "my_run" } }

// Success response
{ "jsonrpc": "2.0", "id": 1, "result": { "path": "src/app.js", "status": 200 } }

// Error response
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Missing required param: path" } }

// Notification (server → client, no id)
{ "jsonrpc": "2.0", "method": "run/state", "params": { "run": "my_run", "status": 200 } }
```

### §11.2 Tool Methods (Unified API)

| Method | Params | Notes |
|--------|--------|-------|
| `get` | `{ path, run, persist?, readonly? }` | `persist` also sets file constraint |
| `set` | `{ path, body, run, attributes? }` | All entries go through handler chain |
| `rm` | `{ path, run }` | |
| `mv` | `{ path, to, run }` | |
| `cp` | `{ path, to, run }` | |
| `store` | `{ path, run?, persist?, ignore?, clear? }` | File constraints only — not a model tool |
| `getEntries` | `{ pattern?, body?, run?, limit?, offset? }` | Query entries |

### §11.3 Run Management

| Method | Params | Notes |
|--------|--------|-------|
| `startRun` | `{ model, temperature?, persona?, contextLimit? }` | Create run without prompt |
| `ask` | `{ model, prompt, run?, noInteraction?, noWeb?, noRepo? }` | |
| `act` | `{ model, prompt, run?, noInteraction?, noWeb?, noRepo? }` | |
| `run/resolve` | `{ run, resolution }` | Accept/reject proposals |
| `run/abort` | `{ run }` | Cancel active run |
| `run/config` | `{ run, contextLimit?, persona?, model? }` | Update run settings |
| `run/rename` | `{ run, name }` | Change run alias |
| `run/inject` | `{ run, message }` | Inject message into active turn |

### §11.4 Project Management

| Method | Params | Notes |
|--------|--------|-------|
| `init` | `{ name, projectRoot }` | Initialize project |
| `addModel` | `{ alias, actual, contextLength? }` | Register model |
| `removeModel` | `{ alias }` | Remove model |
| `getRuns` | `{ limit?, offset? }` | List runs |
| `getRun` | `{ run }` | Get single run details |
| `getModels` | `{}` | List models |

### §11.5 Notifications (server → client)

| Method | Payload |
|--------|---------|
| `run/state` | `{ run, status, turn, entries, ... }` |
| `run/progress` | `{ run, status }` |
| `ui/render` | `{ text }` |
| `ui/notify` | `{ message }` |
