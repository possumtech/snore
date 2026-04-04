# PLUGINS.md — Plugin Development Guide

## Plugin Contract

A plugin is a directory under `src/plugins/` containing a `.js` file that
exports a default class. The class name matches the file name. The
constructor receives `rummy` — the plugin's complete interface with
the system.

```js
export default class MyTool {
    #rummy;

    constructor(rummy) {
        this.#rummy = rummy;
        rummy.on("handler", this.handler.bind(this));
        rummy.on("view", this.view.bind(this));
    }

    async handler(entry, rummy) {
        // What the tool does
    }

    view(entry) {
        // What the model sees
        return `# mytool ${entry.path}\n${entry.body}`;
    }
}
```

File naming: `src/plugins/mytool/mytool.js`. Class name = file name.

External plugins install via npm and load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
RUMMY_PLUGIN_REPO=@possumtech/rummy.repo
```

## Unified API

The model, the client, and plugins all use the same interface. Each tier
is a superset of the one below. `name` (model) = `method` (client) =
method name (plugin). The params shape is the same at every tier.

```
Model:  <rm path="file.txt"/>           → { name: "rm", path: "file.txt" }
Client: { method: "rm", params: { path: "file.txt" } }
Plugin: rummy.rm({ path: "file.txt" })
```

## Registration

All registration happens in the constructor via `rummy.on()` and
`rummy.filter()`. No static methods. No direct hook manipulation.

### rummy.on(event, callback, priority?)

| Event | Purpose |
|-------|---------|
| `"handler"` | Tool handler — called when model/client invokes this tool |
| `"full"` | Full projection — what the model sees at full fidelity |
| `"summary"` | Summary projection — condensed view under token pressure |
| `"docs"` | Tool documentation — included in model prompt |
| `"turn"` | Turn processor — runs before context materialization |
| `"entry.created"` | Entry created during dispatch |
| `"entry.changed"` | File entries changed on disk |
| Any `"dotted.name"` | Resolves to the matching hook in the hook tree |

### rummy.filter(name, callback, priority?)

| Filter | Purpose |
|--------|---------|
| `"assembly.system"` | Contribute to system message |
| `"assembly.user"` | Contribute to user message |
| `"llm.messages"` | Transform final messages before LLM call |
| `"llm.response"` | Transform LLM response |
| Any `"dotted.name"` | Resolves to the matching filter in the hook tree |

### handler(entry, rummy)

The handler receives the parsed command entry and a per-turn RummyContext:

```js
entry = {
    scheme,       // Tool name ("set", "get", "rm", etc.)
    path,         // Entry path ("set://src/app.js")
    body,         // Tag body text
    attributes,   // Parsed tag attributes
    state,        // Current state
    resultPath,   // Where to write the result
}
```

Multiple handlers per scheme. Lower priority runs first. Return `false`
to stop the chain.

### view(entry)

Returns the string the model sees for this tool's entries. Called during
materialization. Every tool MUST register a view. No default. No fallback.

## Two Rummy Objects

Plugins interact with two rummy objects at different scopes:

**PluginContext** (`this.#rummy`) — startup-scoped. Created once per plugin.
Used for registration (`on()`, `filter()`), database access, store queries.
Lives for the lifetime of the service.

**RummyContext** (`rummy` argument) — turn-scoped. Passed to handlers
per-invocation. Has tool verbs, per-turn state (runId, turn, mode).

### Tool Verbs (available on both objects)

| Method | Effect |
|--------|--------|
| `rummy.set({ path, body, state, attributes })` | Create/update entry |
| `rummy.get({ path })` | Promote to full state |
| `rummy.store({ path })` | Demote to stored state |
| `rummy.rm({ path })` | Delete permanently |
| `rummy.mv({ path, to })` | Move entry |
| `rummy.cp({ path, to })` | Copy entry |

### Query Methods

| Method | Returns |
|--------|---------|
| `rummy.getEntry(path)` | Full entry object |
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | State string or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` |
| `rummy.getEntries(pattern, body?)` | Array of matching entries |

### Properties

| Property | Type |
|----------|------|
| `rummy.name` | Plugin name (PluginContext only) |
| `rummy.entries` | KnownStore instance |
| `rummy.db` | Database |
| `rummy.runId` | Current run ID (RummyContext only) |
| `rummy.projectId` | Current project ID |
| `rummy.sequence` | Current turn number (RummyContext only) |

## Events & Filters

**Events** are fire-and-forget. All handlers run. Return values ignored.

```js
hooks.entry.changed.on(async ({ rummy, runId, turn, paths }) => {
    // React to file changes
}, priority);
```

**Filters** transform data through a chain. Each handler receives the value
and context, returns the (possibly modified) value.

```js
hooks.llm.messages.addFilter(async (messages, context) => {
    return [{ role: "system", content: "Extra" }, ...messages];
}, priority);
```

Lower priority runs first. All hooks are async.

### Project Lifecycle

| Hook | Type | Payload | When |
|------|------|---------|------|
| `project.init.started` | event | `{ projectName, projectRoot }` | Before project DB upsert |
| `project.init.completed` | event | `{ projectId, projectRoot, db }` | After project created |

### RPC Pipeline

| Hook | Type | Payload | When |
|------|------|---------|------|
| `socket.message.raw` | filter | Raw buffer | Before JSON parse |
| `rpc.request` | filter | `{ method, params, id }` | Before handler lookup |
| `rpc.started` | event | `{ method, params, id, projectId }` | Before handler execution |
| `rpc.response.result` | filter | `result, { method, id }` | Before sending response |
| `rpc.completed` | event | `{ method, id, result }` | After response sent |
| `rpc.error` | event | `{ id, error }` | On handler error |

### Run Lifecycle

| Hook | Type | Payload | When |
|------|------|---------|------|
| `ask.started` | event | `{ projectId, model, prompt, run }` | Run requested in ask mode |
| `act.started` | event | `{ projectId, model, prompt, run }` | Run requested in act mode |
| `run.config` | filter | Config object, `{ projectId }` | Before run config applied |
| `run.progress` | event | `{ run, turn, status }` | Status change (thinking, processing) |
| `run.state` | event | `{ run, turn, status, summary, history, unknowns, proposed, telemetry }` | After each turn — full state snapshot |
| `run.step.completed` | event | `{ run, turn, flags }` | Turn resolved, no proposals pending |
| `ask.completed` | event | `{ projectId, run, status, turn }` | Ask run finished |
| `act.completed` | event | `{ projectId, run, status, turn }` | Act run finished |

### Turn Pipeline

Hooks fire in this order every turn:

| Hook | Type | Payload | When |
|------|------|---------|------|
| `entry.changed` | event | `{ rummy, runId, turn, paths }` | Files changed on disk since last turn |
| `onTurn` | processor | `(rummy)` | Plugin turn setup, before context assembly |
| `llm.messages` | filter | `messages[], { model, projectId, runId }` | Before LLM call — modify system/user messages |
| `llm.request.started` | event | `{ model, turn }` | LLM call about to fire |
| `llm.response` | filter | `response, { model, projectId, runId }` | Raw LLM response — normalize, transform |
| `llm.request.completed` | event | `{ model, turn, usage }` | LLM call finished |
| `tools.dispatch` | handler | `(entry, rummy)` | Per command — handler chain executes |
| `entry.created` | event | `{ scheme, path, body, attributes, state, resultPath }` | After each command dispatched |
| `turn.proposing` | event | `{ rummy, recorded }` | All dispatches done — materialize proposals |

### Client Notifications

| Hook | Type | Payload | When |
|------|------|---------|------|
| `ui.render` | event | `{ text, append }` | Text for client display |
| `ui.notify` | event | `{ text, level }` | Status notification |

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
