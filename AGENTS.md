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
- Unified verbs: model, plugin (`rummy.read/store/write/delete`), and client use same pipe
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

## Todo: Rip Out Orphaned Symbols Infrastructure

Symbol extraction is orphaned repomap code. It should not be active in
core. The symbols plugin (`src/plugins/symbols/`) is destined for its own
repo. All symbol references outside that plugin must be removed:

- [ ] `known_store.sql` — `json_extract(attributes, '$.symbols')` in set_file_state
- [ ] `FileScanner.js` — symbol extraction hook call, `formatSymbols()`, attributes.symbols
- [ ] `ContextAssembler.js` — `file_summary` category, `symbolFiles` array
- [ ] `Hooks.js` — `file.symbols` filter hook
- [ ] `CtagsExtractor.js` — entire file (moves to symbols plugin or deleted)
- [ ] `v_model_context.sql` — `file_summary` category (dead without symbols)

The summary state for files exists in theory but nothing produces it
after symbol removal. Files are `full`, `index`, or `stored`.

---

## Todo: Cleanup

- [ ] Delete `PromptManager.js` (replaced by system tool)
- [ ] Audit all imports for dead references
- [ ] Rename `continuation` to `progress` throughout ContextAssembler
- [ ] Remove "bucket" terminology from code comments

---

## Todo: Deferred

- Relevance engine (stochastic, separate project/plugin)
- Out-of-process plugins (rummy.web separation)
- Non-git file scanner fallback
