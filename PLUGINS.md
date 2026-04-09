# PLUGINS.md — Plugin Development Guide

Every `<tag>` the model sees is a plugin. Every scheme is registered by
its owner. Every operation — model, client, plugin — flows through the
same tool handler. No exceptions without documentation in EXCEPTIONS.md.

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
        core.registerScheme({ category: "result" });
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
    category: "result",  // "result", "file", "knowledge", "structural"
});
```

All fields optional. `core.registerScheme()` with no args gives a
sensible result-type scheme.

### §3.3 core.on(event, callback, priority?)

| Event | Purpose |
|-------|---------|
| `"handler"` | Tool handler — called when model/client invokes this tool |
| `"full"` | Full fidelity projection — what the model sees at full |
| `"summary"` | Summary fidelity projection — what the model sees at summary |
| `"turn.started"` | Turn beginning — write prompt/progress/instructions entries |
| `"turn.response"` | LLM responded — write audit entries, commit usage |
| `"turn.proposing"` | All dispatches done — materialize file edit proposals |
| `"entry.created"` | Entry created during dispatch |
| `"entry.changed"` | Entry content, fidelity, or status modified |
| Any `"dotted.name"` | Resolves to the matching hook in the hook tree |

### §3.4 core.filter(name, callback, priority?)

| Filter | Purpose |
|--------|---------|
| `"instructions.toolDocs"` | Add tool documentation (docsMap pattern) |
| `"assembly.system"` | Contribute to system message |
| `"assembly.user"` | Contribute to user message |
| `"llm.messages"` | Transform final messages before LLM call |
| `"llm.response"` | Transform LLM response |
| Any `"dotted.name"` | Resolves to the matching filter in the hook tree |

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

### §7.2 Run Lifecycle

| Hook | Type | When |
|------|------|------|
| `ask.started` | event | Run requested in ask mode |
| `act.started` | event | Run requested in act mode |
| `run.config` | filter | Before run config applied |
| `run.progress` | event | Status change (thinking, processing) |
| `run.state` | event | After each turn — full state snapshot |
| `run.step.completed` | event | Turn resolved, no proposals pending |
| `ask.completed` | event | Ask run finished |
| `act.completed` | event | Act run finished |

### §7.3 Turn Pipeline

Hooks fire in this order every turn:

| # | Hook | Type | When |
|---|------|------|------|
| 1 | `turn.started` | event | Plugins write prompt/progress/instructions entries |
| 2 | `assembly.system` | filter | Build system message from entries |
| 3 | `assembly.user` | filter | Build user message from entries |
| 4 | `budget.enforce` | hook | Measure assembled tokens, 413 if over |
| 5 | `llm.messages` | filter | Transform messages before LLM call |
| 6 | `llm.request.started` | event | LLM call about to fire |
| 7 | `llm.response` | filter | Transform raw LLM response |
| 8 | `llm.request.completed` | event | LLM call finished |
| 9 | `turn.response` | event | Plugins write audit entries |
| 10 | Lifecycle dispatch | — | summarize/update/known/unknown always dispatch |
| 11 | Action dispatch | — | get/set/rm/mv/cp/sh/env/search sequential |
| 12 | `entry.created` | event | After each new entry dispatched |
| 13 | `entry.changed` | event | After entry content, fidelity, or status modified |
| 14 | `turn.proposing` | event | All dispatches done — materialize proposals |

### §7.4 Entry Events

| Hook | Type | When |
|------|------|------|
| `entry.created` | event | New entry added during dispatch |
| `entry.changed` | event | Entry content, fidelity, or status modified |

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

Entries at `stored` fidelity skip steps 4-6 (invisible to model).
Entries at `index` fidelity render as path-only tags (no body).
Entries at `summary` fidelity render with `attributes.summary`
prepended above the plugin's summary view output.

## §9 Bundled Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `get` | Core tool | Load file/entry into context |
| `set` | Core tool | Edit file/entry, fidelity control |
| `known` | Core tool + Assembly | Save knowledge, render `<knowns>` section |
| `rm` | Core tool | Delete permanently |
| `mv` | Core tool | Move entry |
| `cp` | Core tool | Copy entry |
| `sh` | Core tool | Shell command (act mode only) |
| `env` | Core tool | Exploratory command |
| `ask_user` | Core tool | Ask the user |
| `search` | Core tool | Web search (via external plugin) |
| `summarize` | Structural | Signal completion |
| `update` | Structural | Signal continued work |
| `unknown` | Structural + Assembly | Register unknowns, render `<unknowns>` |
| `previous` | Assembly | Render `<previous>` loop history |
| `current` | Assembly | Render `<current>` active loop work |
| `progress` | Assembly | Render `<progress>` telemetry + warnings |
| `prompt` | Assembly | Render `<ask>`/`<act>` prompt tag |
| `hedberg` | Utility | Pattern matching, interpretation, normalization |
| `instructions` | Internal | Preamble + tool docs + persona assembly |
| `file` | Internal | File entry projections and constraints |
| `rpc` | Internal | RPC method registration |
| `telemetry` | Internal | Audit entries, usage stats, reasoning_content |
| `budget` | Internal | Context ceiling enforcement (413) |

## §10 External Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Repo | `@possumtech/rummy.repo` | Git-aware file scanning and symbol extraction |
| Web | `@possumtech/rummy.web` | Web search and URL fetching via searxng |

Loaded via `RUMMY_PLUGIN_*` env vars. External plugins have access
to the same PluginContext API as bundled plugins.

## §11 RPC Methods

Client-facing JSON-RPC methods. All tool methods go through the
same handler chain as model commands.

### §11.1 Tool Methods (Unified API)

| Method | Params | Notes |
|--------|--------|-------|
| `get` | `{ path, run }` | Same handler as model `<get>` |
| `set` | `{ path, body, run }` | Same handler as model `<set>` |
| `rm` | `{ path, run }` | Same handler as model `<rm>` |
| `mv` | `{ path, to, run }` | Same handler as model `<mv>` |
| `cp` | `{ path, to, run }` | Same handler as model `<cp>` |

### §11.2 Run Management

| Method | Params | Notes |
|--------|--------|-------|
| `ask` | `{ model, prompt, run?, noInteraction?, noWeb?, noRepo? }` | |
| `act` | `{ model, prompt, run?, noInteraction?, noWeb?, noRepo? }` | |
| `run/resolve` | `{ run, resolution }` | Accept/reject proposals |
| `run/abort` | `{ run }` | Cancel active run |
| `run/config` | `{ run, contextLimit?, persona? }` | Update run settings |
| `run/rename` | `{ run, name }` | Change run alias |

### §11.3 Project Management

| Method | Params | Notes |
|--------|--------|-------|
| `init` | `{ name, projectRoot }` | Initialize project |
| `addModel` | `{ alias, actual, contextLength? }` | Register model |
| `getRuns` | `{ limit?, offset? }` | List runs |
| `getModels` | `{}` | List models |
