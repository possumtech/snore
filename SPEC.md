# RUMMY: Architecture Specification

The authoritative reference for Rummy's design. The sacred prompt
The instructions plugin (`preamble.md` + tool docs) defines
model-facing behavior. This document defines everything else.

---

## The Contract

Rummy has one contract. Every actor speaks it.

### Entries {#entries}

An entry is the sole unit of state the contract names. Every entry
carries:

| Field | Meaning |
|-------|---------|
| **path** | Identity. `scheme://locator` or bare filepath. |
| **body** | Content (text). |
| **attributes** | JSON bag of structured metadata. |
| **visibility** | `visible \| summarized \| archived`. What the model sees of this entry next turn. |
| **state** | `proposed \| streaming \| resolved \| failed \| cancelled`. Where the entry is in its lifecycle. |
| **outcome** | Short reason string when state ∈ {failed, cancelled}. Opaque to most callers; a few plugins parse it. |
| **writer** | Which tier wrote it last. |
| **scope** | `run:N \| project:N \| global`. Determines namespace and readership. |

Visibility and state are independent axes. An entry can be `state=resolved,
visibility=archived` (complete and hidden) or `state=streaming,
visibility=summarized` (in-flight, shown as summary) or `state=proposed,
visibility=visible` (visible, awaiting resolution).

### Six Primitives {#primitives}

The entire grammar for changing entries:

| Verb | Effect |
|------|--------|
| **set** | Create or update an entry. Writes content, state, visibility, attributes. |
| **get** | Promote an entry to `visibility=visible`. The read-with-side-effect. |
| **rm** | Remove an entry from the caller's view (or delete it when scope permits). |
| **cp** | Copy an entry to a new path. |
| **mv** | Rename an entry to a new path. |
| **update** | Record a turn's continuation or terminal signal. |

Every tool in rummy (`<sh>`, `<ask_user>`, `<search>`, `<env>`, `<think>`,
`<known>`, `<unknown>`, …) is a **plugin that composes the six
primitives**. A `<sh>` invocation becomes a `set` that creates a
proposed entry; on user accept, a stream plugin drives body appends
via `set` and eventually a state transition to `resolved`. The
primitives are the atoms; tools are the molecules.

### Three Surfaces, One Grammar {#surfaces}

| Actor | Syntax |
|-------|--------|
| **Model** | XML tags: `<set path="..." />` |
| **Plugin** | RummyContext methods: `rummy.set({...})` |
| **Client** | JSON-RPC: `{"method":"set","params":{...}}` |

Syntactic skins over the same semantics. A plugin calling
`rummy.set(...)`, a client sending `{"method":"set",...}`, and a model
emitting `<set/>` are the same event at the store layer, authorized by
the respective writer identity against the scheme's permissions.

### Four Writer Tiers {#writer_tiers}

A strict hierarchy of writer identities. Each tier is a superset of
what's below it:

| Tier | Access |
|------|--------|
| **system** | Internal plumbing (TurnExecutor, AgentLoop audit writes — `instructions://`, `reasoning://`, message schemes). |
| **plugin** | Declares schemes, registers hooks and filters, calls store methods directly. Everything below plus plugin-scope infrastructure. |
| **client** | RPC surface. Writes to client-writable schemes (`run://`, proposed-entry state transitions, config) and reads via subscribed notifications. |
| **model** | XML-tag surface. Writes to model-writable schemes (`known://`, `unknown://`, `update://`, tool-result schemes) as restricted by the active run's capability set. |

Every scheme declares `writable_by` as a subset of `{system, plugin,
client, model}`. A write from an identity outside that subset rejects
with state=failed, outcome="permission:403".

### Runs Are Entries {#runs_are_entries}

Starting a run is not a separate API — it is a `set` to
`run://{alias}` with a prompt body and attributes carrying model,
restrictions, and resolution strategy. A run plugin observes `run://`
entry writes and starts the turn loop. Cancelling is a state
transition to `cancelled` on the same path. Resolving a proposed entry
is a state transition on that entry's path.

The lifecycle API is the entry grammar. No parallel verb set.

### Events & Filters {#events_and_filters}

Between the primitive-write layer and the actual work, rummy is a
hooks-and-filters system. Plugins subscribe to events (fire-and-forget
side effects) and filters (transformation chains that thread a value
through subscribers in priority order).

**Every `<tag>` the model sees is a plugin.** `<knowns>` → known
plugin. `<unknowns>` → unknown plugin. `<performed>` → performed
plugin. `<previous>` → previous plugin. `<prompt>` → prompt plugin.
No monolithic assembler decides what goes where. Each plugin filters
for its own data from the shared row set, renders its section, returns.

**Plugins compose, they don't coordinate.** A plugin subscribes to a
filter at a priority, receives the accumulator value, appends its
contribution, returns. It doesn't know what other plugins exist.
Priority determines ordering. Lower numbers run first.

**The core is a filter chain invocation.** `ContextAssembler` computes
`loopStartTurn` from the latest prompt entry's `source_turn`, then
calls `assembly.system.filter(systemPrompt, ctx)` and
`assembly.user.filter("", ctx)`. Everything else is plugins.

### Physical Layout

The contract is realized across two tables plus a compat view:

- **`entries`** — content layer. `(scope, path)` unique. Body,
  attributes, hash, tokens.
- **`run_views`** — per-run projection. Visibility, state, outcome,
  turn, loop. A run sees an entry only if it has a view row.
- **`known_entries`** — compatibility VIEW joining the two for legacy
  SELECT queries. Not writable.

Server-side bookkeeping (runs, loops, turns, projects, models,
schemes, file_constraints, turn_context, rpc_log) exists to support
the contract; the contract's actors never address these tables
directly.

---

## The Known Store {#known_store}

All model-facing state is stored across two tables joined via the
`known_entries` compatibility VIEW. Files, knowledge, tool results,
skills, audit — everything is a keyed entry with a URI path, body,
attributes, per-run status, and per-run visibility.

### Schema {#schema}

**Content layer** — `entries` (shared, scope-owned):

```sql
entries (
    id, scope, path, scheme, body, attributes,
    hash, tokens, created_at, updated_at,
    UNIQUE (scope, path)
)
```

| Column | Purpose |
|--------|---------|
| `scope` | `global`, `project:N`, or `run:N`. Determines who can read; per-scheme `writable_by` determines who can write. |
| `path` | Entry identity within scope. Bare paths (`src/app.js`) or URIs (`known://auth`). Max 2048 chars. |
| `scheme` | GENERATED from `schemeOf(path)`. Drives dispatch and view routing. |
| `body` | Content. File text, tool output, skill docs. |
| `attributes` | Tag attributes as JSON. `CHECK (json_valid)`. |
| `hash` | SHA-256 for file change detection. |
| `tokens` | Full-body token cost. Never changes on demotion/promotion. |

**View layer** — `run_views` (per-run projection):

```sql
run_views (
    id, run_id, entry_id, loop_id, turn,
    status INTEGER, visibility TEXT,
    write_count, refs, created_at, updated_at,
    UNIQUE (run_id, entry_id)
)
```

| Column | Purpose |
|--------|---------|
| `run_id`, `entry_id` | (run, entry) unique pair. Absent view = not in context. |
| `loop_id`, `turn` | Freshness — when this run last touched the entry. |
| `status` | HTTP status code — outcome of the run's last operation on this entry. |
| `visibility` | `visible` \| `summarized` \| `archived`. The run's relationship to the entry. |
| `write_count` | How many times this run has written this entry. |

**Compatibility view** — `known_entries` joins the two tables so
legacy SELECT queries keep working. Not writable; new write code must
target `entries` + `run_views` directly (see [upsert_semantics](#upsert_semantics)).

**No shadowing.** A run cannot override a global (or project-scoped)
entry with a run-scoped copy of the same path. Scope is resolved from
the scheme's declared `default_scope` at write time; if the writer's
permission doesn't allow the target scope, the write is rejected
(403 + `error://`). Paths are unique within a scope, but different
scopes use independent namespaces — `known://plan` is always run-
scoped; `wiki://...` (hypothetical) would always be global. The
scheme plugin owns the decision; the model doesn't juggle scopes.

**Forks copy views, not content.** `store.forkEntries(parent, child)`
inserts new `run_views` rows referencing the parent's `entries`
rows — no body copies, O(row-count) rather than O(body-bytes).
A forked child's subsequent writes diverge by creating new entries
at the child's scope; the parent's entries stay untouched.

### Schemes, Status & Visibility {#schemes_status_visibility}

Every entry has two independent dimensions: **status** (HTTP integer —
view-side) and **visibility** (what the model sees — view-side). These
are separate concerns.

**Status** (operation outcome): 200 (OK), 202 (proposed), 400 (bad
request), 403 (permission denied), 404 (not found), 409 (conflict),
413 (too large), 499 (aborted), 500 (error).

**Visibility** (the model's view in the run's context): `visible` (body
shown), `summarized` (path + attrs shown, body hidden or condensed;
promote via `<get>`), `archived` (invisible; retrievable via pattern
search).

Lifecycle events (budget Turn Demotion, fork copy) change `visibility`
but never `status` — status stays truthful about the last body
operation. See `demote_turn_entries` in `known_store.sql`.

Paths use URI scheme syntax. Bare paths (no `://`) are files, stored
with `scheme IS NULL` (JOINs treat NULL as `'file'` via COALESCE).

Every entry plays one of four roles:

| Role | Category | Section | Description |
|------|----------|---------|-------------|
| **Data** | `data` | `<knowns>` | Entries the model works with — persistent state |
| **Logging** | `logging` | `<performed>`/`<previous>` | Records of what happened — tool results, lifecycle signals |
| **Unknowns** | `unknown` | `<unknowns>` | Open questions the model is tracking |
| **Prompt** | `prompt` | `<prompt>` | The task driving the loop |

`logging` is the default category. Plugins opt into `data` explicitly.

| Scheme | Category | `writable_by` | Description |
|--------|----------|---------------|-------------|
| `NULL` (bare path) | data | `model, plugin` | File content. JOINs via `COALESCE(scheme, 'file')`. |
| `known://` | data | `model, plugin` | Model-registered knowledge. One fact per entry. |
| `skill://` | data | `model, plugin` | Skill docs. Rendered in system message. |
| `http://`, `https://` | data | `model, plugin` | Web content. |
| `unknown://` | unknown | `model, plugin` | Unresolved questions. |
| `prompt://` | prompt | `plugin` | User prompt with `mode` attribute. Written by prompt plugin, never by model. |
| `set://`, `get://`, `sh://`, `env://`, `rm://`, `mv://`, `cp://`, `ask_user://`, `search://` | logging | `model, plugin` | Tool result entries. |
| `update://` | logging | `model, plugin` | Lifecycle signal. Status attr classifies terminal (200/204/422) vs continuation (102). |
| `budget://` | logging | `model, plugin` | Turn Demotion panic record (413 overflow). |
| `error://` | logging | `model, plugin` | Runtime errors (policy rejection, healer warnings, dispatch crashes, etc.). |
| `tool://` | audit | `system` | Internal plugin metadata. `model_visible = 0`. |
| `instructions://`, `system://`, `reasoning://`, `model://`, `user://`, `assistant://`, `content://` | audit | `system` | Audit entries. `model_visible = 0`. Written only by server-level code. |

### Scheme Registry {#scheme_registry}

The `schemes` table is a bootstrap registry — rows of
`(name, model_visible, category, default_scope, writable_by)`.
Plugins register their scheme via `core.registerScheme({name, category,
scope, writableBy})` in the constructor. Defaults:
`scope = "run"`, `writableBy = ["model", "plugin"]`.

- `model_visible` — whether entries appear in `v_model_context` (`0`
  hides audit schemes from the model).
- `default_scope` — `run` \| `project` \| `global`. Resolved to a
  concrete scope string at write time (`run:N`, `project:N`, `global`).
  Project-scoped writes require `projectId` on the call; `Entries.set`
  throws if it's missing.
- `writable_by` — JSON array of allowed writer types
  (`model` \| `plugin` \| `system` \| `client`). `Entries.set` throws
  `PermissionError` when the caller's writer isn't in the list.

### UPSERT Semantics {#upsert_semantics}

Writes go through `Entries.set({runId, path, body, state?, visibility?,
attributes?, outcome?, turn?, loopId?, writer?, projectId?, ...})`
— two-prep flow:

1. `upsert_entry` — INSERT OR UPDATE on `(scope, path)`. Scope comes
   from scheme's `default_scope`. Returns the `entry_id`.
2. `upsert_run_view` — INSERT OR UPDATE on `(run_id, entry_id)`.
   Increments `write_count` on conflict.

Blank body is valid. Deletion uses `<rm>`, which removes the
`run_views` row; the shared `entries` row is left for now (GC is a
future concern).

---

## Relational Tables

The K/V store is the memory. Relational tables are the skeleton.

```sql
projects (id, name UNIQUE, project_root, config_path, created_at)
models   (id, alias UNIQUE, actual, context_length, created_at)
runs     (id, project_id, parent_run_id, model, alias UNIQUE,
          status INTEGER, temperature, persona, context_limit,
          next_turn, next_loop, created_at)
loops    (id, run_id, sequence, mode, model, prompt, status INTEGER,
          config JSON, result JSON, created_at)
turns    (id, run_id, loop_id, sequence, context_tokens,
          reasoning_content, prompt_tokens, cached_tokens,
          completion_tokens, reasoning_tokens, total_tokens, cost,
          created_at)

file_constraints (id, project_id, pattern, visibility, created_at)
  -- Project-level config. NOT tool dispatch. See [file_constraints](#file_constraints).
turn_context     (id, run_id, loop_id, turn, ordinal, path, scheme,
                  status, visibility, body, tokens, attributes,
                  category, source_turn)
rpc_log          (id, project_id, method, rpc_id, params, result, error)
```

**No sessions.** Runs belong to projects. Any client that knows the project
name can access any run. Temperature, persona, and context_limit are per-run.

**Models** are bootstrapped from `RUMMY_MODEL_*` env vars at startup (upsert).
Clients can add/remove models at runtime via RPC. No default model — the
client picks for every run.

### Run State Machine {#run_state_machine}

All status fields are HTTP integer codes. `runs.status` transitions
are enforced by `trg_run_state_transition` (see initial migration):

```
100 queued    → 102 running, 499 aborted
102 running   → 200 completed, 202 proposed, 500 failed, 499 aborted
202 proposed  → 102 running, 200 completed, 499 aborted
200 completed → 102 running, 499 aborted
500 failed    → 102 running, 499 aborted
499 aborted   → 102 running
```

All terminal states (200/500/499) allow transition back to running.
Runs are long-lived.

### Loops Table {#loops_table}

The loops table IS the prompt queue. Each `ask`/`act` creates a loop.
FIFO per run (ordered by sequence). One active at a time. Abort stops
the current loop; pending loops survive. Projects > runs > loops > turns.

### File Constraints {#file_constraints}

The `file_constraints` table is project-level configuration — it
defines which files a project cares about. This is backbone, not tool
dispatch. Constraints have three visibilities:

- `active` — matching files are promoted into the run's context
- `readonly` — promoted but not editable by the model
- `ignore` — demoted (excluded from context)

**Boundary:** Setting a constraint (`File.setConstraint`) is a
project-config write. Promoting/demoting the matching entries is tool
dispatch that goes through the handler chain with budget enforcement.
These are separate operations: constraint persists across runs, entry
visibility is scoped to a run and subject to the same budget rules as
a model `<get>`.

`store` RPC manages constraints directly — it is not a model tool.
`get` RPC with `persist` sets the constraint AND dispatches promotion.

---

## Entry-Driven Dispatch

### Unified API {#unified_api}

Three callers share a tool vocabulary. The invocation shape is
per-tier; params shape is not uniform across tiers.

| Tier | Transport | Invocation |
|------|-----------|-----------|
| Model | XML tags | `<rm path="file.txt"/>` |
| Client | JSON-RPC | `{ method: "rm", params: { path: "file.txt" } }` |
| Plugin | RummyContext verbs | `rummy.rm("file.txt")` (each verb takes what's natural — see `src/hooks/RummyContext.js`) |

| Method | Model | Client | Plugin |
|--------|-------|--------|--------|
| `think`, `get`, `set`, `rm`, `mv`, `cp`, `sh`, `env`, `search` | ✓ | ✓ | ✓ |
| `ask_user`, `update` | ✓ | ✓ | ✓ |
| `ask`, `act`, `resolve`, `abort`, `startRun` | — | ✓ | ✓ |
| `getRuns`, `getModels`, `getEntries` | — | ✓ | ✓ |
| `on()`, `filter()`, db/store access | — | — | ✓ |

Model tier restrictions enforced by unified `resolveForLoop(mode, flags)`.
Ask mode excludes `sh`. Flags: `noInteraction` excludes `ask_user`,
`noWeb` excludes `search`, `noProposals` excludes `ask_user`/`env`/`sh`.
11 model tools: think, get, set, env, sh, rm, cp, mv, ask_user, update,
search. The model writes `known` and `unknown` entries via
`<set path="known://...">` and `<set path="unknown://...">`; those
plugins don't advertise their own tag name — they render and filter.
Client tier requires project init. Plugin tier has no restrictions.

### Dispatch Path {#dispatch_path}

Each tier feeds into the shared tool handler chain, but through a
different entry point:

```
Model:  XmlParser → { name, path, ... } → TurnExecutor.#record()
                  → hooks.tools.dispatch(scheme, entry, rummy)
Client: JSON-RPC  → rpc.js dispatchTool(hooks, rummy, scheme, ...)
                  → hooks.tools.dispatch(scheme, entry, rummy)
Plugin: rummy.set({path, body, ...}) / rummy.rm(path) / etc.
                  → direct entries.* store calls (bypasses the handler chain)
```

Model and client tiers both land in `hooks.tools.dispatch`, which
invokes the scheme's registered handler. Model-tier additionally
passes through `TurnExecutor.#record()` (adds turn-scoped recording,
policy filtering, abort cascade). Plugin-tier convenience verbs
(`rummy.rm`, `rummy.set`, ...) are thin wrappers over the store — they
don't invoke the handler chain. Plugin code that wants full handler
semantics calls `hooks.tools.dispatch` directly.

**Tool dispatch:** Commands are dispatched sequentially in the order
the model emitted them. Each tool either succeeds (200), fails (400+),
or proposes (202). On failure, all remaining tools are aborted. On
proposal, dispatch pauses, a notification is pushed to the client
(same WebSocket push pattern as `run/state`), the client resolves
(accept/reject), and dispatch resumes — the proposal becomes 200 or
400+ like any other tool. The `ask`/`act` RPC response is only sent
when all tools have completed. Proposals are NOT batched — each is
sent and resolved inline during dispatch. The model controls tool
ordering; the system respects it.

If the model sends `<update status="200">` (terminal) but a preceding
action in the same turn failed, the terminal assertion is overridden
to a continuation (the model's claim of doneness is false); the update
plugin resolves the update entry to 409 and surfaces it to the next
turn as a continuation. Multiple `<update>` tags → last signal wins.

**Post-dispatch budget check:** After all tools dispatch, the budget
plugin re-materializes context and checks the ceiling
(`hooks.budget.postDispatch`). If context exceeds the ceiling, Turn
Demotion fires — all `visible` `run_views` rows for the current turn
have their `visibility` flipped to `summarized`, and a `budget://` entry is
written. Status is NOT touched (see [schemes_status_visibility](#schemes_status_visibility)). The tools already ran;
their outcomes are settled.

### Plugin Convention {#plugin_convention}

A plugin is an instantiated class. The class name matches the file name.
The constructor receives `core` (a PluginContext) — the plugin's
complete interface with the system.

```js
export default class Rm {
    #core;

    constructor(core) {
        this.#core = core;
        core.ensureTool();
        core.registerScheme({ category: "logging" });
        core.on("handler", this.handler.bind(this));
        core.on("visible", this.full.bind(this));
        core.on("summarized", this.summary.bind(this));
    }

    async handler(entry, rummy) {
        // rummy here is per-turn RummyContext (not the startup PluginContext)
    }

    full(entry)    { return `# rm ${entry.attributes.path}`; }
    summary(entry) { return ""; }
}
```

**Registration verbs on PluginContext:**
- `"handler"` — tool handler (dispatches when a matching entry is recorded).
- `"visible"` / `"summarized"` — visibility view projections. Return the
  projected body string for the given visibility level.
- Any hook name (e.g. `"turn.started"`, `"entry.created"`) — subscribes
  to that event.
- `core.filter(name, callback, priority)` — subscribes to a filter chain.

**Two objects:**
- `this.#core` — PluginContext (startup). For registration: `on()`, `filter()`.
- `rummy` argument — RummyContext (per-turn). For runtime: tool verbs, queries.

**Plugin types:**
- **Tool plugins**: register `handler` + `visible`/`summarized`. Model-invokable.
- **Assembly plugins**: register `core.filter("assembly.system"|"assembly.user", ...)`. Own a packet tag.
- **Infrastructure plugins**: subscribe to lifecycle events
  (`turn.started`, `turn.response`, `turn.completed`, `entry.created`,
  `loop.started`, etc.). Background work.

A plugin can be multiple types. Known is a tool AND an assembly plugin.

### Mode Enforcement {#mode_enforcement}

Two mechanisms, operating at different layers:

1. **Tool-list exclusion** — `hooks.tools.resolveForLoop(mode, flags)`
   computes the active tool set at loop start. Ask mode excludes `sh`.
   Flag-driven exclusions: `noInteraction` removes `ask_user`; `noWeb`
   removes `search`; `noProposals` removes `ask_user`/`env`/`sh`. The
   excluded tools don't appear in the system prompt's tool list.
2. **Per-invocation filtering** — the `policy` plugin subscribes to
   `entry.recording` and inspects individual emissions for ask-mode
   violations that the tool-list alone can't catch (file-scheme `<set>`
   edits, file `<rm>`, file-destination `<mv>`/`<cp>`). Rejects with
   status 403 and emits `error://`. The tool remains advertised; the
   specific invocation is blocked.

### Streaming Entries {#streaming_entries}

Producers that generate output over time (shell commands, web fetches,
log tails, file watches) use the streaming-entry pattern. Entry
lifecycle extends beyond the synchronous 202→200/400+ flow.

**Lifecycle:**

```
202 Proposal (user decision pending)
  → accept → 200 (log entry: action complete) + 102 data entries
  → reject → 403
```

**Entry shape for a streaming producer:**

```
{scheme}://turn_N/{slug}     category=logging   status=200
                             body: "ran 'command', exit=0, Output: {paths}"
                             (renders in <performed>)

{scheme}://turn_N/{slug}_1   category=data      status=102 → 200/500
                             body: primary stream (stdout for shell)
                             summary="{command}" visibility=summarized
                             (renders in <knowns>)

{scheme}://turn_N/{slug}_2   category=data      status=102 → 200/500
                             body: alt stream (stderr for shell)
                             (renders in <knowns>, often empty)
```

**Channel numbering follows Unix file descriptor convention.** Channel
1 is primary output (stdout for shell); channel 2 is alternate/error
output (stderr); higher numbers for additional producer-specific
channels. Non-process producers (search, fetch) map their streams onto
the same numeric space: `_1` for the primary data stream, `_2` for
anomalies/errors, `_3`+ for auxiliary streams.

**Status 102 ("Processing") marks an entry in mid-stream:** body is
partial, will change; tokens grow as chunks arrive. Agents reading a
102 entry use `<get>` with `line`/`limit` (including negative `line`
for tail) to sample without promoting full body.

**Status transition on completion** is terminal: 200 (exit_code=0 or
N/A for non-process producers), 500 (non-zero exit), or 499 (client
aborted via `stream/aborted`). The log entry is rewritten with final
stats (exit code, duration, channel sizes, or abort reason).

**Budget demotion preserves status.** A 102 entry demoted by Turn
Demotion stays at 102 — status reflects operation outcome, visibility
reflects visibility. See [schemes_status_visibility](#schemes_status_visibility) for the status-vs-visibility separation.

**Stream plugin ([plugin_system](#plugin_system)) owns the append and completion RPCs.** Producer
plugins (sh, env) create the proposal and data entries; the stream
plugin handles the subsequent growth and terminal transitions.

---

## Message Structure {#message_structure}

Two messages per turn. System = stable truth. User = active task.

### Packet Structure {#packet_structure}

```
[system message]
    instructions text
        (preamble.md + tool docs injected via
         instructions.toolDocs filter; optional persona appended)
    <knowns>
        entries sorted by category → skill-first → demoted-first
        → turn → updated_at
    </knowns>
    <previous>
        (pre-loop entries, each with turn, status, visibility, tokens)
    </previous>
[user message]
    <performed>
        (current loop entries, each with turn, status, visibility, tokens)
    </performed>
    <unknowns>
        (open questions, each with path, turn, visibility, tokens)
    </unknowns>
    <prompt mode="ask|act" tokenUsage="N" tokensFree="M">user prompt</prompt>
```

**System** = environment and rules (stable world state the model operates
within). **User** = active work (what the model is doing about it).
Unknowns are active work — the open questions the model intends to
resolve this turn — so they live adjacent to `<prompt>` in the user
packet, not with the stable `<knowns>` in the system packet.

The `<prompt>` tag is present on every turn — first turn and
continuations alike. The model always sees its task. The active prompt
is extracted from its chronological position and placed last for maximum
recency. The `<prompt>` element carries `tokenUsage` / `tokensFree`
attributes so the model can do budget arithmetic in-line with the cause.

### Loops, Previous, and Performed {#loops_previous_performed}

A **loop** is one `ask` or `act` invocation and all its continuation
turns until `<update status="200">`, fail, or abort.

**Previous** = all completed loops on this run. The user prompt, model
responses, tool results, agent warnings — the full chronicle in order.
Lives in the system message as established history. Omitted on the
first turn of the first loop.

**Performed** = the active loop's work so far. Model responses, tool
results, agent warnings — in order. Does NOT include the user prompt
(one per loop, extracted to `<prompt>`). Lives in the user
message as immediate context. Empty on the first turn of a loop.

When a new prompt arrives on an existing run, the prior loop's
`<performed>` content plus its prompt move to `<previous>`. When a loop
continues (next turn), new results append to `<performed>`.

### Key Entries {#key_entries}

| Path | Lifetime | Body | Attributes |
|------|----------|------|-----------|
| `instructions://system` | One per run (mutable) | Empty (projection builds from preamble + tool docs + optional persona) | `{ persona, toolSet }` |
| `system://N` | Audit, one per turn | Full assembled system message | — |
| `user://N` | Audit, one per turn | Full assembled user message | — |
| `assistant://N` | Audit, one per turn | Model's raw response | — |

`instructions://system` is the only mutable entry in this group. The
framework auto-populates `toolDescriptions` from tool registrations
that include `docs`. The instructions projection assembles the final
text from body + attributes.

### Materialization {#materialization}

Each turn:

1. Write `instructions://system` (empty body, attributes = { persona, toolSet })
2. Emit `turn.started` — plugins write prompt/instructions entries
3. Resolve the instructions system prompt (`hooks.instructions.resolveSystemPrompt`)
4. Query `v_model_context` VIEW → visible entries (joined from
   `run_views` + `entries` + `schemes`)
5. Project each entry through its scheme's `visible`/`summarized` projection
6. Insert projected rows into `turn_context`
7. Invoke `assembly.system` filter chain (instructions text as base):
   - Known plugin (priority 100) → `<knowns>` section
   - Previous plugin (priority 200) → `<previous>` section
8. Invoke `assembly.user` filter chain (empty string as base):
   - Performed plugin (priority 100) → `<performed>` section
   - Unknown plugin (priority 200) → `<unknowns>` section
   - Prompt plugin (priority 300) → `<prompt>` element (carries
     `tokenUsage` / `tokensFree` attrs when `contextSize` is set)
9. Store as `system://N` and `user://N` audit entries (telemetry plugin)

The VIEW determines visibility from `visibility` and `status`:
- `visibility = 'visible'` → full body visible in `<knowns>` / `<performed>`.
- `visibility = 'summarized'` → summarized projection visible (typically path +
  summary attr). Promote with `<get>` to expand.
- `visibility = 'archived'` → invisible. Discoverable via pattern search
  (`<get path="known://*">keyword</get>`); promote to bring back into view.
- `status = 202` → invisible (proposed, pending client resolution).
- `model_visible = 0` → invisible (audit schemes: instructions, system,
  reasoning, model, user, assistant, content, tool).

**Partial read:** `<get path="..." line="N" limit="M"/>` returns lines N
through N+M−1 of the entry body as the log item without changing
visibility or promoting the entry to context. Use after reading a
demoted entry (which shows path + summary) to target a specific slice.
Single-path only — glob or body filter with `line`/`limit` is a 400 error.

Model controls visibility via `<set>` attributes:
`visibility="archived|summarized|visible"`. The `summary="..."` attribute
attaches a description (≤ 80 chars) that persists across visibility
changes.

### Budget Enforcement {#budget_enforcement}

The model owns its context. The system enforces a hard ceiling and
surfaces the numbers — it does not automatically manage entries.

**Ceiling.** `ceiling = floor(contextSize × RUMMY_BUDGET_CEILING)`
(default `RUMMY_BUDGET_CEILING = 0.9`, i.e. 10% headroom). All budget
decisions compare `assembledTokens` against `ceiling`, never against
`contextSize` directly.

**Pre-LLM enforce** (`hooks.budget.enforce`, in TurnExecutor before
the LLM call). Measures the assembled messages (using
`turns.context_tokens` from the prior turn when available,
`countTokens(messages)` as a first-turn estimate).

- `assembledTokens ≤ ceiling` → return 200, proceed to LLM.
- `assembledTokens > ceiling` on the first turn of a loop → **Prompt
  Demotion**: demote the incoming `prompt://N` entry to `visibility =
  demoted`, re-materialize, re-check. If the retry fits, proceed.
- `assembledTokens > ceiling` on a non-first turn, or still over after
  Prompt Demotion → return 413. AgentLoop exits the loop with 413.

**Post-dispatch Turn Demotion** (`hooks.budget.postDispatch`, after
all tool dispatches complete). Re-materializes end-of-turn context
and re-checks. If still over the ceiling, flips every `run_views` row
for this turn from `visibility = visible` to `visibility = summarized`
(status preserved — see [schemes_status_visibility](#schemes_status_visibility)) and writes a `budget://{loopId}/{turn}`
entry summarizing what was demoted and stating the 50% rule for the
next turn. The model sees the `budget://` entry next turn and adjusts.

**LLM-reported context exceeded.** If the LLM rejects the request
with a "context too long" error (detected via the regex in
`src/llm/errors.js`), the LlmProvider raises `ContextExceededError`
which TurnExecutor catches and converts to a 413 exit — same terminal
path as pre-LLM 413 on a non-first turn.

**Known-scheme size gate** (in the `known` plugin). Writes to
`known://` entries exceeding `RUMMY_MAX_ENTRY_TOKENS` (default 512)
are rejected at the handler with an instructive error message. Forces
atomic entries instead of dumping transcripts into a single `known://`.

**Advisory feedback.** The model reads `tokensFree` / `tokenUsage`
attributes on `<prompt>` every turn and self-regulates. No threshold-
based warnings. When the ceiling is actually breached the `budget://`
entry is the feedback.

**Token math:** `Math.ceil(text.length / RUMMY_TOKEN_DIVISOR)`. One
formula, one file (`src/agent/tokens.js`), env-configurable. No
external dependencies. `contextSize` is the ceiling. Over = 413.
Under = 200. No margins.

**Three token measures — never conflate them:**

| Measure | Source | Scope | Use |
|---|---|---|---|
| SQL entry tokens | `entries.tokens` = `ceil(chars / DIVISOR)` | Per entry | Model decision-making: "this entry costs N tokens" |
| Assembled estimate | `measureMessages(messages)` = sum of entry projections | Full packet | First-turn budget fallback only |
| Actual API tokens | `turns.context_tokens` = `usage.input_tokens` back-filled from LLM | Per turn | Budget enforcement on turns 2+; ground truth |

`budget.enforce` uses the **actual API tokens** (`get_last_context_tokens`) when
available (turn 2+) and falls back to the assembled estimate on turn 1. The
estimate can be 3–7× off for XML/JSON-heavy content — do not rely on it for
anything that matters.

**`context_tokens` vs `prompt_tokens` in step telemetry:**
- `context_tokens` in the step JSON = `turns.context_tokens` for that turn =
  per-turn actual input tokens from the LLM API (e.g. 7900 tokens sent this turn)
- `prompt_tokens` in the step JSON = `SUM(turns.prompt_tokens)` for the run =
  **cumulative** total across all turns (cost tracking, not a context size)

These two will diverge rapidly on any multi-turn run. A run at turn 50 might show
`context_tokens: 8000` (context under control) and `prompt_tokens: 400000`
(total input tokens billed across the whole run). They are measuring orthogonal things.


---

## RPC Protocol

JSON-RPC 2.0 over WebSocket. `discover` returns the live catalog.

### Methods {#rpc_methods}

#### Protocol

| Method | Params |
|--------|--------|
| `ping` | — |
| `discover` | — |
| `init` | `{ name, projectRoot, configPath? }` |

#### Models

| Method | Params |
|--------|--------|
| `getModels` | `{ limit?, offset? }` |
| `addModel` | `{ alias, actual, contextLength? }` |
| `removeModel` | `{ alias }` |

#### Entry Operations (dispatched through handler chain)

| Method | Params |
|--------|--------|
| `get` | `{ path, run, persist?, readonly? }` |
| `set` | `{ run, path, body?, attributes? }` |
| `rm` | `{ run, path }` |
| `mv` | `{ run, path, to }` |
| `cp` | `{ run, path, to }` |
| `store` | `{ path, run?, persist?, ignore?, clear? }` |
| `getEntries` | `{ pattern?, body?, run?, limit?, offset? }` |

All entry operations dispatch through the handler chain. `persist`
on `get` also sets a project-level file constraint (operator privilege).
`store` manages file constraints — not a model tool.

#### Runs

| Method | Params |
|--------|--------|
| `startRun` | `{ model, temperature?, persona?, contextLimit? }` |
| `ask` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noRepo?, noInteraction?, noWeb?, fork? }` |
| `act` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noRepo?, noInteraction?, noWeb?, fork? }` |
| `run/resolve` | `{ run, resolution: { path, action, output? } }` |
| `run/abort` | `{ run }` |
| `run/rename` | `{ run, name }` |
| `run/inject` | `{ run, message }` |
| `run/config` | `{ run, temperature?, persona?, contextLimit?, model? }` |

`model` is required on `ask`, `act`, and `startRun`. No default.
`noRepo` disables default project/repo file scanning (files can still
be added explicitly by the client).
`noInteraction` removes `ask_user` from the tool list.
`noWeb` removes `search` from the tool list.

#### Streaming (see [streaming_entries](#streaming_entries))

| Method | Params |
|--------|--------|
| `stream` | `{ run, path, channel, chunk }` |
| `stream/completed` | `{ run, path, exit_code?, duration? }` |
| `stream/aborted` | `{ run, path, reason?, duration? }` |
| `stream/cancel` | `{ run, path, reason? }` |

Producer-agnostic RPC for streaming output into data entries created by
any plugin (sh/env today; search/fetch/watch as future consumers). The
`stream` method appends `chunk` to `{path}_{channel}`; `stream/completed`
transitions all `{path}_*` channels to terminal status (200/500) and
finalizes the log entry body; `stream/aborted` is the client-initiated
cancellation counterpart, transitioning channels to **499** (Client
Closed Request); `stream/cancel` is the server-initiated counterpart
(transitions to 499 and pushes `stream/cancelled` notification to
connected clients). `stream/cancel` also handles stale 102 cleanup.

#### Queries

| Method | Params |
|--------|--------|
| `getRuns` | `{ limit?, offset? }` |
| `getRun` | `{ run }` |

#### Skills & Personas

| Method | Params |
|--------|--------|
| `skill/add` | `{ run, name }` |
| `skill/remove` | `{ run, name }` |
| `getSkills` | `{ run }` |
| `listSkills` | — |
| `persona/set` | `{ run, name?, text? }` |
| `listPersonas` | — |

Skills loaded from `RUMMY_HOME/skills/{name}.md`. Personas from
`RUMMY_HOME/personas/{name}.md`.

### Notifications {#notifications}

| Notification | Scoped by | Purpose |
|-------------|-----------|---------|
| `rummy/hello` | connection | Server greeting on client connect. Carries `rummyVersion` (semver). Clients check MAJOR and refuse on mismatch. |
| `run/state` | projectId | Turn state snapshot (status, history, unknowns, telemetry). Fires per command dispatch (incremental 102), at turn conclusion (verdict status), and at terminal run close. |
| `run/progress` | projectId | Transient turn activity (`thinking` / `processing` / `retrying`). |
| `run/proposal` | projectId | A 202 entry is awaiting resolution. |
| `stream/cancelled` | projectId | Server-initiated streaming cancellation. |
| `ui/render` | projectId | Streaming UI output (e.g. tool progress). |
| `ui/notify` | projectId | Toast notification. |

**`run/state` payload shape** — the unified contract for both the
notification and `getRun` RPC:

```jsonc
{
  "run": "gemma_1234567890",
  "turn": 4,
  "status": 102,              // numeric HTTP status
  "summary": "…",             // latest <update status="200"> body, or ""
  "history": [                // chronological per-entry log
    {
      "tool": "set",
      "path": "known://president/current",
      "status": 200,
      "body": "Donald Trump is the 47th president…",
      "turn": 4,
      "attributes": "{\"summary\":\"president,current,trump\",\"visibility\":\"visible\"}"
    }
  ],
  "unknowns": [{ "path": "unknown://…", "body": "…" }],
  "telemetry": null | { /* final end-of-turn usage; null on mid-turn emissions */ }
}
```

`history` includes every entry the model has touched this run in
timeline order — prompt entries, unknowns, tool results. `attributes`
is raw JSON; parse client-side. Mid-turn emissions have `telemetry:
null`; the final emission of each turn includes the full telemetry
block (token usage, context distribution, cost).

`stream/cancelled` payload: `{ run, path, reason }`. Server has
already transitioned the entries to 499 (`Client Closed Request`);
client should stop sending `stream` chunks for that path.

### Resolution {#resolution}

| Resolution | Model signal | Outcome |
|-----------|-------------|---------|
| reject | any | `completed` — rejection stops the bus |
| accept | `<update status="102">` | `running` — model has more work |
| accept | `<update status="200|204|422">` | `completed` — terminal |
| accept | neither | `running` — healer decides |
| error | any | `running` — error state, model retries |

---

## Plugin System {#plugin_system}

See [PLUGINS.md](PLUGINS.md) for the full plugin development guide,
including the RummyContext API, tool registration, handler chains,
projections, events, filters, and hedberg pattern library.

Each plugin has its own README at `src/plugins/{name}/README.md`.

---

## Tool Documentation Design {#tool_documentation}

Tool docs are the most carefully designed text in rummy. Every line
simultaneously teaches syntax, implies workflow priority, demonstrates
pattern capabilities, and constrains misuse. Each letter earns its place.

### Principles

**Show, don't tell.** Examples ARE the documentation. A model learns
`<get path="known://*">auth</get>` from seeing it, not from being told
"you can filter known entries by keyword." Examples are ordered from
simple to powerful — weak models learn from examples 1-2, strong models
pick up the pattern from example 3.

**Lifecycle continuity.** Examples weave stories across tools. The get
docs demonstrate `<get path="known://*">keyword</get>` for pattern recall
and `<get path="..." line="N" limit="M"/>` for partial reads that don't
promote. The known docs reference `<get path="known://*">keyword</get>`
for recall. The unknown docs reference `<set path="unknown://..."
visibility="archived"/>` for retiring resolved questions, `<get/>` for
investigation. A model reading the full tool docs encounters a coherent
workflow: discover → load → reason → edit → archive → recall.

**RFC 2119 semantics.** Constraint bullets use YOU MUST, YOU MUST NOT,
YOU SHOULD, YOU MAY from RFC 2119. Every LLM has extensive pretraining
on RFC documents where these keywords carry precise semantic weight.
MUST is absolute. SHOULD is strong advisory. MAY is permissive. This
is not decorative — it's leveraging the model's existing understanding
of requirement levels.

**Consistent structure.** Every tool doc follows: header (syntax), 2+
examples, 2+ constraint bullets. Inconsistent formatting reads as
inconsistent importance. A tool with 5 examples and dense bullets feels
complex; a tool with 1 line feels disposable. Both are wrong — every
tool is equally real, each doc is proportional to the tool's surface area.

### Format

Tool docs live in `*Doc.js` files as annotated line arrays:

```js
const LINES = [
    ["* Body text filters results by content match",
        "Generalizes examples 2-3. Body = filter, not just path."],
];
export default LINES.map(([text]) => text).join("\n");
```

The first element is the model-facing text. The second is the rationale —
visible only in source. Changing any line requires reading all rationales
first. This prevents well-intentioned edits from breaking subtle behavioral
guarantees that adjacent lines depend on.

### Tool Display Order

Tools are presented gather → reason → act → communicate. Position in
the list implies priority. `get` is first. `ask_user` is last. The
order is defined in `ToolRegistry.TOOL_ORDER` and applied by
`resolveForLoop()`. The same method handles all tool exclusions —
mode restrictions, `noInteraction`, `noWeb`, `noProposals` — through
one unified mechanism.

### Pattern Distribution

Hedbergian pattern matching (globs, body filters, preview) is taught
across multiple tools, not concentrated in one. `get` shows content
filtering. `cp` shows glob batch operations. `rm` shows preview safety.
Each tool reinforces the pattern vocabulary from a different angle.
A model that sees `path="known://*"` in get, `path="known://plan_*"` in
cp, and `path="known://temp_*" preview` in rm learns that patterns
are universal — not a feature of any single tool.

---

## Hedberg Editing Syntax {#hedberg}

The model picks its preferred edit format. The parser understands all of them:

1. Git merge conflict: `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`
2. Replace-only: `======= ... >>>>>>> REPLACE`
3. Unified diff: `@@ -1,3 +1,3 @@` with `-`/`+` lines
4. Sed syntax: `s/old/new/flags`
5. Claude XML: `<old_text>old</old_text><new_text>new</new_text>`
6. JSON body: `{"search": "old", "replace": "new"}` or `{search="old", replace="new"}`
7. XML attributes: `<set search="old" replace="new"/>`
8. Full replacement: anything else becomes the new content

---

## Response Healing {#response_healing}

The server never throws on model output. "Model behavior" is never an
acceptable explanation. Recovery order:

1. Can we recover? Extract the data and continue.
2. Can we warn? Log structured warnings.
3. Did our structure cause this? Check formatting, prompts.

Termination protocol:
- `<update status="200|204|422">` → run terminates
- `<update status="200">` + failed actions → overridden to continuation
  (the claim of doneness is refuted by the failures)
- `<update status="102">` → run continues
- Multiple `<update>` → last one wins
- No `<update>` + investigation tools → stall counter (RUMMY_MAX_STALLS)
- No `<update>` + action-only tools → healer infers terminal from body
- No `<update>` + plain text → healer infers terminal from body
- Repeated commands → cycle detection (RUMMY_MIN_CYCLES, RUMMY_MAX_CYCLE_PERIOD)
- Repeated update text without non-update work → stall (RUMMY_MAX_UPDATE_REPEATS)

Format normalization:
- Gemma `\`\`\`tool_code` fences → stripped before parsing
- Qwen `<|tool_call>` format → normalized to XML
- OpenAI function_call JSON → normalized to XML
- Mistral `[TOOL_CALLS]` → normalized to XML
- Sed alternate delimiters (`s|old|new|`) → parsed like `s/old/new/`

---

## Testing

| Tier | Location | LLM? |
|------|----------|------|
| Unit | `src/**/*.test.js` | No |
| Integration | `test/integration/` | No |
| Live | `test/live/` | Yes |
| E2E | `test/e2e/` | Yes |

E2E tests must NEVER mock the LLM. Environment cascade:
`.env.example` → `.env` → `.env.test`. Always use `npm run test:*`.

### Spec-Anchored Testing

Integration and e2e tests MUST be anchored to SPEC.md's snake_case
anchor system. The rule is bidirectional:

1. **Every SPEC.md heading with a `{#snake_case_id}` anchor has at
   least one integration or e2e test that references it.** The
   reference is literal: an `@snake_case_id` token appearing in the
   test file (suite name, test name, or comment). A heading without
   a test reference is a spec with no verified guarantee.
2. **Every integration or e2e test is attributed to at least one
   `@`-reference.** A test describing behavior that isn't in SPEC
   either adds the behavior to SPEC or isn't under the integration
   / e2e tiers.

Enforcement: `npm run test:spec` parses SPEC.md's `{#id}` anchors
and greps `test/integration/` + `test/e2e/` for `@id` references.
Missing references fail the script. The check runs in CI and blocks
merges.

Unit tests (`src/**/*.test.js`) are exempt — they verify
implementation details, not spec guarantees.

**Why snake_case, not numeric `§X.Y`:** slugs are stable identifiers
independent of section ordering. Numbering required a rewrite of
every test reference whenever SPEC.md reorganized. Slugs never
churn — rename a section's text, leave the anchor, no tests break.

**Anchor naming rules:**
- Lowercase `[a-z0-9_]`, underscores for word separation.
- Unique across the whole document.
- Stable once published: treat as a permanent identifier; renames
  are a breaking change requiring a test sweep.
- Short and semantic (`entries`, not `section_0_1_the_entry_contract`).

**When a section doesn't get an anchor:** umbrella sections (parents
of testable subsections, like "The Contract" or "RPC Protocol") and
pure-documentation sections (env var listings, debugging procedures,
this section itself) stay as plain headings. The anchor *implies
testability* — if there's nothing observable to verify, adding an
anchor creates a permanent false obligation.

**PLUGINS.md and `src/plugins/*/README.md`** participate in the
same coverage gate as SPEC.md. `npm run test:spec` scans all three
sources for `{#snake_case_id}` anchors and requires each one to
have an integration or e2e test that references it. Anchors must
be unique across the whole doc set — the script errors on
collision. Conventional prefixes keep namespaces clean: SPEC uses
bare slugs (`entries`, `primitives`), PLUGINS uses `plugins_*`,
plugin READMEs use `<plugin>_plugin`.

**Untestable plugin docs (LLM providers, quickstart tutorials,
loader-level behavior verified only in `test/live/`)** stay as
plain headings without anchors. Anchors are a commitment to
verification; skipping the anchor is the honest declaration that
no integration test exists or is feasible.

---

## SQL Functions {#sql_functions}

| Function | Purpose |
|----------|---------|
| `schemeOf(path)` | Extract URI scheme |
| `countTokens(text)` | Token count (`ceil(len / RUMMY_TOKEN_DIVISOR)`) |
| `hedmatch(pattern, string)` | Full-string pattern match (paths, equality) |
| `hedsearch(pattern, string)` | Substring pattern search (content filtering) |
| `hedreplace(pattern, replacement, string)` | Pattern-based replacement |
| `slugify(text)` | URI-encoded slug, max 80 chars |

See [PLUGINS.md](PLUGINS.md) for the hedberg pattern type reference.

---

## Debugging: E2E and Benchmark Results

### E2E test failures

E2E tests use a temp DB at `/tmp/rummy_test_<timestamp>_<random>.db` (cleaned up after).
On failure, `AuditClient.assertRun` calls `dumpRun`, which prints a full turn-by-turn audit
to stdout. That output is in the background task log:

```
/tmp/claude-1000/-home-hyzen-repo-rummy-main/<session-id>/tasks/<task-id>.output
```

If oversized, the harness saves to:
```
/home/hyzen/.claude/projects/-home-hyzen-repo-rummy-main/<session-id>/tool-results/<id>.txt
```

The dump format is: `scheme:state path {attributes}\n  body (120 chars)` grouped by turn.

Key things to look for in a dump:
- **202**: unresolved proposals — model issued `<sh>`, `<rm>`, or `<mv>` that needs approval
- **413**: budget overflow — assembled context exceeded ceiling (see [budget_enforcement](#budget_enforcement))
- **403**: policy rejection (ask-mode file writes) or permission denial (writer ∉ `writable_by`)
- **`budget://` entries**: Turn Demotion fired — model received a directive to demote promotions next turn
- **`error://` entries**: runtime errors (parser warnings, cycle/stall detection, policy rejections, dispatch crashes)
- **`<sh>` in ask mode**: the policy plugin rejected it; check for the corresponding `error://` entry

### MAB benchmark

Results live in `test/mab/results/<ISO-timestamp>/mab.db`. Latest run = most recent dir.

```js
// Query a MAB result DB directly:
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('test/mab/results/<timestamp>/mab.db');
db.prepare('SELECT * FROM questions').all();      // all questions + scores
db.prepare('SELECT * FROM runs').all();           // individual model runs
```

Run with: `npm run test:mab`

### LME benchmark

Results live in `test/lme/results/<ISO-timestamp>/lme.db`. Same structure.

Run with: `npm run test:lme`

---

## Configuration

Full reference is `.env.example` — these are the load-bearing vars.

**Runtime:**

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | 3044 | WebSocket port |
| `RUMMY_HOME` | `~/.rummy` | Skills, personas, local config |
| `RUMMY_DB_PATH` | `rummy.db` | SQLite path |
| `RUMMY_MMAP_MB` | 0 | SQLite mmap hint (MB; 0 disables) |
| `RUMMY_DEBUG` | false | Verbose logging |

**Budget & token math:**

| Var | Default | Purpose |
|-----|---------|---------|
| `RUMMY_BUDGET_CEILING` | 0.9 | Fraction of `contextSize` used as ceiling |
| `RUMMY_MAX_ENTRY_TOKENS` | 512 | `known://` write rejection threshold |
| `RUMMY_TOKEN_DIVISOR` | 2 | `ceil(chars/N)` token estimate divisor |

**Loop controls:**

| Var | Default | Purpose |
|-----|---------|---------|
| `RUMMY_MAX_TURNS` | 15 | Hard loop iteration cap |
| `RUMMY_MAX_COMMANDS` | 99 | Max parsed tool calls per turn |
| `RUMMY_MAX_STALLS` | 3 | Turns without `<update>` before force-complete |
| `RUMMY_MAX_UPDATE_REPEATS` | 3 | Same-text repeat threshold without progress |
| `RUMMY_MIN_CYCLES` | 3 | Consecutive repetitions to trigger cycle detection |
| `RUMMY_MAX_CYCLE_PERIOD` | 4 | Max cycle period checked by healer |
| `RUMMY_RETENTION_DAYS` | 31 | Days of completed/aborted runs kept |
| `RUMMY_THINK` | 1 | Enable `<think>` tag reasoning |
| `RUMMY_TEMPERATURE` | 0.5 | Default LLM temperature |
| `RUMMY_RPC_TIMEOUT` | 30000 | RPC timeout (ms) |
| `RUMMY_FETCH_TIMEOUT` | 300000 | LLM HTTP timeout (ms) |

**LLM providers** (plugin-scoped; a provider with no config is inert):

| Var | Purpose |
|-----|---------|
| `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY` | OpenRouter |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | OpenAI-compatible (llama.cpp, OpenAI, etc.) |
| `OLLAMA_BASE_URL` | Ollama |
| `XAI_BASE_URL` / `XAI_API_KEY` | xAI |
| `RUMMY_HTTP_REFERER` / `RUMMY_X_TITLE` | OpenRouter attribution headers |

**Model aliases:**

`RUMMY_MODEL_{alias}={provider/model}` or `{provider/publisher/model}` —
seeded into `models` table at startup. First path segment picks the
provider plugin; the rest is the provider's own model identifier. E.g.
`RUMMY_MODEL_gpt4=openai/gpt-4`, `RUMMY_MODEL_claude=openrouter/anthropic/claude-3-opus`.
Optional companion: `RUMMY_CONTEXT_{alias}={tokens}` overrides the
auto-discovered context length.

**External plugins:**

`RUMMY_PLUGIN_{name}={path or npm package}` loads an external plugin
at startup. Absolute path or published package name (resolved via
local `node_modules` then global).

**Search:**

| Var | Purpose |
|-----|---------|
| `RUMMY_SEARCH` | `brave` \| `searxng` |
| `BRAVE_API_KEY` | Brave Search API key |
| `RUMMY_SEARXNG_URL` | SearXNG instance URL |

**Testing:**

| Var | Purpose |
|-----|---------|
| `RUMMY_TEST_MODEL` | Model alias used by test/live/e2e runners |
