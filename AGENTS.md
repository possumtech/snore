# AGENTS: Planning & Progress

## Active: Tool Calling Migration

Replacing `response_format` JSON schema with native tool calling. The known K/V
store, summary log, and unknown list ARE the model's context. No message history.
File management system fully cannibalized into the K/V store.

### Completed

- [x] Migration schema — `known_entries` with `domain`/`state`/`hash`/`meta`/`relevance`/`turn`, `turns` for usage stats. No `turn_elements`, `findings_*`, `pending_context`, `file_promotions`, `client_promotions`, `repo_map_files`, `repo_map_tags`, `repo_map_references`.
- [x] SQL queries — upsert, get, delete, resolve, run log, next result key, next turn, create turn, update turn stats
- [x] Tool definitions — one JSON file per tool in `src/domain/schema/tools/`, composed by `ToolSchema.js`
- [x] `ToolSchema.js` — loads tools, strips unsupported strict-mode keywords for API, AJV validation, mode/required validation
- [x] `ToolSchema.test.js` — 36 tests covering definitions, API stripping, argument validation, required/mode checks
- [x] `KnownStore.js` — unified state manager (upsert, resolve, model projection, log, namespace routing, turn/result key generation)
- [x] `ContextAssembler.js` — system prompt + user message (known/unknown/log embedded in system)
- [x] `OpenRouterClient.js` — tools + tool_choice + empty-object shim, Ollama argument normalization
- [x] `ToolExtractor.js` — reads tool_calls array, separates action/structural calls, static validation
- [x] `TurnExecutor.js` — new execution flow. Reads prompt via PromptManager, runs hooks via RummyContext, assembles context via ContextAssembler. No TurnBuilder/Turn dependency.
- [x] `AgentLoop.js` — resolve/inject operate on known store, no findings tables.
- [x] `SessionManager.js` — activate/readOnly/ignore/drop write to known_entries across all active runs. No client_promotions/file_promotions.
- [x] `ProjectAgent.js` — no FindingsProcessor/FindingsManager/StateEvaluator/TurnBuilder.
- [x] Killed repo_map — `repo_map_files`, `repo_map_tags`, `repo_map_references` all removed. Files live in known_entries with `hash` for change detection, symbols in `meta`.
- [x] Killed Turn.js, TurnBuilder.js — TurnExecutor uses PromptManager + RummyContext directly.
- [x] All three LLM clients (OpenRouter, Ollama, OpenAI) use ToolSchema for native tool calling.
- [x] AJV installed — server-side schema validation for constraints strict mode can't enforce
- [x] Legacy tests archived to `test_old/`
- [x] Doc alignment — ARCHITECTURE.md rewritten, consolidated to 3 docs, aligned with migration

### Remaining

**Completed since last update:**
- [x] Sticky unknowns — `/:unknown/{seq}` entries, deduplicated, persist until dropped
- [x] Unknowns gate — warn + retry (3x) when model idles with unresolved unknowns
- [x] Internal continuation prompt — "N unresolved unknowns" on follow-up turns
- [x] Content-as-reasoning — free-form content captured as `/:reasoning/{turn}`
- [x] `getAll` eliminated — every query is purpose-built SQL
- [x] Schema: `relevance` → `tokens` + `refs`. Tokens computed by SQL on UPSERT
- [x] `prompt` tool → `ask_user`. User prompt stored as `/:prompt/{turn}`
- [x] Context is one flat ordered array: active known → stored known → file paths → symbols → full files → results → unknowns → prompt
- [x] 5 E2E tests passing (foundation + Rumsfeld Loop)

**Remaining:**
- [ ] File scanner symbol extraction (ctags/antlrmap wiring, meta storage)
- [ ] Session prompt overrides (PromptManager doesn't check session DB yet)
- [ ] Project restructure
- [ ] ARCHITECTURE.md §7 plugin event payloads — some reference old field names
- [ ] More E2E: multi-turn with edit resolution, ask_user flow, continuation after rejection

### Dead Code (already deleted)

All of the following have been removed:
- `FindingsProcessor.js`, `FindingsManager.js`, `StateEvaluator.js`
- `Turn.js`, `TurnBuilder.js`
- `RepoMap.js`, `repo_map_files`, `repo_map_tags`, `repo_map_references`
- `ask.json`, `act.json` (old response_format schemas)
- `gbnf.js` (GBNF grammar generator)
- `context.js` plugin (feedback injection)
- All findings SQL, pending_context SQL, file_promotions SQL, editor_promotions SQL, turn_elements SQL
- `purge_consumed_context.sql`, `purge_orphaned_editor_promotions.sql`

---

## Future: Project Condi

With the K/V store proven, the door opens for:

- **Knowledge graph extraction** — the `/:` sentinel is a scannable anchor. When
  the model writes `/:known/auth_flow` inside another key's value, that's a
  citation edge. Scan values for `/:` references to build a dependency graph.
  Graph topology becomes the eviction policy.
- **Context budgeting** — dynamically demote entries from `full`/`file` to
  `symbols`/`stored` based on token budget. The model uses `read` to promote
  on demand.
- **Simulation harness** — replay recorded runs to test caching/eviction offline.
- **Janitorial turns** — dedicated turns where the model consolidates or prunes
  its own key space.
- **Cross-run knowledge** — gated and careful. Currently run-scoped by design.

---

## Historical

### Provider Hardening (2026-03-29)
- OpenAI-compatible provider, GBNF grammar, reasoning normalization
- getContextSize fails hard, run status `failed`, healing layer
- Provider model catalog with 24h cache

### Quality & Docs (2026-03-28)
- Coverage 90/79/87, doc-driven integration tests, 12 e2e tests
- ARCHITECTURE.md + PLUGINS.md alignment

### Run Naming + Model Enforcement (2026-03-28)
- Model alias enforcement, run aliases, RPC contract

### XML Elimination (2026-03-28)
- @xmldom/xmldom removed, plain objects, Markdown rendering
