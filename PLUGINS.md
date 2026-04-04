# PLUGINS.md — Plugin Development Guide

## Plugin Contract

A plugin is a directory under `src/plugins/` containing a `.js` file that
exports a default class with a static `register` method:

```js
export default class MyPlugin {
    static register(hooks) {
        // Register tools, RPC methods, turn processors, events, filters
    }
}
```

File naming: `src/plugins/mytool/mytool.js` or `src/plugins/mytool/index.js`.

External plugins install via npm and load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
RUMMY_PLUGIN_REPO=@possumtech/rummy.repo
```

## Tool Registration

```js
hooks.tools.register("mytool", {
    modes: new Set(["ask", "act"]),  // or just ["ask"] or ["act"]
    category: "ask",                  // "ask", "act", or "structural"
    docs: "## <mytool>...</mytool>\nTool documentation for the model.",
    project: (entry) => {             // REQUIRED — how the model sees the result
        return `# mytool ${entry.path}\n${entry.body}`;
    },
    handler: async (entry, rummy) => {
        // Handle the tool command
    },
});
```

### Projection (`project`)

Every tool MUST define a projection. No default. No fallback. Crash if missing.

The projection receives the entry and returns the string the model sees in
its message history. The entry has: `{ path, scheme, body, attributes, fidelity, category }`.

### Handler

The handler receives `(entry, rummy)` where entry is:
```js
{
    scheme,       // Tool name ("set", "get", "rm", etc.)
    path,         // Entry path ("set://src%2Fapp.js")
    body,         // Tag body text
    attributes,   // Parsed tag attributes
    state,        // Current state ("full" on initial recording)
    resultPath,   // Where to write the result
}
```

### Handler Priority Chain

Multiple handlers per scheme. Lower priority runs first.

```js
hooks.tools.onHandle("get", async (entry, rummy) => {
    // Priority 5 — runs before default handler at 10
    if (!isHttpUrl(entry.attributes.path)) return;
    // Handle http URLs, return false to stop chain
    return false;
}, 5);
```

Return `false` to stop the chain. Return anything else (or nothing) to
continue to the next handler.

## RummyContext (`rummy`)

The plugin's interface to the store. All methods auto-scope to the current run.

### Tool Methods (same verbs as model and client)

| Method | Effect |
|--------|--------|
| `rummy.set({ path, body, state, attributes })` | Create/update entry |
| `rummy.get(path)` | Promote to full state |
| `rummy.store(path)` | Demote to stored state |
| `rummy.rm(path)` | Delete permanently |
| `rummy.mv(from, to)` | Move entry |
| `rummy.cp(from, to)` | Copy entry |

### Read Methods

| Method | Returns |
|--------|---------|
| `rummy.getEntry(path)` | Full entry: `{ path, body, scheme, state, tokens_full, attributes }` |
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | State string or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` |
| `rummy.getEntries(pattern, body?)` | Array of matching entries |

### Write Methods

| Method | Effect |
|--------|--------|
| `rummy.setAttributes(path, attrs)` | Atomic merge via `json_patch` (concurrency-safe) |
| `rummy.log(message)` | Create audit log entry |

### Context Properties

| Property | Type |
|----------|------|
| `rummy.entries` | KnownStore instance (raw store access) |
| `rummy.hooks` | Hook system |
| `rummy.db` | Database |
| `rummy.runId` | Current run ID |
| `rummy.projectId` | Current project ID |
| `rummy.sequence` | Current turn number |

## Turn Processors

Run logic before materialization. Priority controls order (lower = first).

```js
hooks.onTurn(async (rummy) => {
    // Modify entries before the model sees them
}, priority);
```

## Events

Fire-and-forget. All handlers run. Return values ignored.

```js
hooks.entry.changed.on(async ({ rummy, runId, turn, paths }) => {
    // paths: string[] of entries that changed
    // rummy: full RummyContext for this turn
});
```

| Event | Payload |
|-------|---------|
| `entry.created` | `{ scheme, path, body, attributes, state, resultPath }` |
| `entry.changed` | `{ rummy, runId, turn, paths }` |
| `project.init.started` | `{ projectName, projectRoot }` |
| `project.init.completed` | `{ projectId, projectRoot, db }` |
| `run.started` | `{ run, projectId, mode }` |
| `run.progress` | `{ run, turn, status }` |
| `run.state` | `{ run, turn, status, summary, history, unknowns, proposed, telemetry }` |
| `run.step.completed` | `{ run, turn, flags }` |
| `ask.started/completed` | `{ projectId, run, ... }` |
| `act.started/completed` | `{ projectId, run, ... }` |
| `llm.request.started/completed` | `{ model, turn, usage? }` |
| `ui.render` | `{ text, append }` |
| `ui.notify` | `{ text, level }` |
| `rpc.started/completed/error` | `{ method, id, ... }` |

## Filters

Transform data through a chain. Each handler receives the value and context,
returns the (possibly modified) value. Priority controls order.

```js
hooks.llm.messages.addFilter(async (messages, context) => {
    return [{ role: "system", content: "Extra" }, ...messages];
}, 5);
```

| Filter | Value | Context |
|--------|-------|---------|
| `llm.messages` | Message array | `{ model, projectId, runId }` |
| `llm.response` | Response object | `{ model, projectId, runId }` |
| `run.config` | Config object | `{ projectId }` |
| `socket.message.raw` | Raw buffer | — |
| `rpc.request` | Parsed request | — |
| `rpc.response.result` | Result object | `{ method, id }` |

## RPC Registration

```js
hooks.rpc.registry.register("myMethod", {
    handler: async (params, ctx) => {
        // ctx.projectAgent, ctx.db, ctx.projectId, ctx.projectRoot
        return { result: "value" };
    },
    description: "What this method does",
    params: { arg1: "description" },
    requiresInit: true,
    longRunning: true,  // for methods that call the model
});
```

## Hedberg Pattern Library

Available in JS and SQL. Five pattern types, auto-detected:

| Syntax | Type | Example |
|--------|------|---------|
| `s/old/new/flags` | Sed replace | `s/3000/8080/g` |
| `/pattern/flags` | Regex | `/\d+/g` |
| `$.path` | JSONPath | `$.config.port` |
| `//element` | XPath | `//div[@class]` |
| `*glob*` | Glob | `src/**/*.js` |
| Everything else | Literal | `port = 3000` |

JS API:

```js
import { hedmatch, hedsearch, hedreplace } from "./sql/functions/hedberg.js";

hedmatch(pattern, string)              // → boolean (full string match)
hedsearch(pattern, string)             // → { found, match, index }
hedreplace(pattern, replacement, string) // → new string or null
```

SQL functions: `hedmatch()`, `hedsearch()`, `hedreplace()`.

## Bundled Plugins

Each plugin has its own README at `src/plugins/{name}/README.md`.

| Plugin | Type | Description |
|--------|------|-------------|
| [`get`](src/plugins/get/) | Core tool | Load file/entry into context |
| [`set`](src/plugins/set/) | Core tool | Edit file/entry |
| [`known`](src/plugins/known/) | Core tool | Save knowledge |
| [`store`](src/plugins/store/) | Core tool | Remove from context |
| [`rm`](src/plugins/rm/) | Core tool | Delete permanently |
| [`mv`](src/plugins/mv/) | Core tool | Move entry |
| [`cp`](src/plugins/cp/) | Core tool | Copy entry |
| [`sh`](src/plugins/sh/) | Core tool | Shell command |
| [`env`](src/plugins/env/) | Core tool | Exploratory command |
| [`ask_user`](src/plugins/ask_user/) | Core tool | Ask the user |
| [`summarize`](src/plugins/summarize/) | Structural | Signal completion |
| [`update`](src/plugins/update/) | Structural | Signal continued work |
| [`unknown`](src/plugins/unknown/) | Structural | Register unknowns |
| [`instructions`](src/plugins/instructions/) | Internal | System prompt assembly |
| [`file`](src/plugins/file/) | Internal | File projections, constraints, scanning |
| [`rpc`](src/plugins/rpc/) | Internal | RPC method registration |
| [`skills`](src/plugins/skills/) | Internal | Skill/persona management |
| [`telemetry`](src/plugins/telemetry/) | Internal | Debug logging |

## External Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Web | `@possumtech/rummy.web` | Search and URL fetching |
| Repo | `@possumtech/rummy.repo` | Symbol extraction |

Loaded via `RUMMY_PLUGIN_*` env vars. Graceful failure if not installed.
