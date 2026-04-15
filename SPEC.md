# RUMMY: Architecture Specification

The authoritative reference for Rummy's design. The sacred prompt
The instructions plugin (`preamble.md` + tool docs) defines
model-facing behavior. This document defines everything else.

---

## 0. Design Philosophy

### 0.1 Everything Is an Entry

Rummy's substrate is the `known_entries` table. Files, tool results,
knowns, unknowns, plans, running processes, streaming output, past
conversation — all keyed entries with a URI path, body, attributes,
and status.

This is the Unix "everything is a file" principle applied to agent
systems. Read/write operations (`<get>`/`<set>`) speak a universal
grammar; any plugin that produces entries composes with any plugin
that consumes them, without coordination. New capabilities (streaming
shell, web fetch, sub-agents, file watches) slot in by producing
entries in the same substrate. The model learns one idiom —
scheme://path, read, write, promote, demote — and applies it to every
tool it meets.

The bet: uniform substrate beats specialized abstractions. Unix's
forty-five-year payoff on this bet scaled from PDP-11 to smartphones.
Rummy's bet is the same wager applied to LLM-driven systems.

### 0.2 Events & Filters

Rummy is a hooks-and-filters system. Every structural seam in the
pipeline is a hookable checkpoint. Plugins subscribe to events
(fire-and-forget side effects) and filters (transformation chains
that thread a value through subscribers in priority order).

**Every `<tag>` the model sees is a plugin.** The `<known>` section
of the system message is rendered by the known plugin. The `<progress>`
section is rendered by the progress plugin. The `<prompt>` tag is
rendered by the prompt plugin. No monolithic assembler decides what goes where.
Each plugin filters for its own data from the shared row set, renders
its section, and returns.

**Plugins compose, they don't coordinate.** A plugin subscribes to a
filter at a priority. It receives the accumulator value, appends its
contribution, and returns. It doesn't know what other plugins exist.
Priority determines ordering. Lower numbers run first.

**The core is a filter chain invocation.** The TurnExecutor computes
`loopStartTurn` (one value from one row), then calls
`assembly.system.filter(instructions, ctx)` and
`assembly.user.filter("", ctx)`. Everything else is plugins.

---

## 1. The Known Store

All model-facing state lives in `known_entries`. Files, knowledge, tool
results, skills, audit — everything is a keyed entry with a URI scheme,
body, attributes, and state.

### 1.1 Schema

```sql
known_entries (
    id, run_id, loop_id, turn, path, body, scheme,
    status INTEGER, fidelity TEXT, hash,
    attributes, tokens, refs, write_count,
    created_at, updated_at
)
```

| Column | Purpose |
|--------|---------|
| `path` | Entry identity. Bare paths (`src/app.js`) or URIs (`known://auth`). Max 2048 chars. |
| `body` | Tag body text. File content, tool output, skill docs. |
| `attributes` | Tag attributes as JSON. Handler-private workspace. `CHECK (json_valid)` |
| `scheme` | Generated from path via `schemeOf()`. Drives dispatch and view routing |
| `status` | HTTP status code (200, 202, 400, 413, etc.) |
| `fidelity` | Visibility level: full, summary, archive |
| `hash` | SHA-256 for file change detection |
| `tokens` | Full-body token cost. Never changes on demotion/promotion. |
| `turn` | Freshness — when was this entry last touched |

### 1.2 Schemes, Status & Fidelity

Every entry has two independent dimensions: **status** (HTTP integer)
and **fidelity** (visibility level). These are separate concerns.

**Status** (lifecycle): 200 (OK), 202 (proposed), 400 (bad request),
404 (not found), 409 (conflict), 413 (too large), 499 (aborted),
500 (error).

**Fidelity** (visibility): `full` (body visible), `summary`
(model-authored summary), `index` (path only), `archive` (invisible,
retrievable via `<get>`).

Paths use URI scheme syntax. Bare paths (no `://`) are files.

Every entry plays one of four roles:

| Role | Category | Section | Description |
|------|----------|---------|-------------|
| **Data** | `data` | `<knowns>` | Entries the model works with — persistent state |
| **Logging** | `logging` | `<performed>`/`<previous>` | Records of what happened — tool results, lifecycle signals |
| **Unknowns** | `unknown` | `<unknowns>` | Open questions the model is tracking |
| **Prompt** | `prompt` | `<prompt>` | The task driving the loop |

`logging` is the default category. Plugins opt into `data` explicitly.

| Scheme | Category | Description |
|--------|----------|-------------|
| `NULL` (bare path) | data | File content. JOINs via `COALESCE(scheme, 'file')`. `file://` prefix stripped by hedberg. |
| `known://` | data | Model-registered knowledge. One fact per entry. |
| `skill://` | data | Skill docs. Rendered in system message. |
| `http://`, `https://` | data | Web content. |
| `unknown://` | unknown | Unresolved questions. |
| `prompt://` | prompt | User prompt with `mode` attribute (`ask`/`act`). |
| `set://`, `get://`, `sh://`, `env://`, `rm://`, `mv://`, `cp://`, `ask_user://`, `search://` | logging | Tool result entries. |
| `summarize://`, `update://` | logging | Lifecycle signals. |
| `tool://` | audit | Internal plugin metadata. `model_visible = 0`. |
| `system://`, `reasoning://`, `model://`, `error://`, `user://`, `assistant://`, `content://` | audit | Audit entries. `model_visible = 0`. |

### 1.3 Scheme Registry

The `schemes` table is a bootstrap registry — static rows of
`(name, model_visible, category)`. Plugins register their scheme
via `core.registerScheme()` in the constructor. The `model_visible`
flag controls whether entries appear in `v_model_context`.

### 1.4 UPSERT Semantics

INSERT OR REPLACE on `(run_id, path)`. Each write increments `write_count`.
Blank body is valid. Deletion uses `<rm>`, which removes the row entirely.

---

## 2. Relational Tables

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
  -- Project-level config. NOT tool dispatch. See §2.3.
turn_context     (id, run_id, loop_id, turn, ordinal, path, scheme,
                  status, fidelity, body, tokens, attributes,
                  category, source_turn)
rpc_log          (id, project_id, method, rpc_id, params, result, error)
```

**No sessions.** Runs belong to projects. Any client that knows the project
name can access any run. Temperature, persona, and context_limit are per-run.

**Models** are bootstrapped from `RUMMY_MODEL_*` env vars at startup (upsert).
Clients can add/remove models at runtime via RPC. No default model — the
client picks for every run.

### 2.1 Run State Machine

All status fields are HTTP integer codes:

```
100 (queued) → 200 (running) → 202 (proposed) → 200 (running) → 200 (completed)
                              → 200 (completed)
                              → 500 (failed) → 200 (running)
                              → 499 (aborted) → 200 (running)
```

All terminal states allow transition back to `running`. Runs are long-lived.

### 2.2 Loops Table

The loops table IS the prompt queue. Each `ask`/`act` creates a loop.
FIFO per run (ordered by sequence). One active at a time. Abort stops
the current loop; pending loops survive. Projects > runs > loops > turns.

### 2.3 File Constraints

The `file_constraints` table is project-level configuration — it
defines which files a project cares about. This is backbone, not tool
dispatch. Constraints have three visibilities: `active` (promoted to
full), `readonly` (promoted but not editable), `ignore` (demoted).

**Boundary:** Setting a constraint (`File.setConstraint`) is a
project-config write. Promoting/demoting the matching entries is tool
dispatch that goes through the handler chain with budget enforcement.
These are separate operations: constraint persists across runs, entry
promotion is scoped to a run and subject to the same budget rules as
a model `<get>`.

`store` RPC manages constraints directly — it is not a model tool.
`get` RPC with `persist` sets the constraint AND dispatches promotion.

---

## 3. Entry-Driven Dispatch

### 3.1 Unified API

Three callers, one interface. Each tier is a superset of the one below.

| Tier | Transport | Invocation shape |
|------|-----------|-----------------|
| Model | XML tags | `{ name: "rm", path: "file.txt" }` |
| Client | JSON-RPC | `{ method: "rm", params: { path: "file.txt" } }` |
| Plugin | PluginContext | `rummy.rm({ path: "file.txt" })` |

`name` (model) = `method` (client) = method name (plugin). The params
object is the same shape at every tier.

| Method | Model | Client | Plugin |
|--------|-------|--------|--------|
| `get`, `set`, `rm`, `mv`, `cp`, `sh`, `env`, `search` | ✓ | ✓ | ✓ |
| `known`, `unknown`, `ask_user`, `summarize`, `update` | ✓ | ✓ | ✓ |
| `ask`, `act`, `resolve`, `abort`, `startRun` | — | ✓ | ✓ |
| `getRuns`, `getModels`, `getEntries` | — | ✓ | ✓ |
| `on()`, `filter()`, db/store access | — | — | ✓ |

Model tier restrictions enforced by unified `resolveForLoop(mode, flags)`.
Ask mode excludes `sh`. Flags: `noInteraction` excludes `ask_user`,
`noWeb` excludes `search`, `noProposals` excludes `ask_user`/`env`/`sh`.
14 model tools: think, unknown, known, get, set, env, sh, rm, cp, mv,
ask_user, update, summarize, search.
Client tier requires project init. Plugin tier has no restrictions.

### 3.2 Dispatch Path

All three tiers feed the same handler chain:

```
Model:  XmlParser → { name, path, ... } → #record() → dispatch(scheme, entry, rummy)
Client: JSON-RPC  → { method, params }   → #record() → dispatch(scheme, entry, rummy)
Plugin: rummy.rm({ path })               → #record() → dispatch(scheme, entry, rummy)
```

**Tool dispatch:** Commands are dispatched sequentially in the order
the model emitted them. Each tool either succeeds (200), fails (400+),
or proposes (202). On failure, all remaining tools are aborted. On
proposal, dispatch pauses, a notification is pushed to the client
(same WebSocket push pattern as `run/progress`), the client resolves
(accept/reject), and dispatch resumes — the proposal becomes 200 or
400+ like any other tool. The `ask`/`act` RPC response is only sent
when all tools have completed. Proposals are NOT batched — each is
sent and resolved inline during dispatch. The model controls tool
ordering; the system respects it.

If the model sends `<summarize>` but a preceding action in the same
turn failed, the summarize is overridden to an update (the model's
assertion that it's done is false). Both `<summarize>` and `<update>`
present → last signal wins.

**Post-dispatch budget check:** After all tools dispatch, the system
materializes context and checks the budget ceiling. If context exceeds
the ceiling, Turn Demotion fires — all entries from this turn are
demoted to summary and a `budget://` entry is written. This is a
system housekeeping step independent of tool success/failure. The
tools already ran; their outcomes are settled.

### 3.3 Plugin Convention

A plugin is an instantiated class. The class name matches the file name.
The constructor receives `core` (a PluginContext) — the plugin's
complete interface with the system.

```js
export default class Rm {
    #core;

    constructor(core) {
        this.#core = core;
        core.on("handler", this.handler.bind(this));
        core.on("full", this.full.bind(this));
    }

    async handler(entry, rummy) {
        // rummy here is per-turn RummyContext (not the startup PluginContext)
    }

    full(entry) {
        return `# rm ${entry.attributes.path}`;
    }
}
```

**Two objects:**
- `this.#core` — PluginContext (startup). For registration: `on()`, `filter()`.
- `rummy` argument — RummyContext (per-turn). For runtime: tool verbs, queries.

**Plugin types:**
- **Tool plugins**: register `handler` + `full`/`summary`. Model-invokable.
- **Assembly plugins**: register `core.filter("assembly.system", ...)`. Own a packet tag.
- **Infrastructure plugins**: register `core.on("turn", ...)`. Background work.

A plugin can be multiple types. Known is a tool AND an assembly plugin.

### 3.4 Mode Enforcement

All tools are available by default. In ask mode, the core removes
act-only tools (`sh`, file-scheme `set`) from the tool list. This is
a core concern — plugins do not declare their modes.

---

## 4. Message Structure

Two messages per turn. System = stable truth. User = active task.

### 4.1 Packet Structure

```
[system]
    [instructions]
        [sacred_prompt/]
        [toolDescriptions/]
        [persona/]
        [skills/]
    [/instructions]
    <knowns>
        ...entries sorted by fidelity (summary, full), then by scheme
    </knowns>
    <previous>
        (pre-loop entries, each with turn, status, summary, fidelity, tokens)
    </previous>
    <unknowns>
        (open questions, each with path, turn, fidelity, tokens)
    </unknowns>
[/system]
[user]
    <performed>
        (current loop entries, each with turn, status, summary, fidelity, tokens)
    </performed>
    <progress turn="N">token budget, fidelity stats, causal bridge</progress>
    <prompt mode="ask|act" tools="...">user prompt</prompt>
[/user]
```

**System** contains everything the model needs to know.
**User** contains everything the model needs to do.

The `<prompt>` tag is present on every turn — first turn and
continuations alike. The model always sees its task. The active prompt
is extracted from its chronological position and placed last for maximum
recency. `<progress>` bridges the gap, narrating the causal relationship
between `<performed>` (the work) and the prompt (the cause).

### 4.2 Loops, Previous, and Performed

A **loop** is one `ask` or `act` invocation and all its continuation
turns until summarize, fail, or abort.

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

### 4.3 Key Entries

| Path | Lifetime | Body | Attributes |
|------|----------|------|-----------|
| `instructions://system` | One per run (mutable) | Empty (projection builds from preamble + plugins) | `{ persona }` |
| `system://N` | Audit, one per turn | Full assembled system message | — |
| `user://N` | Audit, one per turn | Full assembled user message | — |
| `assistant://N` | Audit, one per turn | Model's raw response | — |

`instructions://system` is the only mutable entry in this group. The
framework auto-populates `toolDescriptions` from tool registrations
that include `docs`. The instructions projection assembles the final
text from body + attributes.

### 4.4 Materialization

Each turn:

1. Write `instructions://system` (empty body, attributes = { persona })
2. Emit `turn.started` — plugins write prompt/instructions entries
3. Project `instructions://system` → instructions text
4. Query `v_model_context` VIEW → visible entries
5. Project each entry through its tool's `full`/`summary` projection
6. Insert projected rows into `turn_context`
7. Invoke `assembly.system` filter chain (instructions text as base):
   - Known plugin (priority 100) → `<known>` section
   - Previous plugin (priority 200) → `<previous>` section
   - Unknown plugin (priority 300) → `<unknowns>` section
8. Invoke `assembly.user` filter chain (empty string as base):
   - Performed plugin (priority 100) → `<performed>` section
   - Progress plugin (priority 200) → `<progress>` section
   - Prompt plugin (priority 300) → `<prompt>` section
9. Store as `system://N` and `user://N` audit entries

The VIEW determines visibility from `fidelity` and `status`:
- `full` → body visible
- `summary` → summary visible (model-authored `summary` attribute if set)
- `index` → path listed, no content
- `archive` → invisible (retrievable via `<get>`)

**Partial read:** `<get path="..." line="N" limit="M"/>` returns lines N through
N+M−1 of the entry body as the log item without changing fidelity or promoting
the entry to context. Use after reading `summary` fidelity (which gives line
numbers via repomap) to target a specific symbol. Single-path only — glob or
body filter with `line`/`limit` is a 400 error.
- `status = 202` → invisible (proposed, pending client)
- `model_visible = 0` → invisible (audit, tool, instructions)

Model controls fidelity via `<set>` attributes: `archive`, `summary`,
`index`, `full`. The `summary="..."` attribute attaches a description
(<= 80 chars) that persists across fidelity changes.

### 4.5 Budget Enforcement

The model owns its context. The system enforces a hard ceiling and
provides advisory warnings — it does not automatically manage entries.

**Pre-LLM check:** The budget plugin measures `countTokens()` on the
assembled messages. If assembled tokens exceed `contextSize`, the turn
returns 413 without calling the LLM. This triggers panic mode (see
§4.6).

**Write-layer gate:** BudgetGuard on KnownStore gates every write
during dispatch. `upsert()`, `promoteByPattern()`, and
`updateBodyByPattern()` check token delta against remaining headroom.
Exceeding the budget throws `BudgetExceeded` — the tool 413s, the
guard trips, and all subsequent tools in the turn fail.

BudgetGuard ceiling = `floor(contextSize × 0.9) − 500`. The 500-token
buffer below the enforce ceiling absorbs two sources of overhead that
BudgetGuard cannot see: (a) `#record()`-phase writes that bypass the
guard (~15 tokens per command), and (b) loop transition overhead —
when a loop completes and a new one starts, entries shift from
`<performed>` to `<previous>` format, adding ~200–300 tokens to the
next assembly. Without this buffer, the base context can accumulate
to exactly the enforce ceiling, making it impossible for the panic
loop to start (panic prompt + loop overhead > ceiling).

**Exemptions:** `status >= 400` entries (error results), `model_visible
= 0` entries (audit), `fidelity = "archive"` entries (not in context).

**Size gate:** Known entries exceeding 500 tokens are rejected with
413, forcing atomic entries.

**Advisory warnings** (progress plugin):
- 50%: "You may free space by lowering the fidelity of entries"
- 75%: "YOU MUST free space... or the run will fail"

**Token math:** `Math.ceil(text.length / RUMMY_TOKEN_DIVISOR)`. One
formula, one file (`src/agent/tokens.js`), env-configurable. No
external dependencies. `contextSize` is the ceiling. Over = 413.
Under = 200. No margins.

**Three token measures — never conflate them:**

| Measure | Source | Scope | Use |
|---|---|---|---|
| SQL entry tokens | `known_entries.tokens` = `ceil(chars / DIVISOR)` | Per entry | Model decision-making: "this entry costs N tokens" |
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

### 4.6 Panic Mode

**The invariant.** A panic is only ever triggered because the
assembled context was under the ceiling — and the new prompt pushed
it over. The existing context fit; the incoming prompt did not.
Panic mode replaces that too-large incoming prompt with a small
panic prompt on the same context. Therefore: the first turn of a
panic loop cannot 413. If it does, it is a bug.

**Trigger.** `TurnExecutor.execute()` assembles the full packet
(context + incoming prompt) before calling the LLM. If
`assembledTokens > contextSize`, it returns 413 without calling
the LLM. `#drainQueue` intercepts this and enters panic mode.

**Flow.**
1. Complete the failed loop with status 413 (audit trail).
2. Enqueue a panic loop (`mode = "panic"`, `noRepo = true`,
   `prompt = panicPrompt`, `panicTarget` in config).
3. Re-enqueue the original loop with `panicAttempted: true` in
   its config JSON. This flag persists across drain cycles.
4. `continue` — the drain loop claims the panic loop next.

After panic completes (model freed enough space), the retry loop
runs. If the retry also 413s, hard-fail to client. One panic
attempt per drain cycle — `panicAttempted` is checked both as a
local variable and on the re-enqueued loop's config.

**Panic target.** The model must compress context to below:

```
panicTarget = MIN(contextSize × 0.75, contextSize − incomingTokens) − cushion
```

`incomingTokens` is the raw token count of the original prompt.
`cushion` is a small safety margin (500 tokens) to absorb
materialization overhead. The target is expressed in materialized
token units — the same unit the system uses to measure completion
(see Token Math below).

**Two token contexts.**

The model reasons in *per-entry SQL tokens* — the token counts
visible in `<knowns>` entries. These are the granular unit the model
uses to decide which entries to target: "this entry is 200 tokens;
if I archive it, I save 200 tokens."

The system makes decisions using *actual API tokens* —
`turns.context_tokens` back-filled from `usage.input_tokens` after
each LLM call. SQL token sums do not equal actual API counts because
projections, assembly overhead, and fidelity transforms alter the
output; and the SQL estimate (`ceil(chars / DIVISOR)`) can be 3–7×
off for structured content. **Never use SQL token sums for ceiling or
budget decisions.** See §4.5 Token Measures for the full breakdown.

**Strike system.** After each panic turn, compare
`result.assembledTokens` (materialized) with `_lastPanicTokens`
(previous turn's materialized total):
- Decreased → reset strike counter to 0.
- Same or increased → increment strikes.
- 3 consecutive strikes → return 413 to `#drainQueue` → hard-fail.

Progress (any reduction) resets the counter. The model has
unlimited turns as long as it makes progress.

**Panic success.** After each turn, if `result.assembledTokens
<= panicTarget`, the panic loop exits with 200. The retry loop
then runs with the original prompt on the now-compressed context.

**Tool set.** `resolveForLoop("panic")` includes: get, set, known,
unknown, rm, mv, cp, summarize, update. Excludes: sh, env, search,
ask_user. `noRepo: true` — no file scanning during panic.

**What the model sees.** Turn 1 receives the panic prompt from
`budget.panicPrompt()`: the assembled token count, the target, and
the exact number of tokens to free. Turn 2+ receives a continuation
prompt. The model uses `<set fidelity="archive">`, `<mv
fidelity="summary">`, and similar fidelity operations to free space,
concluding with `<summarize>` when done or `<update>` while working.

---

## 5. RPC Protocol

JSON-RPC 2.0 over WebSocket. `discover` returns the live catalog.

### 5.1 Methods

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

### 5.2 Notifications

| Notification | Scoped by |
|-------------|-----------|
| `run/state` | projectId |
| `run/progress` | projectId |
| `ui/render` | projectId |
| `ui/notify` | projectId |

### 5.3 Resolution

| Resolution | Model signal | Outcome |
|-----------|-------------|---------|
| reject | any | `completed` — rejection stops the bus |
| accept | `<update>` | `running` — model has more work |
| accept | `<summarize>` | `completed` |
| accept | neither | `running` — healer decides |
| error | any | `running` — error state, model retries |

---

## 6. Plugin System

See [PLUGINS.md](PLUGINS.md) for the full plugin development guide,
including the RummyContext API, tool registration, handler chains,
projections, events, filters, and hedberg pattern library.

Each plugin has its own README at `src/plugins/{name}/README.md`.

---

## 7. Tool Documentation Design

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
docs end with `<set path="..." fidelity="summary"/>`. The known docs
reference `<get path="known://*">keyword</get>` for recall and
`<set path="known://..." archive/>` for archiving. The unknown docs
reference `<get/>` for investigation and `<rm/>` for cleanup. A model
reading the full tool docs encounters a coherent workflow:
discover → load → reason → edit → archive → recall.

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

## 8. Hedberg Editing Syntax

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

## 9. Response Healing

The server never throws on model output. "Model behavior" is never an
acceptable explanation. Recovery order:

1. Can we recover? Extract the data and continue.
2. Can we warn? Log structured warnings.
3. Did our structure cause this? Check formatting, prompts.

Termination protocol:
- `<summarize>` → run terminates
- `<summarize>` + failed actions → overridden to `<update>` (continue)
- `<update>` → run continues
- Both → last signal wins (respects the model's final intent)
- Neither + investigation tools → stall counter (RUMMY_MAX_STALLS)
- Neither + action-only tools → healed to summarize
- Neither + plain text → healed to summarize
- Repeated commands → cycle detection (RUMMY_MIN_CYCLES, RUMMY_MAX_CYCLE_PERIOD)
- Repeated update text → stall (RUMMY_MAX_UPDATE_REPEATS)

Format normalization:
- Gemma `\`\`\`tool_code` fences → stripped before parsing
- Qwen `<|tool_call>` format → normalized to XML
- OpenAI function_call JSON → normalized to XML
- Mistral `[TOOL_CALLS]` → normalized to XML
- Sed alternate delimiters (`s|old|new|`) → parsed like `s/old/new/`

---

## 10. Testing

| Tier | Location | LLM? |
|------|----------|------|
| Unit | `src/**/*.test.js` | No |
| Integration | `test/integration/` | No |
| Live | `test/live/` | Yes |
| E2E | `test/e2e/` | Yes |

E2E tests must NEVER mock the LLM. Environment cascade:
`.env.example` → `.env` → `.env.test`. Always use `npm run test:*`.

---

## 11. SQL Functions

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

## 13. Debugging: E2E and Benchmark Results

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
- **413**: budget overflow — assembled context exceeded ceiling before LLM call
- **BudgetGuard errors**: per-tool rejections mid-turn (`Budget exceeded: N tokens requested`)
- **`<sh>` in act/panic mode**: model fell back to shell when blocked (doc/prompt gap)
- Loop sequence: look for `mode` in `instructions://system` attrs to see which loop type ran

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

## 12. Configuration

```env
RUMMY_HOME=~/.rummy
RUMMY_TOKEN_DIVISOR=2
RUMMY_MAX_TURNS=99
RUMMY_MAX_STALLS=3
RUMMY_MIN_CYCLES=3
RUMMY_MAX_CYCLE_PERIOD=4
RUMMY_MAX_UPDATE_REPEATS=3
RUMMY_RETENTION_DAYS=31
RUMMY_TEMPERATURE=0.5
RUMMY_DEBUG=false
```

Model aliases: `RUMMY_MODEL_{alias}={provider/model}`. Seeded into
`models` table at startup.
