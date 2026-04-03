# AGENTS: Planning & Progress

> Every piece of data that exists at runtime must exist as an entry in the
> K/V store or as a column on a relational table. There is no third option.
> If you're building a special mechanism, a cache, a side channel, or a
> separate assembly path, you're building outside the paradigm. Stop and ask.

## Current State

Entry-driven dispatch architecture. Every interaction follows one contract:

```
path (scheme://target)  |  body (tag body)  |  attributes (tag attrs JSON)  |  state
```

Model emits XML tags → XmlParser produces commands → TurnExecutor records
each as an entry at `full` state → handler chain dispatches → handlers modify
state and create related entries → entry.created event fires.

Client sends RPC → same dispatch chain, minus mode enforcement.

Plugins hook any scheme at any priority. Core tools and third-party plugins
use the same `tools.register()` / `tools.onHandle()` interface.

### What's done

- Column rename: `value`→`body`, `meta`→`attributes`, `json_valid` constraint
- Recorder/dispatcher: TurnExecutor records then dispatches, no inline execution
- Core tools as plugin: all handlers in `src/plugins/tools/tools.js`
- Handler priority chain: `onHandle(scheme, handler, priority)`, `return false` stops chain
- `tool://` entries: plugin docs in store, rendered from turn_context
- `skill://` entries: per-run, loaded from `config_path/skills/*.md`
- Personas: per-run column, loaded from `config_path/personas/*.md` or raw text
- Sessions killed: runs belong to projects directly
- Models table: DB-backed, env bootstrap, runtime CRUD via RPC
- RPC rebuilt: `read`/`store`/`write`/`delete` dispatch through handler chain
- Unified verbs: model, plugin (`rummy.get/store/set/rm`), and client use same pipe
- `progress://` as entry: continuation prompt modifiable by plugins before materialization
- Materialization in TurnExecutor: core plumbing, not a plugin
- Engine plugin emptied: no premature budget enforcement
- Dead hooks killed: `action.search`, `action.fetch`, `prompt.tools`
- `entries` getter: `rummy.entries` = KnownStore, `rummy.store()` = tool verb

### Test status

- 154 unit, 100 integration: all pass
- 22/23 live: 1 model timeout
- 9/11 E2E: 2 model behavior (not code bugs)

---

## Todo: Fidelity Projection Hooks

The `v_model_context` VIEW hardcodes `json_extract(attributes, '$.symbols')`
for summary projection. The system is trespassing on plugin-private data.

Plugins need to define how their entries render at each fidelity level:

```js
hooks.tools.onProject("myscheme", {
    full: (entry) => entry.body,
    summary: (entry) => entry.attributes?.excerpt || entry.body.slice(0, 200),
});
```

Recommendation: materialization-time projection in JS. The engine calls
projection functions before INSERT into turn_context.

**Blocks** full use of `attributes` for plugin-private data.

---

## Todo: Janitor Plugin

Deterministic context management. Simple rules, predictable behavior.
Runs before materialization via `hooks.onTurn()`. Demotes entries by
tier ordering to fit context budget. Ships with rummy as the default
context manager.

Separate from the relevance engine (stochastic, model-assisted, separate project).

---

## Todo: Repomap / Symbols Extraction (do not touch prematurely)

Orphaned repomap code exists throughout core (`CtagsExtractor.js`,
`FileScanner.js` symbol hooks, `ContextAssembler.js` file_summary,
`known_store.sql` symbols json_extract, `Hooks.js` file.symbols filter,
`plugins/symbols/`). Leave it frozen until we extract the repomap into
its own plugin/repo. Premature cleanup risks losing context about what
it does and why. The extraction is the cleanup.

---

## Done: Tool Rename — Lean Into Training Data

Core tools renamed to align with unix/programming primitives the model
has deep training on. The tag name is in the model's output token
stream — training synergy matters here because we use XML tags, not
native tool calling.

| Tool | Scheme | Why |
|------|--------|-----|
| `get` | `get://` | Universal primitive. `get src/app.js` = load into context |
| `set` | `set://` | Universal primitive. `set src/app.js` = modify this entry |
| `known` | `known://` | Explicit knowledge save. `<known>OAuth2 PKCE</known>` |
| `rm` | `rm://` | Unix. Unambiguous |
| `mv` | `mv://` | Unix |
| `cp` | `cp://` | Unix |
| `sh` | `sh://` | Unix. Models know `sh` = shell execution |
| `store` | `store://` | No better analog |
| `env` | `env://` | Already unix |
| `search` | `search://` | No better analog |
| `ask_user` | `ask_user://` | No better analog |
| `summarize` | `summarize://` | No better analog |
| `update` | `update://` | No better analog |
| `unknown` | `unknown://` | No better analog |

### Tool result header format

Every tool result projection uses `#` comment headers. No state in the
header — state comes from the assembler. Token counts on a second `#` line
where the model benefits from knowing the budget impact.

**Single operations:**

```
# set src/app.js
# 120→125 tokens
<<<<<<< SEARCH
const port = 3000;
=======
const port = 8080;
>>>>>>> REPLACE
```

```
# get src/app.js
src/app.js 120 tokens
```

```
# rm src/old.js
# 125→0 tokens
```

```
# mv known://draft known://final
# 125 tokens moved
```

```
# sh npm test
12 passing, 0 failing
```

```
# env node --version
v22.1.0
```

```
# search "Tom Petty death"
10 results for "Tom Petty death"
https://...
```

**Bulk operations — one entry, summary header + itemized listing:**

```
# mv old/*.js new/
# 3,215 tokens moved

# mv old/file1.js new/file1.js
# mv old/file2.js new/file2.js
```

Bulk operations create ONE entry. `attributes.items` is an array with
per-item metadata (including individual state for mixed-fate resolutions).
The body IS the materialized view — summary header first, then per-item
lines. The projection returns body directly.

Future: summary projection mode that omits the itemized listing for
large bulk operations.

### Bulk operation handler refactor

Currently pattern operations create N individual entries. This must change:

- `storePatternResult` creates one entry with `attributes.items: [...]`
- Each item: `{ path, state, tokens, ... }` (scheme-specific metadata)
- Body: summary header + itemized `# verb from to` lines
- Client resolves the single entry (bulk accept/reject)
- The model sees one grouped result, not N individual results

Affects: set (bulk update), get (pattern promote), store (pattern
demote), rm (pattern remove), mv/cp (pattern operations).

### Set entry contract

- `body` = original content (reconstructable with attributes.patch)
- `attributes.patch` = udiff for client (unix patch format)
- `attributes.merge` = git conflict for model view (SEARCH/REPLACE)
- `attributes.beforeTokens` / `attributes.afterTokens` = token delta
- Projection = `# set file` + token line + merge block
- Input: accept all formats (hedbergian). Output: always udiff to client, always git conflict to model.
- Literal search only. No inline regex. Hedberg for pattern matching.

### Resolution states

| Action | State | Run continues? |
|--------|-------|---------------|
| `accept` | `pass` | Yes |
| `error` | `error` | Yes (model gets error output) |
| `reject` | `rejected` | No |

---

## Todo: Cleanup

- [ ] Rename `continuation` to `progress` throughout ContextAssembler
- [ ] Remove "bucket" terminology from code comments

---

## Todo: Deferred

- Relevance engine (stochastic, separate project/plugin)
- Out-of-process plugins (rummy.web separation)
- Non-git file scanner fallback
