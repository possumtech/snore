# PLUGINS.md — Plugin Development Guide

Every `<tag>` the model sees is a plugin. Every scheme is registered by
its owner. Every operation — model, client, plugin — flows through the
same tool handler. Exceptions to that discipline must justify themselves
in the architecture spec (SPEC.md).

## Quickstart

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
        core.on("visible", this.full.bind(this));
        core.on("summarized", this.summary.bind(this));
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
            state: "resolved",
            attributes: { path: entry.path },
        });
    }

    full(entry) { return entry.body; }
    summary(entry) { return ""; }
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

## Plugin Contract {#plugins_contract}

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
        core.on("visible", this.full.bind(this));
        core.on("summarized", this.summary.bind(this));
        core.filter("instructions.toolDocs", async (docsMap) => {
            docsMap.mytool = docs;
            return docsMap;
        });
    }

    async handler(entry, rummy) {
        // What the tool does (rummy is per-turn RummyContext)
    }

    full(entry)    { return entry.body; }
    summary(entry) { return entry.body; }
}
```

File naming: `src/plugins/mytool/mytool.js`. Class name = file name.
Tool docs: `src/plugins/mytool/mytoolDoc.js` (annotated line arrays).

External plugins install via npm and load via `RUMMY_PLUGIN_*` env vars:

```env
RUMMY_PLUGIN_WEB=@possumtech/rummy.web
RUMMY_PLUGIN_REPO=@possumtech/rummy.repo
```

## Unified API {#plugins_unified_api}

Three tiers share the tool vocabulary, but the invocation shape and
dispatch path differ.

```
Model:   <rm path="file.txt"/>               → { name: "rm", path: "file.txt" }
                                             → TurnExecutor.#record()
                                             → hooks.tools.dispatch("rm", entry, rummy)
Client:  { method: "rm", params: {...} }     → rpc.js #dispatchRm(...)
                                             → Entries.rm({...})
Plugin:  rummy.rm(path) / rummy.set({...})   → Entries.set / Entries.rm
                                             → (Entries also fires entry events)
```

Three surfaces, one grammar (see [surfaces](SPEC.md#surfaces)). The model dispatches through
the handler chain (`TurnExecutor.#record()` → `hooks.tools.dispatch`
→ policy filter → turn-scoped recording → abort cascade → budget
lifecycle around it). The client primitives (`set`/`get`/`rm`/`cp`/
`mv`/`update` RPCs) talk directly to Entries — `writer: "client"`
on every call, permissions enforced per-scheme. Plugins use
RummyContext verbs; the `rummy.entries` accessor is a Proxy that
auto-binds `writer: rummy.writer` on every write, so a plugin writing
on behalf of the model gets `writer: "model"` without opt-in.

Plugin code wanting full handler semantics (policy filter, proposal
flow, turn recording) calls `hooks.tools.dispatch` directly instead
of going through a primitive.

Verb signatures vary. See [plugins_rummy_verbs](#plugins_rummy_verbs).

## Registration {#plugins_registration}

All registration happens in the constructor via `core.on()`,
`core.filter()`, `core.ensureTool()`, and `core.registerScheme()`.

### core.ensureTool() {#plugins_ensure_tool}

Declares this plugin as a model-facing tool. Required for the tool
to appear in the model's tool list. Called automatically by
`core.on("handler", ...)` but must be called explicitly for tools
without handlers (e.g., `update`, `unknown`).

### core.registerScheme(config?) {#plugins_register_scheme}

Registers this plugin's scheme in the database. Called once in the
constructor.

```js
core.registerScheme({
    name:         "mytool",                     // defaults to plugin name
    modelVisible: 1,                            // 1 or 0 — appears in v_model_context
    category:     "logging",                    // "data" | "logging" | "unknown" | "prompt"
    scope:        "run",                        // "run" | "project" | "global" — default scope
    writableBy:   ["model", "plugin"],          // subset of: system | plugin | client | model
});
```

All fields optional. `core.registerScheme()` with no args gives a
sensible result-type scheme (logging category, run scope, writable by
model + plugin).

`scope` determines where entries at this scheme land (see
[entries](SPEC.md#entries) / [physical_layout](SPEC.md#physical_layout)).
`writableBy` is enforced at `Entries.set` — writes from a writer
not in the list throw a typed `PermissionError` (importable from
`src/agent/errors.js`). The four writer tiers
(see [writer_tiers](SPEC.md#writer_tiers)) form
a strict hierarchy: **system > plugin > client > model**. Each tier
is a superset of what's below.

### core.on(event, callback, priority?) {#plugins_on}

| Event | Payload | Purpose |
|-------|---------|---------|
| `"handler"` | `(entry, rummy)` | Tool handler — called when model/client invokes this tool |
| `"visible"` | `(entry)` | Visible-visibility projection — body shown in `<knowns>` / `<performed>` |
| `"summarized"` | `(entry)` | Summarized-visibility projection — path + summary only (body hidden) |
| `"turn.started"` | `({rummy, mode, prompt, loopIteration, isContinuation})` | Turn beginning — plugins write prompt/instructions entries |
| `"turn.response"` | `({rummy, turn, result, responseMessage, content, commands, ...})` | LLM responded — write audit entries, commit usage |
| `"proposal.prepare"` | `({rummy, recorded})` | Tool dispatched — materialize proposals (e.g. file edit 202 revisions) |
| `"proposal.pending"` | `({projectId, run, proposed})` | Proposal awaits client resolution |
| `"turn.completed"` | `(turnResult)` | Turn resolved — full turnResult |
| `"entry.created"` | `(entry)` | Entry created during dispatch |
| `"entry.changed"` | `({runId, path, changeType})` | Entry content, visibility, or status modified |
| `"run.state"` | `({projectId, run, turn, status, summary, history, unknowns, telemetry})` | Incremental client-facing state push (wire-layer `status` HTTP code stays; DB stores the 5-value state enum) |
| `"error.log"` | `({runId, turn, loopId, message})` | Runtime error — creates an `error://` entry |
| Any `"dotted.name"` | varies | Resolves to the matching hook in `src/hooks/Hooks.js` |

```js
// One-liner examples
core.on("handler", async (entry, rummy) => { /* tool logic */ });
core.on("visible", (entry) => entry.body);
core.on("summarized", (entry) => entry.attributes?.summary || "");
core.on("turn.started", async ({ rummy, mode }) => { /* write entries */ });
core.on("turn.response", async ({ rummy, result }) => { /* audit */ });
core.on("entry.changed", ({ runId, path, changeType }) => { /* react */ });
```

### core.filter(name, callback, priority?) {#plugins_filter}

| Filter | Signature | Purpose |
|--------|-----------|---------|
| `"instructions.toolDocs"` | `(docsMap) → docsMap` | Add tool documentation (docsMap pattern) |
| `"assembly.system"` | `(content, ctx) → content` | Contribute to system message |
| `"assembly.user"` | `(content, ctx) → content` | Contribute to user message |
| `"llm.messages"` | `(messages) → messages` | Transform final messages before LLM call |
| `"llm.response"` | `(response) → response` | Transform LLM response |
| `"llm.reasoning"` | `(reasoning, {commands}) → reasoning` | Contribute to `reasoning_content` (the think plugin subscribes here to merge `<think>` tag bodies) |
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
    toolSet,           // Set<string> of active tool names for this loop
    contextSize,       // Model context window size
    lastContextTokens, // Actual API tokens from the prior turn (0 on turn 1)
    turn,              // Current turn number
}
```

#### Filter Priority Bands {#plugins_filter_bands}

Filters run in ascending priority order. The packet renders in
top-to-bottom order matching that — lower priority appears earlier in
the message. Current `assembly.user` registrations:

| Priority | Block | Plugin | Mutates per turn? |
|---|---|---|---|
| 50 | `<summary>` | `known.js` | Slow — only on new entry |
| 75 | `<visible>` | `known.js` | Fast — on every promote/demote |
| 100 | `<log>` | `log.js` | Always — appends per action |
| 200 | `<unknowns>` | `unknown.js` | On unknown lifecycle |
| 250 | `<instructions>` | `instructions.js` | On phase transition |
| 275 | `<budget>` | `budget.js` | Every turn (live) |
| 300 | `<prompt>` | `prompt.js` | Stable within a loop |

**Recommended ranges for new plugins** (for cache-friendly placement
and predictable rendering position):

| Range | Position | Use for |
|---|---|---|
| `0–49` | Top of user | Reserved (stable identity-tier blocks above `<summary>`) |
| `50–99` | Codebase data surface | Don't add here — owned by `known.js` |
| `100–149` | History tier | Action history, timeline-style content |
| `150–199` | Open slot | Inter-history blocks (e.g. recent-decisions, tracked progress) |
| `200–249` | State tier | Model state (open questions, work-in-progress) |
| `250–299` | Phase + budget | Avoid; current phase / budget arithmetic owned here |
| `300–349` | Task | Reserved for prompt-tier content |
| `350–999` | Bottom | Append-after-prompt content (rare; usually wrong) |

Within a band, lower priority = renders higher. Pick the smallest
priority that lands you in the right band and leaves room above and
below.

`assembly.system` currently has no registrations — system message is
the static identity surface (instructions base + tool docs). Adding
to `assembly.system` invalidates the system-prefix cache on whatever
provider you target; reserve for content that's truly stable per-run.

### Tool Docs {#plugins_tool_docs}

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

### handler(entry, rummy) {#plugins_handler}

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

#### Reporting outcomes {#plugins_handler_outcomes}

**The action entry IS its outcome.** Your handler finalizes the action's
own log entry at `entry.resultPath`. Success and failure are two values
of the same shape — body, state, outcome. The model sees both through
the same channel under your tool's scheme:

```js
async handler(entry, rummy) {
    const { entries: store, runId, turn, loopId } = rummy;
    const result = await runMyTool(entry.attributes);

    if (result.failed) {
        await store.set({
            runId, turn, loopId,
            path: entry.resultPath,
            body: result.failureMessage,
            state: "failed",
            outcome: result.label,    // "not_found", "validation", etc.
        });
        return;
    }

    await store.set({
        runId, turn, loopId,
        path: entry.resultPath,
        body: result.output,
        state: "resolved",
    });
}
```

That's the whole failure-reporting surface. Body is the result on
success, the failure message on failure. State labels the verdict
(`resolved` / `failed`). Outcome is a short machine-readable label.

The framework reads the post-handler state of every recorded entry
each turn; any `state="failed"` result counts as a strike toward
`MAX_STRIKES`. You don't need to do anything else to make the strike
fire — write the entry's outcome and the framework follows.

You do **not** call `hooks.error.log.emit` from a tool handler. That
hook is reserved for the framework's actionless-failure cases (parser
warnings, dispatch crashes, runtime watchdog, budget overflow) — none
of which a third-party plugin should be writing.

If your handler throws, the framework catches and emits a status-500
error entry on your behalf. That's the one case where the framework
writes for you. Throw with intent; don't try-catch your own handler
just to avoid a stack trace.

See SPEC [failure_reporting](SPEC.md#failure_reporting) for the
full contract and the rationale.

### full(entry) / summary(entry) {#plugins_views}

Returns the string the model sees for this tool's entries at the
given visibility. Every tool MUST register `full`. `summary` is
optional — if unregistered, falls back to `attributes.tags`
(model-authored keyword description) or empty string.

At summary visibility, `attributes.tags` is prepended above the
plugin's summary output automatically by ToolRegistry.view().

## Two Objects {#plugins_two_objects}

Plugins interact with two objects at different scopes:

**PluginContext** (`core`) — startup-scoped. Created once per plugin.
Used for registration (`on()`, `filter()`, `registerScheme()`,
`ensureTool()`). Available as `this.#core` throughout the plugin's
lifetime.

**RummyContext** (`rummy`) — turn-scoped. Passed to handlers per
invocation. Has tool verbs, per-turn state, database access.

### Tool Verbs (on RummyContext) {#plugins_rummy_verbs}

Convenience wrappers that bind `runId`, `turn`, `loopId` from context
and delegate to Entries. Signatures vary per verb. For full
handler-chain semantics (policy filtering, proposal flow, abort
cascade), call `rummy.hooks.tools.dispatch(scheme, entry, rummy)`
instead.

| Method | Effect |
|--------|--------|
| `rummy.set({ path?, body?, state?, visibility?, outcome?, attributes? })` | Create/update entry. If `path` omitted, slugifies from body/summary. State defaults to `"resolved"`. |
| `rummy.get(path)` | Promote entries matching a pattern (default visibility `"visible"`). |
| `rummy.rm(path)` | Remove entry's view. |
| `rummy.mv(from, to)` | Rename entry. |
| `rummy.cp(from, to)` | Copy entry to a new path. |
| `rummy.update(body, { status?, attributes? })` | Write the once-per-turn lifecycle signal to `update://<slug>`. |

### Query Methods {#plugins_rummy_queries}

| Method | Returns |
|--------|---------|
| `rummy.getBody(path)` | Body text or null |
| `rummy.getState(path)` | Categorical state (`"proposed"` \| `"streaming"` \| `"resolved"` \| `"failed"` \| `"cancelled"`) or null |
| `rummy.getOutcome(path)` | Outcome string (populated when state ∈ {failed, cancelled}) or null |
| `rummy.getAttributes(path)` | Parsed attributes `{}` or null |
| `rummy.getEntry(path)` | First matching entry or null |
| `rummy.getEntries(pattern, bodyFilter?)` | Array of matching entries |
| `rummy.setAttributes(path, attrs)` | Merge attributes via json_patch |
| `rummy.entries.logPath(runId, turn, action, target)` | Build a `log://turn_N/<action>/<slug>` path, slugified + collision-safe |
| `rummy.entries.slugPath(runId, scheme, content, summary?)` | Build a `<scheme>://<slug>` path, slugified + collision-safe |

#### Path conventions {#plugins_path_conventions}

Entry paths are bounded by a hard `length(path) <= 2048` DB
CHECK constraint. In normal use, paths stay well under ~100 chars
because plugins build them via `logPath` / `slugPath`, which run the
target through `slugify` (80-char cap, `/` preserved as separator,
URL-encoded per segment) and append an integer tie-breaker on
collision (e.g. `log://turn_3/set/src/app.js_2`).

Plugin authors should pass any model-supplied target straight
through these helpers instead of stitching paths from the model's
raw input. The helpers absorb arbitrary target length and exotic
character composition without the caller having to defend against
either. The 2048 limit is the outer wall, not the working budget.

### Properties {#plugins_rummy_properties}

| Property | Type | Notes |
|----------|------|-------|
| `rummy.entries` | Entries proxy | Write calls auto-carry `writer: rummy.writer`. Read-through for reads + internal ops. |
| `rummy.db` | SqlRite db | Prefer `entries` for plugin-facing data access |
| `rummy.hooks` | Hook registry | |
| `rummy.runId` | number | Current run |
| `rummy.projectId` | number | |
| `rummy.sequence` | number | Current turn number |
| `rummy.loopId` / `rummy.turnId` | number | |
| `rummy.type` | `"ask"` \| `"act"` | Current mode |
| `rummy.toolSet` | Set<string> \| null | Active tool list for this loop |
| `rummy.contextSize` | number \| null | Model context window |
| `rummy.systemPrompt` / `rummy.loopPrompt` | string | |
| `rummy.noRepo` / `rummy.noInteraction` / `rummy.noWeb` | boolean | Loop flags |
| `rummy.writer` | `"system"` \| `"plugin"` \| `"client"` \| `"model"` | Default `"model"` in handler dispatch. The Proxy on `rummy.entries` binds this to every write for permission checks (see [writer_tiers](SPEC.md#writer_tiers)). |

## Tool Display Order {#plugins_display_order}

Tools are presented to the model in priority order:
gather → reason → act → communicate.

Defined in `ToolRegistry.TOOL_ORDER`. `resolveForLoop(mode, flags)`
handles all exclusions:

| Condition | Excludes |
|-----------|----------|
| `mode === "ask"` | `sh` |
| `noInteraction` flag | `ask_user` |
| `noWeb` flag | `search` |
| `noProposals` flag | `ask_user`, `env`, `sh` |

## Hedberg {#plugins_hedberg}

Hedberg has two faces. The implementation is a **library** at
`src/lib/hedberg/` — pattern matching, sed parsing, edit detection,
unified-diff generation. Internal plugins import these utilities
directly:

```js
import { hedmatch, hedsearch } from "../../lib/hedberg/patterns.js";
import { parseSed } from "../../lib/hedberg/sed.js";
import Hedberg, { generatePatch } from "../../lib/hedberg/hedberg.js";
```

A thin **plugin shim** at `src/plugins/hedberg/` re-exposes the same
surface on `core.hooks.hedberg` for external plugins shipped in
separate packages (`rummy.repo`, `rummy.web`, etc.) that can't reach
into rummy/main's internals via direct import.

```js
const { match, search, replace, parseSed, parseEdits,
    generatePatch } = core.hooks.hedberg;
```

| Method | Purpose |
|--------|---------|
| `match(pattern, string)` | Full-string pattern match (glob, regex, literal) |
| `search(pattern, string)` | Substring search |
| `replace(body, search, replacement, opts?)` | Apply replacement |
| `parseSed(input)` | Parse sed syntax (any delimiter) |
| `parseEdits(content)` | Detect edit format (merge conflict, udiff, sed) |
| `generatePatch(path, old, new)` | Generate unified diff |

**The split is intentional.** `src/lib/` is for stateless utility
modules anyone in the project can import. `src/plugins/` is for
contracts exposed via the hook system. Hedberg is one of the few
modules that has both shapes — same code, two access paths, one for
internal consumers and one for cross-package consumers.

## Events & Filters {#plugins_events_overview}

**Events** are fire-and-forget. All handlers run. Return values ignored.
**Filters** transform data through a chain. Lower priority runs first.
All hooks are async.

### Project Lifecycle {#plugins_project_lifecycle}

| Hook | Type | When |
|------|------|------|
| `project.init.started` | event | Before project DB upsert |
| `project.init.completed` | event | After project created |

### Run & Loop Lifecycle {#plugins_run_loop_lifecycle}

| Hook | Type | When |
|------|------|------|
| `run.created` | event | Run just created in DB |
| `ask.started` | event | Run requested in ask mode |
| `act.started` | event | Run requested in act mode |
| `loop.started` | event | Loop execution beginning |
| `run.config` | filter | Before run config applied |
| `run.progress` | event | Transient turn activity (`thinking` / `processing` / `retrying`) |
| `run.state` | event | Turn conclusion, per-command incremental, or terminal run close — full state snapshot (status, history, unknowns, telemetry) |
| `turn.verdict` | filter | Post-turn decision: continue / abandon / strike. Filter chain — multiple plugins (strike streak, cycle detect, stagnation today; future voters can join) each transform a verdict object. Initial value `{ continue: true }`; final value drives the loop's continue/abandon decision. |
| `run.step.completed` | event | Turn verdict resolved (post-healer, pre-close) |
| `loop.completed` | event | Loop exit — fires from `finally`, guaranteed on every exit path |
| `ask.completed` | event | Ask-mode run finished |
| `act.completed` | event | Act-mode run finished |
| `proposal.prepare` | event | Per recorded entry — plugins materialize proposals (e.g. set plugin turns search/replace revisions into 202 entries) |
| `proposal.pending` | event | A materialized proposal awaits client resolution |

### Turn Pipeline {#plugins_turn_pipeline}

Hooks fire in this order every turn. Type column legend:
**event** = fire-and-forget, all handlers run, no return value;
**filter** = chain transform, ordered by priority, return value carries forward;
**call** = direct named-method invocation on a specific plugin.
Exceptions for `call`-shaped hooks are documented under
[Architectural exceptions](#plugins_architectural_exceptions).

| # | Hook | Type | When |
|---|------|------|------|
| 1 | `turn.started` | event | Plugins write prompt/instructions entries |
| 2 | `instructions.resolveSystemPrompt` | call ⚠ | System prompt assembly — single-owner exception (cache stability) |
| 3 | `context.materialized` | event | turn_context populated from v_model_context |
| 4 | `assembly.system` | filter | Build system message from entries (called from inside `materializeContext`) |
| 5 | `assembly.user` | filter | Build user message (prompt plugin adds `<prompt tokensFree tokenUsage>`) |
| 6 | `turn.beforeDispatch` | filter | Measure assembled tokens; if over and turn 1, demote prompt, re-materialize, re-check; still over → 413. Filter chain on the dispatch packet `{ messages, rows, contextSize, lastPromptTokens, assembledTokens, ok, overflow }`. Budget participates here; future plugins may trim, re-order, or annotate via the same surface. `ok=false` short-circuits dispatch. |
| 7 | `llm.messages` | filter | Transform messages before LLM call |
| 8 | `llm.request.started` | event | LLM call about to fire |
| 9 | (LLM completion call) | — | Direct provider call. Errors caught: ContextExceededError → 413; TimeoutError/AbortError → 504 strike (unless drain). |
| 10 | `llm.response` | filter | Transform raw LLM response |
| 11 | `llm.request.completed` | event | LLM call finished |
| 12 | (XML parse + parser-warning emission) | — | Synchronous; warnings emitted via `error.log` with `soft: true` — recoverable, no strike |
| 13 | `llm.reasoning` | filter | Layer plugin reasoning contributions onto API-provided seed (used by `<think>` plugin to merge content-channel thinking into reasoning_content) |
| 14 | `turn.response` | event | Plugins write audit entries (telemetry) |
| 15 | `entry.recording` | filter | Per command, during `#record()`. Returning an entry with `state: "failed"` (or `"cancelled"`) rejects it. |
| 16 | Per recorded entry (sequential, abort-on-failure): | | |
|    | `tool.before` | event | Before handler dispatch |
|    | `tools.dispatch` | call (keyed) | Scheme's registered handler runs. Keyed dispatch is principled — multi-plugin contract by scheme name. |
|    | `tool.after` | event | Handler finished |
|    | `entry.created` | event | Entry written to store |
|    | `run.state` | event | Incremental state push to connected clients |
|    | `proposal.prepare` | event | This entry's dispatch may have created proposals (e.g. set → 202 revisions) |
|    | `proposal.pending` | event | Per each materialized proposal — client is notified, dispatch awaits resolution |
| 17 | `turn.dispatched` | event | Post-dispatch cleanup. Budget subscribes for Turn Demotion (visibility=summarized on visible rows that overflow) + 413 `error://` emission via `hooks.error.log.emit`. Future plugins may subscribe for any post-dispatch concern. |
| 18 | `update.resolve` | call ⚠ | Update plugin classifies this turn's `<update>` (terminal/continuation, override-to-continuation if actions failed, heal from raw content if missing). Single-owner exception — synchronous return value (`{ summaryText, updateText }`) is load-bearing. |
| 19 | `turn.completed` | event | Turn fully resolved with final status |

**Legend:** ⚠ = load-bearing exception (kept by design, see below); ✗ = refactor candidate (ceremonial coupling).

### Architectural exceptions {#plugins_architectural_exceptions}

The plugin contract aims for **events for emit, filters for transform,
keyed dispatch for multi-plugin lookups by category**. Five points
intentionally deviate. They're documented here so they aren't
mistaken for ceremony and "fixed" in a way that breaks the
load-bearing reason.

**1. `instructions.resolveSystemPrompt(rummy)` — single-owner, cache-stable.**
The system prompt is deliberately not a filter chain. Multiple
participants would defeat prefix-cache reasoning ("Static base in
system, phase-specific in user," see AGENTS.md instruction
discipline). One plugin owns the surface; direct call enforces it.

**2. `update.resolve({ recorded, ... })` — single-owner with
synchronous return value.** Caller (`TurnExecutor`) needs
`{ summaryText, updateText }` back to drive the resolve callback.
Events emit but don't return; only the update plugin understands
terminal-vs-continuation status semantics. Filter-chain shape
would only have one element (still update), so the chain would be
ceremony.

**3. Static utility imports across plugins
(`Entries.scheme`, `Entries.normalizePath`, `countTokens`,
`stateToStatus`).** Pure stateless utilities. Routing through
hooks adds a ceremony layer for zero capability gain — these aren't
extension points; they're canonical implementations.

**4. Hedberg lib + thin plugin shim.** The library lives at
`src/lib/hedberg/` (pattern matching, sed parsing, merge handling).
A thin plugin shim at `src/plugins/hedberg/hedberg.js` re-exposes
the same surface on `core.hooks.hedberg` for external plugins
(rummy.repo, rummy.web) that can't reach into rummy/main's
internals via direct import. Internal plugins use direct imports
from `src/lib/hedberg/`; external plugins use the hook namespace.
See [Hedberg](#plugins_hedberg) for the API table.

**5. Transport plugins (`cli`, `rpc`).** These are *interface*
plugins, not action plugins. Their job is to bridge external
interfaces (stdin/stdout, WebSocket) to the agent. Direct imports
of `ProjectAgent` / `RummyContext` are what makes them transports;
fitting them into the action-plugin shape would require running
the agent over a back-channel to itself.

**Anything else that looks like a direct named call into a plugin
is a seam, not an exception** — see the ✗-marked entries in the
Turn Pipeline above. Refactor surface tracked in AGENTS.md "Now"
under Phase 2.

`entry.changed` fires asynchronously from mutation points — not
pipeline-ordered. Subscribe when you need to react to any entry
modification (used by budget remeasurement and file-on-disk detection).

### Entry Events {#plugins_entry_events}

| Hook | Type | When |
|------|------|------|
| `entry.recording` | filter | Before entry stored. Return `{ state: "failed", outcome }` to reject. |
| `entry.created` | event | New entry added during dispatch |
| `entry.changed` | event | Entry content, visibility, or state modified |

`entry.recording` is a filter — plugins can validate, transform, or
reject entries before they hit the store. Payload:
`{ scheme, path, body, attributes, state, outcome }`. Second arg is
a context bag: `{ store, runId, turn, loopId, mode }`. Return the
entry object (modified or not). Set `state: "failed"` with an
`outcome` string (e.g. `"permission"`, `"validation"`) to reject —
the policy plugin uses this pattern for ask-mode rejections.

`entry.changed` fires on any mutation to an existing entry — body
update, visibility change, state change, attribute update. Payload:
`{ runId, path, changeType }`. Subscribers include the budget plugin
(remeasure context) and the repo plugin (detect file changes on disk).

### Budget {#plugins_budget}

| Hook | Type | When |
|------|------|------|
| `turn.beforeDispatch` filter | subscriber | Pre-LLM ceiling check on the dispatch packet. On first-turn 413 → Prompt Demotion + re-check; sets `ok=false` + `overflow` to short-circuit dispatch. |
| `turn.dispatched` event | subscriber | Post-dispatch re-check. On 413 → Turn Demotion + 413 `error://` entry via `hooks.error.log.emit`. |
| `assembly.user` filter | subscriber | Renders `<budget>` table into the user message. |

The budget plugin measures tokens on the assembled messages — the
actual content being sent to the LLM. No estimates at the ceiling,
no SQL token sums. The assembled message IS the measurement. When
turn 2+ information is available, the pre-LLM check prefers the
actual API-reported token count (`turns.context_tokens` from the
prior turn) over re-measuring the assembled string.

**Use of the assembler.** Budget calls the context assembler in two
spots — these are projections, not orchestration leaks:

- **Pre-LLM Prompt Demotion (`turn.beforeDispatch`)** — when the
  first-turn packet overflows, budget demotes the prompt entry in
  the DB, swaps `body` from `vBody` to `sBody` on the local prompt
  row, and re-runs `ContextAssembler.assembleFromTurnContext` on
  the modified rows. No `materializeContext` round-trip — the row
  already carries both projections.
- **Post-dispatch projection (`turn.dispatched`)** — budget re-runs
  `materializeContext` to project the *next* turn's packet
  (entries written during dispatch need projection through
  `hooks.tools.view`). If predicted next packet overflows, budget
  demotes now so next turn's enforce isn't stuck with only the
  prompt-demotion lever. Cost projection is the budget plugin's
  job; the assembler is the measurement instrument.

**DB tokens vs assembled tokens:** The `tokens` column on `entries`
is strictly for DISPLAY — showing token costs in `<knowns>` tags so
the model can reason about entry sizes. It is NEVER used for budget
decisions. Budget math uses only assembled message token counts.
These are two separate numbers that must never be conflated. See
See [budget_enforcement](SPEC.md#budget_enforcement) for the three-measure table.

### Client Notifications {#plugins_client_notifications}

| Hook | Type | When |
|------|------|------|
| `ui.render` | event | Text for client display |
| `ui.notify` | event | Status notification |

## Entry Lifecycle {#plugins_entry_lifecycle}

Every entry follows the same lifecycle regardless of origin:

1. **Created** — `entries` row (content) + `run_views` row (per-run
   projection) via the two-prep upsert flow (see [physical_layout](SPEC.md#physical_layout)).
2. **Dispatched** — tool handler chain executes.
3. **State set** — handler sets `state` (`"proposed"` \| `"streaming"`
   \| `"resolved"` \| `"failed"` \| `"cancelled"`) + optional
   `outcome` string on the `run_views` row. State is view-side; body
   is content-side. (See [entries](SPEC.md#entries).)
4. **Materialized** — `v_model_context` joins entries + run_views,
   projects into `turn_context`.
5. **Assembled** — filter chain renders into system/user messages.
   Model-facing tags carry `status="NNN"` (HTTP code) via
   `src/agent/httpStatus.js`'s state-to-HTTP mapping — the model's
   vocabulary is HTTP; the DB is categorical.
6. **Visible** — model sees the entry in its context.

Entries at `visibility = 'archived'` skip steps 4–6 (invisible to
model, discoverable via pattern search). Entries at `visibility =
'summarized'` render with `attributes.tags` (model-authored keyword
description) prepended above the plugin's `summarized` view output —
the body is hidden; promoting with `<get>` brings it back.

**Per-plugin visibility projection reference.** Each plugin chooses
what its `visible` / `summarized` view hooks return. Renderers trust
the projected body — they do NOT re-check `entry.visibility`.

| Plugin | Category | `visible` body | `summarized` body | Notes |
|--------|----------|-----------------|----------------|-------|
| `known` | data | `entry.body` | `""` | Tag's `summary` attr carries the keywords at summarized visibility |
| `unknown` | unknown | `entry.body` | `""` | Same pattern as known |
| `prompt` | prompt | `entry.body` | 500-char truncation with `[truncated — promote to see the complete prompt]` marker | |
| `budget` | logging | `entry.body` | `entry.body` | Feedback signal — kept visible |
| `update` | logging | `# update\n${entry.body}` | same as visible | Already 80-char capped by tool doc rule |
| `get` / `set` / `rm` / `cp` / `mv` / `sh` / `env` / `search` | logging | result body | `""` | Just the self-closing tag at summarized |
| `skill` | data | `entry.body` | `""` | Same as known |
| `file` (bare paths) | data | `entry.body` | `""` | Same as known |

Plugins providing only a `visible` hook fall back to
`attributes.tags` (model-authored keyword description) at summarized;
the renderer inserts it automatically. Plugins providing neither
default to empty body — the tag still renders with its attributes so
the model can pattern-match the path.

### Streaming Entries {#plugins_streaming_entries}

Producers whose output arrives over time (shell commands, web fetches,
log tails, file watches) use the **streaming entry pattern**. The
lifecycle extends beyond 202→200:

```
state: "proposed" (user decision pending)
  → accept → state: "resolved" (log entry: action happened)
           + state: "streaming" data entries (one per channel, growing)
                  → "resolved" / "failed" on completion
```

**Producer plugin contract:**

1. On dispatch, create a **proposal entry** at `{scheme}://turn_N/{slug}`
   with `state: "proposed"`, category=logging. Body empty;
   `tags=command` attr.
2. On user accept (client sends `set { state: "resolved" }` on the
   proposal path), `AgentLoop.resolve()` transitions the proposal
   entry to `state: "resolved"` (it becomes the **log entry**) and
   creates **data entries** at `{path}_1`, `{path}_2`, etc. with
   `state: "streaming"`, category=data, visibility=summarized, empty body.
3. Producer/client calls `stream { run, path, channel, chunk }` RPC
   to append chunks to the appropriate channel.
4. When the producer is done, `stream/completed { run, path, exit_code? }`
   transitions all `{path}_*` data entries to a terminal state
   (`"resolved"` on exit_code=0 or omitted; `"failed"` with outcome
   `"exit:N"` otherwise) and rewrites the log entry body with final
   stats. For client-initiated cancellation, the client calls
   `stream/aborted { run, path, reason? }` instead — transitions
   channels to `state: "cancelled"` with outcome=reason.

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

## Bundled Plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `get` | Core tool | Load file/entry into context |
| `set` | Core tool | Edit file/entry, visibility control |
| `known` | Core tool + Assembly | Save knowledge, render `<knowns>` section |
| `rm` | Core tool | Delete permanently |
| `mv` | Core tool | Move entry |
| `cp` | Core tool | Copy entry |
| `sh` | Core tool | Shell command (act mode only). Streaming producer — see [plugins_streaming_entries](#plugins_streaming_entries) |
| `env` | Core tool | Exploratory command. Streaming producer — see §8.1 |
| `stream` | Internal | Generic streaming-entry RPC (`stream`, `stream/completed`, `stream/aborted`, `stream/cancel`) for sh/env and future producers |
| `ask_user` | Core tool | Ask the user |
| `search` | Core tool | Web search (via external plugin) |
| `update` | Structural | Status report + lifecycle signal. `status="200\|204\|422"` terminates; `status="102"` continues. Exposes `hooks.update.resolve` for TurnExecutor. |
| `unknown` | Structural + Assembly | Register unknowns, render `<unknowns>` |
| `previous` | Assembly | Render `<previous>` loop history |
| `performed` | Assembly | Render `<performed>` active loop work |
| `prompt` | Assembly | Render `<prompt tokensFree="N" tokenUsage="M">` tag (with `warn=` in ask mode) |
| `hedberg` | Utility | Pattern matching, interpretation, normalization |
| `instructions` | Internal | Preamble + tool docs + persona assembly; exposes `hooks.instructions.resolveSystemPrompt` |
| `file` | Internal | File entry projections and constraints (`scheme IS NULL`) |
| `rpc` | Internal | RPC method registration + tool-fallback dispatch |
| `telemetry` | Internal | Audit entries, usage stats, reasoning_content |
| `budget` | Internal | Context ceiling enforcement: Prompt Demotion (pre-LLM first-turn 413) + Turn Demotion (post-dispatch). Subscribes to `turn.beforeDispatch` (filter) + `turn.dispatched` (event) + `assembly.user` (filter). |
| `policy` | Internal | Ask-mode per-invocation rejections via `entry.recording` filter |
| `error` | Internal | `error.log` hook → `error://` entries |
| `think` | Tool | Private reasoning tag; contributes to `reasoning_content` via the `llm.reasoning` filter |
| `openai` / `ollama` / `xai` / `openrouter` | LLM provider | Register with `hooks.llm.providers`; handle `{prefix}/...` model aliases. Silently inert if their env isn't configured. |
| `persona` / `skill` | Internal | Runtime persona/skill management via RPC |

## External Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Repo | `@possumtech/rummy.repo` | Git-aware file scanning and symbol extraction |
| Web | `@possumtech/rummy.web` | Web search and URL fetching via searxng |

Loaded via `RUMMY_PLUGIN_*` env vars. External plugins have access
to the same PluginContext API as bundled plugins.

## RPC Methods {#plugins_rpc}

Client-facing JSON-RPC 2.0 over WebSocket. Protocol version **2.0.0**.
The client surface is a thin projection of the plugin API (SPEC §0.3):
the six primitives match the plugin's `rummy.set` / `rummy.get` / etc.
exactly, plus a connection handshake and a few config verbs.

### Wire Format {#plugins_rpc_wire_format}

```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "set", "params": { "run": "my_run", "path": "known://fact", "body": "...", "state": "resolved" } }

// Success response
{ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }

// Error response
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32603, "message": "set: path is required" } }

// Notification (server → client, no id)
{ "jsonrpc": "2.0", "method": "run/state", "params": { "run": "my_run", "turn": 3, "status": 200, ... } }
```

### Connection Handshake {#plugins_rpc_handshake}

First call every client makes. Establishes project identity and
enforces protocol-version compatibility.

| Method | Params | Notes |
|--------|--------|-------|
| `rummy/hello` | `{ name, projectRoot, configPath?, clientVersion? }` | Returns `{ rummyVersion, projectId, projectRoot }`. Server rejects MAJOR mismatch with a protocol-mismatch error. |

### Primitives (see [primitives](SPEC.md#primitives)) {#plugins_rpc_primitives}

Six verbs. Object-args matching the entry grammar. Writer is fixed to
`"client"` server-side; permissions enforced per-scheme via the
scheme's `writable_by`.

| Method | Params | Notes |
|--------|--------|-------|
| `set` | `{ run, path, body?, state?, visibility?, outcome?, attributes?, append?, pattern?, bodyFilter? }` | Wide semantic: write content, change visibility/state, merge attributes, append (streaming), pattern update. Writing to `run://<alias>` starts or cancels a run (see §11.4). State transitions on proposed entries route through `AgentLoop.resolve()` for scheme-specific side effects. |
| `get` | `{ run, path, bodyFilter?, visibility? }` | Promote an entry (or pattern) to visible visibility. |
| `rm` | `{ run, path, bodyFilter? }` | Remove entry's view. |
| `cp` | `{ run, from, to, visibility? }` | Copy entry to new path. |
| `mv` | `{ run, from, to, visibility? }` | Rename entry. |
| `update` | `{ run, body, status?, attributes? }` | Write the once-per-turn lifecycle signal to `update://<slug>`. |

### Run Lifecycle via Primitives {#plugins_rpc_run_lifecycle}

Runs are addressable as `run://<alias>` entries (SPEC §0.5). The
client manipulates run lifecycle via ordinary `set` calls:

| Action | Call |
|--------|------|
| Start a run (named) | `set { path: "run://<alias>", body: <prompt>, attributes: { model, mode?, persona?, temperature?, contextLimit?, noRepo?, noInteraction?, noWeb?, noProposals? } }` |
| Start a run (anonymous) | `set { path: "run://", body: <prompt>, attributes: { model, ... } }` — server synthesizes alias as `${model}_${unixEpochMs}` and returns it in the response |
| Cancel a run | `set { path: "run://<alias>", state: "cancelled" }` |
| Inject continuation | `set { path: "run://<alias>", body: <message> }` on an existing run |
| Accept a proposal | `set { run, path: "<entry>", state: "resolved", body?: <output> }` |
| Reject a proposal | `set { run, path: "<entry>", state: "cancelled", body?: <reason> }` |

Starting a new run is fire-and-forget: server returns `{ ok: true, alias }`
immediately; client watches the run's state transitions via the
`run/state` notification (and the `run://` entry itself).

### Config & Query Methods {#plugins_rpc_queries}

Not every server capability fits the entry grammar. These are
dedicated verbs with 1:1 plugin-API equivalents.

| Method | Params | Notes |
|--------|--------|-------|
| `ping` | — | Liveness check |
| `discover` | — | Return the live RPC catalog |
| `getModels` / `addModel` / `removeModel` | (see rpc.js) | Model aliases |
| `getRuns` / `getRun` | `{ limit?, offset? }` / `{ run }` | Run listing and detail |
| `getEntries` | `{ run, pattern?, scheme?, state?, visibility?, bodyFilter? }` | Read-only entry query. Returns `[{path, scheme, state, visibility, attributes, turn, tokens}]`. No promotion side-effect. Pair with `get` primitive (which is a write verb). |
| `file/constraint` | `{ pattern, visibility }` | Project-scoped: set overlay. `visibility ∈ {active, readonly, ignore}`. Patterns can be globs. `readonly` is enforced on `set://` accept in `AgentLoop.resolve()`. |
| `file/drop` | `{ pattern }` | Project-scoped: remove overlay row. |
| `getConstraints` | — | Project-scoped: returns `[{pattern, visibility}]`. |
| `skill/add` / `skill/remove` / `getSkills` / `listSkills` | | Skill management |
| `persona/set` / `listPersonas` | | Persona management |
| `stream` / `stream/completed` / `stream/aborted` / `stream/cancel` | | Streaming RPC (§8.1) |

**Why file constraints are typed RPCs and not `set` entries:** they
are project-scoped (no `run`), persist across runs, and `readonly`
requires enforcement server-side on `set://` accept. Every `set`
primitive call requires a run alias; constraints don't have one. The
typed verbs match the capability's actual shape rather than contorting
the grammar.

### Notifications (server → client) {#plugins_rpc_notifications}

| Method | Purpose |
|--------|---------|
| `run/state` | Incremental state push per tool dispatch |
| `run/proposal` | A proposed entry awaits client resolution |
| `stream/cancelled` | Server-initiated streaming cancellation |
| `ui/render` | Streaming UI output |
| `ui/notify` | Toast notification |

### Retired Methods (2.0.0)

Protocol 1.x shipped many methods that collapsed into the primitive
grammar. Clients migrating from 1.x need to replace the following:

| 1.x method | Replacement |
|------------|-------------|
| `init` | `rummy/hello` |
| `ask` / `act` / `startRun` | `set { path: "run://<alias>", body: <prompt>, attributes: { model, mode, ... } }` |
| `run/resolve` | `set { run, path, state, body? }` |
| `run/abort` / `run/cancel` | `set { path: "run://<alias>", state: "cancelled" }` |
| `run/rename` | `mv { run, from: "run://<old>", to: "run://<new>" }` |
| `run/inject` | `set { path: "run://<alias>", body: <message> }` on an existing run |
| `run/config` | `set { path: "run://<alias>", attributes: { ... } }` |
| `store` (demote) | `set { run, path, visibility: "summarized", pattern: true }` |
| `getEntries` | Kept as §11.5 typed helper — now filter-capable (scheme/state/visibility). Pairs with the `get` write primitive. |
| `get { persist }` / `store { persist, clear, ignore }` (file constraints) | `file/constraint { pattern, visibility }` and `file/drop { pattern }`. Project-scoped helpers in §11.5 with real server enforcement for `readonly`. |
