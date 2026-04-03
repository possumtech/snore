# RUMMY: Architecture Specification

The authoritative reference for Rummy's design. The sacred prompt
(`prompt.md`) defines model-facing behavior. This document defines
everything else.

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
| `stored` | Invisible, retrievable via `<read>` |

**Knowledge** (`known://`, `unknown://`):

| State | Model sees |
|-------|-----------|
| `full` | Key — value in bullet list |
| `stored` | Key listed, no value |

**Tool results** (`write://`, `run://`, `env://`, `delete://`, `ask_user://`,
`move://`, `copy://`, `search://`, `read://`, `store://`):

All start at `full` state when recorded. Handlers set the final state:
`proposed`, `pass`, `warn`, `error`, `pattern`, `read`, `stored`, `info`.

**Skills** (`skill://`): `full` or `stored`. Rendered in system message.

**Tools** (`tool://`): `full`. Plugin docs rendered in system message.

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
Blank body is valid. Deletion uses `<delete>`, which removes the row entirely.

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

### 3.1 Model Path

```
Model emits <read path="src/app.js"/>
  → XmlParser produces { name: "read", path: "src/app.js" }
  → TurnExecutor.#record() writes read://src%2Fapp.js at full state
  → hooks.tools.dispatch("read", entry, rummy):
      priority 5: WebPlugin checks if http URL — no, passes through
      priority 10: CoreToolsPlugin promotes file, writes confirmation
  → hooks.entry.created.emit(entry)
```

### 3.2 Client Path

```
Client sends read { run: "turboqwen_123", path: "src/app.js" }
  → buildRunContext() creates RummyContext for the run
  → dispatchTool() records read:// entry at full state
  → hooks.tools.dispatch("read", entry, rummy)  ← same chain
  → hooks.entry.created.emit(entry)
```

Same pipe. No mode enforcement for client (operator privilege).

### 3.3 Handler Registration

```js
hooks.tools.register("search", {
    modes: new Set(["ask", "act"]),
    category: "ask",
    docs: "## <search>...</search>\nSearch the web.",
});

hooks.tools.onHandle("search", async (entry, rummy) => {
    // entry = { scheme, path, body, attributes, state, resultPath }
    // rummy = RummyContext
}, priority);
```

Multiple handlers per scheme. Lower priority runs first. Return `false`
to stop the chain.

### 3.4 Access Tiers

| Caller | Mode enforcement | Handler dispatch |
|--------|-----------------|-----------------|
| Model | Yes (ask/act) | Yes |
| Client (RPC) | No | Yes |
| Plugin (internal) | No | Optional |

### 3.5 Mode Enforcement

In ask mode, TurnExecutor rejects: file writes, file deletes, file
move/copy targets, `<run>`. K/V operations are allowed in both modes.

---

## 4. Context Assembly

Two messages per turn. System = stable truth. User = conversation.

```
system:
  prompt.md (with [%TOOLS%] replaced)
  persona (from runs.persona)
  tool:// docs (plugin documentation)
  skill:// bodies (active skills)
  <context>
    knowledge, stored keys, file index, files, unknowns
  </context>

user:
  <messages>tool results, updates, summaries</messages>
  <ask tools="..." warn="...">question</ask>       ← first turn
  <progress tools="..." warn="...">Turn N/M</progress>  ← continuation
```

### 4.1 Materialization

Each turn, TurnExecutor materializes `turn_context` from `known_entries`
via the `v_model_context` VIEW:

1. Materialize `tool://` entries from ToolRegistry (idempotent)
2. Run plugin hooks (`hooks.processTurn`) — janitor/relevance can modify entries
3. Clear turn_context, insert system prompt, copy from VIEW

The VIEW determines what the model sees. State IS fidelity:
- `full` → body visible
- `summary` → body visible (summary content)
- `index` → path listed, no content
- `stored` → invisible
- `proposed` → invisible (pending client)
- Audit schemes (`model_visible = 0`) → invisible

Render order: tools → knowledge → stored keys → file index → files →
results → structural → unknowns → prompt.

### 4.2 progress:// as Entry

The continuation prompt is a `progress://N` entry in the store. Plugins
can modify its body before materialization. No hardcoded string building.

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
| `read` | `{ path, run?, persist?, readonly? }` |
| `store` | `{ path, run?, persist?, ignore?, clear? }` |
| `write` | `{ run, path, body?, state?, attributes? }` |
| `delete` | `{ run, path }` |
| `getEntries` | `{ pattern?, body?, run?, limit?, offset? }` |

`persist` creates a project-level file constraint (operator privilege).
Without `persist`, operations dispatch through the handler chain.

#### Runs

| Method | Params |
|--------|--------|
| `startRun` | `{ model, temperature?, persona?, contextLimit? }` |
| `ask` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noContext?, fork? }` |
| `act` | `{ prompt, model, run?, temperature?, persona?, contextLimit?, noContext?, fork? }` |
| `run/resolve` | `{ run, resolution: { path, action, output? } }` |
| `run/abort` | `{ run }` |
| `run/rename` | `{ run, name }` |
| `run/inject` | `{ run, message }` |
| `run/config` | `{ run, temperature?, persona?, contextLimit?, model? }` |

`model` is required on `ask`, `act`, and `startRun`. No default.

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

Skills loaded from `config_path/skills/{name}.md`. Personas from
`config_path/personas/{name}.md`.

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

---

## 6. Plugin System

Plugins extend rummy through registration. Core and third-party use the
same interface. No distinction at the registration level.

### 6.1 Plugin Contract

```js
export default class MyPlugin {
    static register(hooks) {
        // Register tools, RPC methods, turn processors, event listeners
    }
}
```

Loading: `src/plugins/` (built-in) then `~/.rummy/plugins/` (user).

### 6.2 Tool Registry (`hooks.tools`)

```js
hooks.tools.register(name, { modes, category, docs?, handler? });
hooks.tools.onHandle(scheme, handler, priority);
await hooks.tools.dispatch(scheme, entry, rummy);
await hooks.tools.materialize(store, runId, turn);
```

### 6.3 RummyContext (`rummy`)

Tool methods (same verbs as model and client):

| Method | Effect |
|--------|--------|
| `rummy.write({ path, body, state, attributes })` | Create/update entry |
| `rummy.read(path)` | Promote to full |
| `rummy.store(path)` | Demote to stored |
| `rummy.delete(path)` | Remove permanently |
| `rummy.move(from, to)` | Move entry |
| `rummy.copy(from, to)` | Copy entry |

Plugin-only:

| Property/Method | Purpose |
|----------------|---------|
| `rummy.entries` | KnownStore instance |
| `rummy.hooks` | Hook system |
| `rummy.db` | Database |
| `rummy.getAttributes(path)` | Read entry attributes |
| `rummy.getEntries(pattern, body?)` | Pattern query |
| `rummy.log(message)` | Audit log entry |

### 6.4 Turn Processors (`hooks.onTurn`)

```js
hooks.onTurn(async (rummy) => {
    // Runs before materialization. Modify entries to affect model view.
}, priority);
```

### 6.5 Events & Filters

Events: `project.init.started/completed`, `run.started/progress/state/step.completed`,
`ask.started/completed`, `act.started/completed`, `llm.request.started/completed`,
`entry.created`, `ui.render`, `ui.notify`, `rpc.started/completed/error`.

Filters: `llm.messages`, `llm.response`, `file.symbols`, `run.config`,
`socket.message.raw`, `rpc.request`, `rpc.response.result`.

### 6.6 Bundled Plugins

| Plugin | Purpose |
|--------|---------|
| `tools` | Core tool handlers (read, write, store, delete, etc.) |
| `rpc` | RPC method registration |
| `skills` | Skill/persona file loading and RPCs |
| `web` | Web search and URL fetching |
| `engine` | Empty — placeholder for janitor/relevance plugins |
| `symbols` | Symbol extraction via antlrmap + ctags |
| `telemetry` | Debug logging |
| `git` | Git detection |

---

## 7. Hedberg Editing Syntax

The model picks its preferred edit format. The parser understands all of them:

1. Git merge conflict: `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`
2. Replace-only: `======= ... >>>>>>> REPLACE`
3. Unified diff: `@@ -1,3 +1,3 @@` with `-`/`+` lines
4. Claude XML: `<old_text>old</old_text><new_text>new</new_text>`
5. JSON body: `{"search": "old", "replace": "new"}`
6. XML attributes: `<write search="old" replace="new"/>`
7. Full replacement: anything else becomes the new content

---

## 8. Response Healing

The server never throws on model output. Recovery order:

1. Can we recover? Extract the data and continue.
2. Can we warn? Log structured warnings.
3. Did our structure cause this? Check formatting, prompts.
4. Model drift is the LAST answer.

Termination protocol:
- `<summarize>` → run terminates
- `<update>` → run continues
- Both → summarize wins
- Neither + tools → stall counter
- Neither + plain text → healed to summarize
- Repeated commands → loop detection

---

## 9. Testing

| Tier | Location | LLM? |
|------|----------|------|
| Unit | `src/**/*.test.js` | No |
| Integration | `test/integration/` | No |
| Live | `test/live/` | Yes |
| E2E | `test/e2e/` | Yes |

E2E tests must NEVER mock the LLM. Environment cascade:
`.env.example` → `.env` → `.env.test`. Always use `npm run test:*`.

---

## 10. SQL Functions

| Function | Purpose |
|----------|---------|
| `schemeOf(path)` | Extract URI scheme |
| `countTokens(text)` | Token count (tiktoken o200k_base, `ceil(len/4)` fallback) |
| `hedberg(pattern, string)` | Universal pattern matching (glob, regex, XPath, JSONPath) |
| `slugify(text)` | URI-encoded slug, max 80 chars |

---

## 11. Configuration

```env
RUMMY_HOME=~/.rummy
RUMMY_MAX_TURNS=15
RUMMY_MAX_STALLS=3
RUMMY_MAX_REPETITIONS=3
RUMMY_RETENTION_DAYS=31
RUMMY_TEMPERATURE=0.7
RUMMY_DEBUG=false
```

Model aliases: `RUMMY_MODEL_{alias}={provider/model}`. Seeded into
`models` table at startup.
