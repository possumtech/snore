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
    id, run_id, turn, path, body, scheme, state, hash,
    attributes, tokens, tokens_full, refs, write_count,
    created_at, updated_at
)
```

| Column | Purpose |
|--------|---------|
| `path` | Entry identity. Bare paths (`src/app.js`) or URIs (`known://auth`) |
| `body` | Tag body text. File content, tool output, skill docs. |
| `attributes` | Tag attributes as JSON. Handler-private workspace. `CHECK (json_valid)` |
| `scheme` | Generated from path via `schemeOf()`. Drives dispatch and view routing |
| `state` | Lifecycle stage. Determines model visibility |
| `hash` | SHA-256 for file change detection |
| `tokens` | Context cost at current state |
| `tokens_full` | Cost of raw body at full fidelity |
| `turn` | Freshness — when was this entry last touched |

### 1.2 Schemes & States

Paths use URI scheme syntax. Bare paths (no `://`) are files.

**Files** (`scheme IS NULL`):

| State | Model sees |
|-------|-----------|
| `full` | File content in code fence |
| `index` | Path listed in File Index |
| `stored` | Invisible, retrievable via `<get>` |

**Knowledge** (`known://`, `unknown://`):

| State | Model sees |
|-------|-----------|
| `full` | Key — value in bullet list |
| `stored` | Key listed, no value |

**Tool results** (`set://`, `sh://`, `env://`, `rm://`, `ask_user://`,
`mv://`, `cp://`, `search://`, `get://`):

All entries use HTTP status codes: 200 (OK), 202 (proposed), 400 (bad
request), 403 (rejected), 404 (not found), 409 (conflict), 413 (too
large), 500 (error). Fidelity managed independently: full, summary,
index, stored.

**Bare file paths** have `scheme IS NULL`. The `file` scheme entry in the
schemes table enables JOINs via `COALESCE(scheme, 'file')`. The `file://`
prefix is stripped silently by hedberg normalization — bare paths are the
convention.

**Skills** (`skill://`): `full` or `stored`. Rendered in system message.

**Tools** (`tool://`): `full`, `model_visible = 0`. Internal plugin metadata.

**URLs** (`http://`, `https://`): `full`, `summary`, `stored`.

**Structural** (`summarize://`, `update://`): Status signals.

**Audit** (`system://`, `prompt://`, `ask://`, `act://`, `progress://`,
`reasoning://`, `model://`, `error://`, `user://`, `assistant://`,
`content://`): `info` state, `model_visible = 0` (hidden from model).

### 1.3 State Validation

The `schemes` table is a bootstrap registry — 30 rows of static config.
INSERT/UPDATE triggers validate state against `schemes.valid_states`.
Plugins cannot bypass this (circular dependency prevents schemes as entries).

### 1.4 UPSERT Semantics

INSERT OR REPLACE on `(run_id, path)`. Each write increments `write_count`.
Blank body is valid. Deletion uses `<rm>`, which removes the row entirely.

---

## 2. Relational Tables

The K/V store is the memory. Relational tables are the skeleton.

```sql
projects (id, name UNIQUE, project_root, config_path, created_at)
models   (id, alias UNIQUE, actual, context_length, created_at)
runs     (id, project_id, parent_run_id, model, alias UNIQUE, status,
          temperature, persona, context_limit, next_turn, created_at)
turns    (id, run_id, sequence, prompt_tokens, completion_tokens,
          total_tokens, cost, created_at)

file_constraints (id, project_id, pattern, visibility, created_at)
prompt_queue     (id, run_id, mode, model, prompt, config, status, result)
rpc_log          (id, project_id, method, rpc_id, params, result, error)
```

**No sessions.** Runs belong to projects. Any client that knows the project
name can access any run. Temperature, persona, and context_limit are per-run.

**Models** are bootstrapped from `RUMMY_MODEL_*` env vars at startup (upsert).
Clients can add/remove models at runtime via RPC. No default model — the
client picks for every run.

### 2.1 Run State Machine

```
queued → running → proposed → running → completed
                → completed
                → failed → running
                → aborted → running
```

All terminal states allow transition back to `running`. Runs are long-lived.

### 2.2 Prompt Queue

All prompts flow through `prompt_queue`. FIFO per run. One active at a time.
Abort stops the current prompt; pending prompts survive.

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
| `get`, `set`, `rm`, `mv`, `cp`, `sh`, `env` | ✓ | ✓ | ✓ |
| `known`, `unknown`, `ask_user`, `summarize`, `update` | ✓ | ✓ | ✓ |
| `ask`, `act`, `resolve`, `abort`, `startRun` | — | ✓ | ✓ |
| `getRuns`, `getModels`, `getEntries` | — | ✓ | ✓ |
| `on()`, `filter()`, db/store access | — | — | ✓ |

Model tier restrictions enforced by unified `resolveForLoop(mode, flags)`.
Ask mode excludes `sh`. Flags: `noInteraction` excludes `ask_user`,
`noWeb` excludes `search`, `noBench` excludes `ask_user`/`env`/`sh`.
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
    <knowledge>
        ...entries sorted by fidelity (index, summary, full), then by scheme
    </knowledge>
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

### 4.5 Budget Cascade

Context overflow is structurally impossible. After materialization, the
budget plugin (`src/plugins/budget/`) enforces a ceiling of 95% of the
model's context window. If assembled tokens exceed the ceiling, entries
are degraded through two phases: the crunch spiral and the death spiral.

**Selection: fattest half of oldest half.** No scheme-based priority.
Sort all candidates by `source_turn` ASC (oldest first), take the oldest
half, then within that half sort by `tokens` DESC (fattest first) and
take the fattest half. This selects 25% of entries per pass — the
simultaneously oldest AND largest entries.

**Protected categories:** `system`, `tool`, and `prompt` entries are
exempt from crunching and stashing. Stash entries (`known://stash_*`)
are also exempt.

**Crunch spiral** (graceful degradation):
- Full entries → set to summary fidelity. The `summarize` callback fires
  for entries without `attributes.summary` (see § 4.6).
- Summary entries with summaries > 80 chars → summary text halved
  deterministically (no LLM call). Repeated: 2000→1000→500→250→125→80.
- Summary entries whose summaries shrink below 10 chars → index fidelity.
- Repeat until under budget or no crunchable entries remain.

`ToolRegistry.view()` prepends `attributes.summary` above whatever the
plugin's summary view returns. Files at summary fidelity render as:
description line + symbols. All schemes benefit automatically.

**Death spiral** (last resort):
- Sort remaining summary/index entries by `source_turn` ASC.
- Stash the oldest half by scheme into `known://stash_<scheme>` index
  entries. Stash body = newline-separated paths of stored entries.
- Repeat until under budget or nothing left to stash.

**Crash:** If stashes + system prompt + tool docs don't fit, that's a
configuration error — the model's context window is too small.

**Callbacks:**
- `rematerialize`: After each pass, re-queries `v_model_context`,
  re-projects through view handlers, re-assembles messages.
- `summarize`: During crunch spiral, fires for full→summary entries
  missing `attributes.summary`. See § 4.6.

### 4.6 Crunch: Mid-Cascade Summarization

The **crunch plugin** (`src/plugins/crunch/`) subscribes to
`cascade.summarize`. When the crunch spiral demotes full entries to
summary and they lack summaries, it generates keyword descriptions.

**Flow:**
1. Crunch spiral selects entries for full→summary demotion
2. Filters to entries missing `attributes.summary`
3. Fires `summarize` callback with the batch
4. Crunch plugin compresses each entry to ≤80 chars of keywords
5. One LLM call per batch (direct, no run/loop overhead)
6. Parses response: one line per entry, `path → keywords`
7. Writes to `attributes.summary` via `KnownStore.setAttributes()`
8. Cascade calls `rematerialize` — summaries render via ToolRegistry

**Cost:** One LLM call per cascade invocation (not per halving pass).
All unsummarized full entries are batched upfront before the halving
spiral begins. After first crunch, entries have permanent summaries.
Future cascades skip the call for those entries entirely.

**Failure:** If the LLM call fails, entries are still demoted — they
render with empty summaries. Logged as `[RUMMY] Crunch: summarization
failed`.

**Debug:** When `RUMMY_DEBUG=true`, full request/response logged.

### 4.7 progress:// as Entry

The continuation prompt is a `progress://N` entry. Plugins can modify its
body before materialization.

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
| `ask` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noContext?, noInteraction?, noWeb?, fork? }` |
| `act` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noContext?, noInteraction?, noWeb?, fork? }` |
| `run/resolve` | `{ run, resolution: { path, action, output? } }` |
| `run/abort` | `{ run }` |
| `run/rename` | `{ run, name }` |
| `run/inject` | `{ run, message }` |
| `run/config` | `{ run, temperature?, persona?, contextLimit?, model? }` |

`model` is required on `ask`, `act`, and `startRun`. No default.
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
RUMMY_DEBUG=false
```

Model aliases: `RUMMY_MODEL_{alias}={provider/model}`. Seeded into
`models` table at startup.
