# Rummy Plugin Guide

Rummy plugins extend the server through a registration pattern. Core functionality
uses the same pattern — there is no distinction between "built-in" and "third-party"
at the registration level.

---

## Plugin Contract

A plugin is a `.js` file that exports a default class with a static `register` method:

```js
export default class MyPlugin {
    static register(hooks) {
        // Register tools, RPC methods, turn processors, event listeners, filters
    }
}
```

Plugins are loaded from three directories in order:
1. `src/application/plugins/` — internal core plugins
2. `src/plugins/` — bundled plugins
3. `~/.rummy/plugins/` — user-installed plugins

Within each directory, the loader scans subdirectories for files named `index.js`
or matching the directory name (e.g., `tools/tools.js`). Test files (`*.test.js`)
are skipped.

---

## Registries

### Tool Registry (`hooks.tools`)

Register tools the model can invoke via `<todo>` items.

```js
hooks.tools.register("mytool", {
    modes: new Set(["ask", "act"]),  // which modes allow this tool
    category: "act",                  // "ask" | "act" | "structural"
});
```

- `modes` — which run types (`ask`, `act`) this tool is available in.
- `category` — determines behavior:
  - `"ask"` — executed directly by the server (e.g., `read`, `drop`)
  - `"act"` — creates findings for client resolution (e.g., `edit`, `run`)
  - `"structural"` — captured as metadata, not executed (e.g., `summary`)

The tool name becomes valid in `<todo>` items: `- [ ] mytool: argument # description`.

**Methods**: `get(name)`, `has(name)`, `actTools` (getter),
`names` (getter), `entries()`.

### RPC Registry (`hooks.rpc.registry`)

Register JSON-RPC methods clients can call.

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
    requiresInit: true,  // if true, throws before init
});
```

Register notification metadata (for `discover` output):

```js
hooks.rpc.registry.registerNotification("my/notification", "Description.");
```

`discover` auto-generates from the registry. No manual catalog maintenance.

**Methods**: `get(name)`, `has(name)`, `discover()`.

---

## Turn Processors (`hooks.onTurn`)

Inject content into the turn context before the LLM sees it.

```js
hooks.onTurn(async (rummy) => {
    if (rummy.noContext) return;  // skip in Lite mode

    const el = rummy.tag("mycontent", { source: "myplugin" }, ["data here"]);
    rummy.contextEl.appendChild(el);
}, 10);  // priority: lower = runs first
```

### RummyContext API (`rummy`)

| Property | Type | Description |
|---|---|---|
| `doc` | Document | Raw XML Document (@xmldom) |
| `db` | SqlRite | Database with all prepared queries |
| `project` | Object | `{ id, path, name }` |
| `type` | String | `"ask"` or `"act"` |
| `sessionId` | String | Current session ID |
| `runId` | String | Current run ID |
| `turnId` | Number | Current turn ID |
| `sequence` | Number | Turn sequence number |
| `noContext` | Boolean | True in Lite mode (skip file context) |
| `contextSize` | Number | Token budget for context |
| `system` | Element | `<system>` XML element |
| `contextEl` | Element | `<context>` XML element |
| `user` | Element | `<user>` XML element |
| `assistant` | Element | `<assistant>` XML element |
| `tag(name, attrs?, children?)` | Function | Create XML element |

---

## Events

Events are fire-and-forget notifications. All handlers run; return values are ignored.

```js
hooks.project.init.completed.on(async (payload) => {
    console.log(`Project initialized: ${payload.projectPath}`);
}, 5);  // optional priority
```

| Hook | Payload | When |
|---|---|---|
| `project.init.started` | `{ projectPath, projectName, clientId }` | Before project setup |
| `project.init.completed` | `{ projectId, sessionId, projectPath, db }` | After project setup |
| `project.files.update.started` | `{ projectId, pattern, constraint }` | Before file promotion change |
| `project.files.update.completed` | `{ projectId, projectPath, pattern, constraint, db }` | After file promotion change |
| `run.started` | `{ runId, sessionId, type }` | Run created |
| `run.progress` | `{ sessionId, runId, turn, status }` | Turn status: `thinking`, `processing`, `retrying` |
| `run.command` | `{ sessionId, runId, findingId, type, command }` | Command proposed |
| `run.step.completed` | `{ runId, sessionId, turn, projectFiles }` | Turn finished |
| `run.turn.audit` | `{ ... }` | Debug audit data |
| `ask.started` / `ask.completed` | `{ sessionId, model, prompt, ... }` | Ask lifecycle |
| `act.started` / `act.completed` | `{ sessionId, model, prompt, ... }` | Act lifecycle |
| `llm.request.started` / `completed` | `{ ... }` | LLM call lifecycle |
| `ui.render` | `{ sessionId, text, append }` | Streaming output |
| `ui.notify` | `{ sessionId, text, level }` | Toast notification |
| `ui.prompt` | `{ sessionId, runId, findingId, question, options }` | Model question |
| `editor.diff` | `{ sessionId, runId, findingId, type, file, patch, ... }` | Proposed edit |
| `rpc.started` | `{ method, params, id, sessionId }` | RPC call received |
| `rpc.completed` | `{ method, id, result }` | RPC call succeeded |
| `rpc.error` | `{ id, error }` | RPC call failed |

---

## Filters

Filters transform data through a chain. Each handler receives the current value
and returns the (possibly modified) value for the next handler.

```js
hooks.llm.messages.addFilter(async (messages, context) => {
    // Add a system message
    return [{ role: "system", content: "Extra context" }, ...messages];
}, 5);  // optional priority
```

| Hook | Value | Context | Purpose |
|---|---|---|---|
| `run.config` | Run config object | `{ sessionId }` | Modify run configuration |
| `llm.messages` | Message array | `{ model, sessionId, runId }` | Transform LLM input |
| `llm.response` | Response object | `{ model, sessionId, runId }` | Transform LLM output |
| `socket.message.raw` | Raw buffer | — | Transform incoming WebSocket data |
| `rpc.request` | Parsed request | — | Transform RPC request before dispatch |
| `rpc.response.result` | Result object | `{ method, id }` | Transform RPC response before sending |
| `agent.warn` | Warning rules array | `{ flags, tools, turnJson, finalResponse }` | Add/remove/modify warning rules |
| `agent.action` | Action table array | `{ flags, tools, turnJson, warnings, proposed }` | Add/remove/modify state table rules |

### Agent State Table Hooks

Plugins can modify the warning rules and action table that control the Rumsfeld Loop:

```js
// Add a custom warning
hooks.agent.warn.addFilter(async (rules, context) => {
    rules.push({
        when: context.tools.length > 10,
        msg: "Too many tools in one turn. Consider breaking the work into smaller steps.",
    });
    return rules;
});

// Add a custom action rule (inserted before the fallback)
hooks.agent.action.addFilter(async (table, context) => {
    // Insert before the last rule (the fallback)
    table.splice(-1, 0, {
        when: context.someCondition,
        action: "continue",
    });
    return table;
});
```

---

## Examples

### Custom Tool Plugin

```js
export default class WeatherPlugin {
    static register(hooks) {
        hooks.tools.register("weather", {
            modes: new Set(["ask", "act"]),
            category: "act",  // creates a finding for client resolution
        });
    }
}
```

The model can now use `- [ ] weather: London # check forecast`.
FindingsManager processes the tool invocation into a finding.

### Custom RPC Method Plugin

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

Clients can now call `getStats` via JSON-RPC. It appears in `discover` automatically.

### Context Injection Plugin

```js
export default class TimestampPlugin {
    static register(hooks) {
        hooks.onTurn(async (rummy) => {
            const el = rummy.tag("timestamp", {}, [new Date().toISOString()]);
            rummy.contextEl.appendChild(el);
        }, 99);  // low priority = runs last
    }
}
```

Every turn's context will include `<timestamp>2026-03-27T...</timestamp>`.
