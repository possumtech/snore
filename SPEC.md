# RUMMY: Architecture Specification

The authoritative reference for Rummy's design. The sacred prompt
The instructions plugin (`preamble.md` + tool docs) defines
model-facing behavior. This document defines everything else.

---

## 0. Design Philosophy: Events & Filters

Rummy is a hooks-and-filters system. Every structural seam in the
pipeline is a hookable checkpoint. Plugins subscribe to events
(fire-and-forget side effects) and filters (transformation chains
that thread a value through subscribers in priority order).

**Every `<tag>` the model sees is a plugin.** The `<known>` section
of the system message is rendered by the known plugin. The `<progress>`
section is rendered by the progress plugin. The `<ask>` tag is rendered
by the prompt plugin. No monolithic assembler decides what goes where.
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
    attributes, tokens, tokens_full, refs, write_count,
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
| `fidelity` | Visibility level: full, summary, index, stored |
| `hash` | SHA-256 for file change detection |
| `tokens` | Display-only token count at current fidelity. NEVER used for budget. |
| `tokens_full` | Cost of raw body at full fidelity |
| `turn` | Freshness — when was this entry last touched |

### 1.2 Schemes, Status & Fidelity

Every entry has two independent dimensions: **status** (HTTP integer)
and **fidelity** (visibility level). These are separate concerns.

**Status** (lifecycle): 200 (OK), 202 (proposed), 400 (bad request),
404 (not found), 409 (conflict), 413 (too large), 499 (aborted),
500 (error).

**Fidelity** (visibility): `full` (body visible), `summary`
(model-authored summary), `index` (path only), `stored` (invisible,
retrievable via `<get>`).

Paths use URI scheme syntax. Bare paths (no `://`) are files.

| Scheme | Category | Description |
|--------|----------|-------------|
| `NULL` (bare path) | file | File content. JOINs via `COALESCE(scheme, 'file')`. `file://` prefix stripped by hedberg. |
| `known://` | knowledge | Model-registered knowledge. One fact per entry. |
| `unknown://` | knowledge | Unresolved questions. |
| `set://`, `get://`, `sh://`, `env://`, `rm://`, `mv://`, `cp://`, `ask_user://`, `search://` | result | Tool result entries. |
| `skill://` | knowledge | Skill docs. Rendered in system message. |
| `tool://` | structural | Internal plugin metadata. `model_visible = 0`. |
| `http://`, `https://` | result | Web content. |
| `summarize://`, `update://` | structural | Lifecycle signals. |
| `system://`, `prompt://`, `ask://`, `act://`, `progress://`, `reasoning://`, `model://`, `error://`, `user://`, `assistant://`, `content://` | structural | Audit entries. `model_visible = 0`. |

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
`noWeb` excludes `search`, `noBench` excludes `ask_user`/`env`/`sh`.
13 model tools: get, set, known, unknown, env, sh, rm, cp, mv, search,
summarize, update, ask_user.
Client tier requires project init. Plugin tier has no restrictions.

### 3.2 Dispatch Path

All three tiers feed the same handler chain:

```
Model:  XmlParser → { name, path, ... } → #record() → dispatch(scheme, entry, rummy)
Client: JSON-RPC  → { method, params }   → #record() → dispatch(scheme, entry, rummy)
Plugin: rummy.rm({ path })               → #record() → dispatch(scheme, entry, rummy)
```

**Lifecycle/action split:** Commands are classified as lifecycle signals
(`summarize`, `update`, `unknown`, `known`) or action commands (everything
else). Lifecycle signals always dispatch — they are state declarations that
cannot be 409'd by sequential dispatch. Action commands dispatch sequentially;
a 202 proposal or error aborts subsequent actions. If the model sends
`<summarize>` but actions in the same turn failed, the summarize is
overridden to an update (the model's assertion that it's done is false).

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
        ...entries sorted by fidelity (index, summary, full), then by scheme
    </knowns>
    <previous>
        (pre-loop user prompt, model responses, agent warnings, and tools used, in order)
    </previous>
    <unknowns></unknowns>
[/system]
[user]
    <current>
        (current loop model responses, agent warnings, and tools used, in order)
    </current>
    <progress>the above actions have been performed on this user prompt:</progress>
    <ask tools="..." warn="...">user prompt</ask>
    — OR —
    <act tools="...">user prompt</act>
[/user]
```

**System** contains everything the model needs to know.
**User** contains everything the model needs to do.

The `<ask>`/`<act>` tag is present on every turn — first turn and
continuations alike. The model always sees its task. The active prompt
is extracted from its chronological position and placed last for maximum
recency. `<progress>` bridges the gap, narrating the causal relationship
between `<current>` (the work) and the prompt (the cause).

### 4.2 Loops, Previous, and Current

A **loop** is one `ask` or `act` invocation and all its continuation
turns until summarize, fail, or abort.

**Previous** = all completed loops on this run. The user prompt, model
responses, tool results, agent warnings — the full chronicle in order.
Lives in the system message as established history. Omitted on the
first turn of the first loop.

**Current** = the active loop's work so far. Model responses, tool
results, agent warnings — in order. Does NOT include the user prompt
(one per loop, extracted to `<ask>`/`<act>`). Lives in the user
message as immediate context. Empty on the first turn of a loop.

When a new prompt arrives on an existing run, the prior loop's
`<current>` content plus its prompt move to `<previous>`. When a loop
continues (next turn), new results append to `<current>`.

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
2. Run plugin hooks (`onTurn`) — plugins modify entries before the model sees them
3. Project `instructions://system` → instructions text
4. Query `v_model_context` VIEW → visible entries
5. Project each entry through its tool's `full`/`summary` projection
6. Insert projected rows into `turn_context`
7. Invoke `assembly.system` filter chain (instructions text as base):
   - Known plugin (priority 100) → `<known>` section
   - Previous plugin (priority 200) → `<previous>` section
   - Unknown plugin (priority 300) → `<unknowns>` section
8. Invoke `assembly.user` filter chain (empty string as base):
   - Current plugin (priority 100) → `<current>` section
   - Progress plugin (priority 200) → `<progress>` section
   - Prompt plugin (priority 300) → `<ask>`/`<act>` section
9. Store as `system://N` and `user://N` audit entries

The VIEW determines visibility from `fidelity` and `status`:
- `full` → body visible
- `summary` → summary visible (model-authored `summary` attribute if set)
- `index` → path listed, no content
- `stored` → invisible (retrievable via `<get>`)
- `status = 202` → invisible (proposed, pending client)
- `model_visible = 0` → invisible (audit, tool, instructions)

Model controls fidelity via `<set>` attributes: `stored`, `summary`,
`index`, `full`. The `summary="..."` attribute attaches a description
(<= 80 chars) that persists across fidelity changes.

### 4.5 Budget Enforcement

The model owns its context. The system enforces a hard ceiling and
provides advisory warnings — it does not automatically manage entries.

**Pre-LLM check:** The budget plugin measures `countTokens()` on the
assembled messages. If assembled tokens exceed the model's context
window, the turn returns 413 without calling the LLM.

**Per-entry gate:** During recording, each entry's tokens are checked
against a 95% ceiling minus current usage. Entries that would exceed
the budget are rejected with 413 status and an error message telling
the model to use `<set fidelity="stored">` or `<rm>`.

**Size gate:** Known entries exceeding 500 tokens are rejected with
413, forcing atomic entries.

**Advisory warnings** (progress plugin):
- 50%: "You may free space by lowering the fidelity of entries"
- 75%: "YOU MUST free space... or the run will fail"

**Token math rule:** Budget decisions use ONLY assembled message token
counts. The `tokens` column on `known_entries` is strictly for DISPLAY.
See PLUGINS.md §7.5.

**`ToolRegistry.view()`** prepends `attributes.summary` above the
plugin's summary view output at summary fidelity. The model authors
summaries (<= 80 chars) via `<set summary="...">`. Summaries persist
across fidelity changes.

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
| `get` | `{ path, run?, persist?, readonly? }` |
| `store` | `{ path, run?, persist?, ignore?, clear? }` |
| `set` | `{ run, path, body?, status?, fidelity?, attributes? }` |
| `rm` | `{ run, path }` |
| `getEntries` | `{ pattern?, body?, run?, limit?, offset? }` |

`persist` creates a project-level file constraint (operator privilege).
`store` RPC handles file constraints only — not a model tool.
Without `persist`, operations dispatch through the handler chain.

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
docs end with `<set path="..." fidelity="index"/>`. The known docs
reference `<get path="known://*">keyword</get>` for recall and
`<set path="known://..." stored/>` for archiving. The unknown docs
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
mode restrictions, `noInteraction`, `noWeb`, `noBench` — through
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
- Both → summarize wins
- Neither + investigation tools → stall counter (RUMMY_MAX_STALLS)
- Neither + action-only tools → healed to summarize
- Neither + plain text → healed to summarize
- Repeated commands → loop detection (RUMMY_MAX_REPETITIONS)
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
| `countTokens(text)` | Token count (tiktoken o200k_base, `ceil(len/4)` fallback) |
| `hedmatch(pattern, string)` | Full-string pattern match (paths, equality) |
| `hedsearch(pattern, string)` | Substring pattern search (content filtering) |
| `hedreplace(pattern, replacement, string)` | Pattern-based replacement |
| `slugify(text)` | URI-encoded slug, max 80 chars |

See [PLUGINS.md](PLUGINS.md) for the hedberg pattern type reference.

---

## 12. Configuration

```env
RUMMY_HOME=~/.rummy
RUMMY_MAX_TURNS=99
RUMMY_MAX_STALLS=3
RUMMY_MAX_REPETITIONS=3
RUMMY_MAX_UPDATE_REPEATS=3
RUMMY_RETENTION_DAYS=31
RUMMY_TEMPERATURE=0.5
RUMMY_DEBUG=false
```

Model aliases: `RUMMY_MODEL_{alias}={provider/model}`. Seeded into
`models` table at startup.
