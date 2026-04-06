# PLUGINS.md — Plugin Development Guide

## Plugin Contract

A plugin is a directory under `src/plugins/` containing a `.js` file that
exports a default class. The class name matches the file name. The
constructor receives `core` (a PluginContext) — the plugin's complete
interface with the system.

```js
import { readFileSync } from "node:fs";

export default class MyTool {
    #core;

    constructor(core) {
        this.#core = core;
        core.registerScheme();
        core.on("handler", this.handler.bind(this));
        core.on("full", this.full.bind(this));
        core.on("summary", this.summary.bind(this));
        const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
        core.filter("instructions.toolDocs", async (content) =>
            content ? `${content}\n\n${docs}` : docs,
        );
    }

    async handler(entry, rummy) {
        // What the tool does (rummy is per-turn RummyContext)
    }

    full(entry) {
        return `# mytool ${entry.path}\n${entry.body}`;
    }

    summary(entry) {
        return entry.body;
    }
}
```

File naming: `src/plugins/mytool/mytool.js`. Class name = file name.
Tool docs: `src/plugins/mytool/docs.md`.

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

All registration happens in the constructor via `core.on()`,
`core.filter()`, and `core.registerScheme()`.

### core.registerScheme(config?)

Registers this plugin's scheme in the database. Called once in the
constructor. Defaults are third-party friendly:

```js
core.registerScheme({
    fidelity: "full",        // "full", "turn", or "null"
    modelVisible: 1,         // 1 or 0
    validStates: ["full", "proposed", "pass", "rejected", "error"],
    category: "result",      // "result", "file", "knowledge", "structural", "audit", "tool"
});
```

All fields optional. `core.registerScheme()` with no args gives a
sensible result-type scheme.

### core.on(event, callback, priority?)

| Event | Purpose |
|-------|---------|
| `"handler"` | Tool handler — called when model/client invokes this tool |
| `"full"` | Full fidelity — what the model sees in `<current>` |
| `"summary"` | Summary fidelity — what the model sees in `<previous>` |
| `"turn.started"` | Turn beginning — write prompt/progress/instructions entries |
| `"turn.response"` | LLM responded — write audit entries, commit usage |
| `"turn.proposing"` | All dispatches done — materialize file edit proposals |
| `"entry.created"` | Entry created during dispatch |
| `"entry.changed"` | File entries changed on disk |
| Any `"dotted.name"` | Resolves to the matching hook in the hook tree |

### core.filter(name, callback, priority?)

| Filter | Purpose |
|--------|---------|
| `"instructions.toolDocs"` | Append tool documentation to model prompt |
| `"assembly.system"` | Contribute to system message |
| `"assembly.user"` | Contribute to user message |
| `"llm.messages"` | Transform final messages before LLM call |
| `"llm.response"` | Transform LLM response |
| Any `"dotted.name"` | Resolves to the matching filter in the hook tree |

### Tool Docs

Each tool plugin has a `docs.md` file with model-facing documentation.
Registered via the `instructions.toolDocs` filter in the constructor:

```js
const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
core.filter("instructions.toolDocs", async (content) =>
    content ? `${content}\n\n${docs}` : docs,
);
```

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

### full(entry) / summary(entry)

Returns the string the model sees for this tool's entries at the given
fidelity. `full` renders in `<current>` (active loop). `summary` renders
in `<previous>` (completed loops). Every tool MUST register `full`.
`summary` is optional — if unregistered, the entry is empty at summary
fidelity.

## Two Objects

Plugins interact with two objects at different scopes:

**PluginContext** (`this.#core`) — startup-scoped. Created once per plugin.
Used for registration (`on()`, `filter()`, `registerScheme()`), database
access, store queries. This is `rummy.core` — the plugin-only tier that
clients cannot reach.

**RummyContext** (`rummy` argument) — turn-scoped. Passed to handlers
per-invocation. Has tool verbs, per-turn state (runId, turn, mode).

### Tool Verbs (on RummyContext)

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

## Hedberg

The hedberg plugin exposes pattern matching and interpretation utilities
on `core.hooks.hedberg` for all plugins to use:

```js
const { match, search, replace, parseSed, parseEdits, normalizeAttrs, generatePatch }
    = core.hooks.hedberg;
```

| Method | Purpose |
|--------|---------|
| `match(pattern, string)` | Full-string pattern match (glob, regex, literal) |
| `search(pattern, string)` | Substring search, returns `{ found, match, index }` |
| `replace(body, search, replacement, opts?)` | Apply replacement (sed → literal → heuristic) |
| `parseSed(input)` | Parse sed syntax into `[{ search, replace, flags, sed }]` |
| `parseEdits(content)` | Detect edit format (merge conflict, udiff, Claude XML) |
| `normalizeAttrs(attrs)` | Heal model attribute names |
| `generatePatch(path, old, new)` | Generate unified diff |

Pattern types (auto-detected):

| Syntax | Type | Example |
|--------|------|---------|
| `s/old/new/flags` | Sed replace | `s/3000/8080/g` |
| `/pattern/flags` | Regex | `/\d+/g` |
| `$.path` | JSONPath | `$.config.port` |
| `//element` | XPath | `//div[@class]` |
| `*glob*` | Glob | `src/**/*.js` |
| Everything else | Literal | `port = 3000` |

## Events & Filters

**Events** are fire-and-forget. All handlers run. Return values ignored.
**Filters** transform data through a chain. Lower priority runs first.
All hooks are async.

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
| `run.state` | event | `{ run, turn, status, summary, history, unknowns, proposed, telemetry }` | After each turn |
| `run.step.completed` | event | `{ run, turn, flags }` | Turn resolved, no proposals pending |
| `ask.completed` | event | `{ projectId, run, status, turn }` | Ask run finished |
| `act.completed` | event | `{ projectId, run, status, turn }` | Act run finished |

### Turn Pipeline

Hooks fire in this order every turn:

| Hook | Type | Payload | When |
|------|------|---------|------|
| `turn.started` | event | `{ rummy, mode, prompt, isContinuation }` | Plugins write prompt/progress/instructions entries |
| `entry.changed` | event | `{ rummy, runId, turn, paths }` | Files changed on disk (repo plugin) |
| `onTurn` | processor | `(rummy)` | Plugin turn setup, before context assembly |
| `assembly.system` | filter | `(content, { rows, loopStartTurn, type, contextSize })` | Build system message |
| `assembly.user` | filter | `(content, { rows, loopStartTurn, type, contextSize })` | Build user message |
| `llm.messages` | filter | `messages[], { model, projectId, runId }` | Before LLM call |
| `llm.request.started` | event | `{ model, turn }` | LLM call about to fire |
| `llm.response` | filter | `response, { model, projectId, runId }` | Raw LLM response |
| `llm.request.completed` | event | `{ model, turn, usage }` | LLM call finished |
| `turn.response` | event | `{ rummy, turn, result, responseMessage, content, ... }` | Plugins write audit entries |
| `tools.dispatch` | handler | `(entry, rummy)` | Per command — handler chain executes |
| `entry.created` | event | `{ scheme, path, body, attributes, state, resultPath }` | After each command dispatched |
| `turn.proposing` | event | `{ rummy, recorded }` | All dispatches done — materialize proposals |

### Client Notifications

| Hook | Type | Payload | When |
|------|------|---------|------|
| `ui.render` | event | `{ text, append }` | Text for client display |
| `ui.notify` | event | `{ text, level }` | Status notification |

## Bundled Plugins

Each plugin has its own README at `src/plugins/{name}/README.md`.

| Plugin | Type | Description |
|--------|------|-------------|
| [`get`](src/plugins/get/) | Core tool | Load file/entry into context |
| [`set`](src/plugins/set/) | Core tool | Edit file/entry |
| [`known`](src/plugins/known/) | Core tool + Assembly | Save knowledge, render `<knowns>` section |
| [`store`](src/plugins/store/) | Core tool | Remove from context |
| [`rm`](src/plugins/rm/) | Core tool | Delete permanently |
| [`mv`](src/plugins/mv/) | Core tool | Move entry |
| [`cp`](src/plugins/cp/) | Core tool | Copy entry |
| [`sh`](src/plugins/sh/) | Core tool | Shell command |
| [`env`](src/plugins/env/) | Core tool | Exploratory command |
| [`ask_user`](src/plugins/ask_user/) | Core tool | Ask the user |
| [`summarize`](src/plugins/summarize/) | Structural | Signal completion |
| [`update`](src/plugins/update/) | Structural | Signal continued work |
| [`unknown`](src/plugins/unknown/) | Structural + Assembly | Register unknowns, render `<unknowns>` |
| [`previous`](src/plugins/previous/) | Assembly | Render `<previous>` loop history |
| [`current`](src/plugins/current/) | Assembly | Render `<current>` active loop work |
| [`progress`](src/plugins/progress/) | Assembly | Render `<progress>` telemetry + bridge |
| [`prompt`](src/plugins/prompt/) | Assembly | Render `<ask>`/`<act>` prompt tag |
| [`hedberg`](src/plugins/hedberg/) | Utility | Pattern matching, interpretation, normalization |
| [`instructions`](src/plugins/instructions/) | Internal | Preamble + tool docs + persona assembly |
| [`file`](src/plugins/file/) | Internal | File entry projections and constraints |
| [`rpc`](src/plugins/rpc/) | Internal | RPC method registration |
| [`skills`](src/plugins/skills/) | Internal | Skill/persona management |
| [`telemetry`](src/plugins/telemetry/) | Internal | Audit entries, usage stats, last_run.txt |

## External Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Repo | `@possumtech/rummy.repo` | Git-aware file scanning and symbol extraction |
| Web | `@possumtech/rummy.web` | Web search and URL fetching via searxng |

Loaded via `RUMMY_PLUGIN_*` env vars.
