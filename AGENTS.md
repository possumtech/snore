# AGENTS: Planning & Progress

## Active: Tool Calling Migration

Replacing `response_format` JSON schema with native tool calling. The known K/V
store, summary log, and unknown list ARE the model's context. No message history.
File management system fully cannibalized into the K/V store.

### Completed

- [x] Migration schema — `known_entries` with `domain`/`state`/`meta`/`relevance`/`turn`, `turns` for usage stats, no `turn_elements`/`findings_*`/`pending_context`/`file_promotions`/`client_promotions`/`repo_map_references`
- [x] SQL queries — upsert, get, delete, resolve, run log, next result key, next turn, create turn, update turn stats
- [x] Tool definitions — one JSON file per tool in `src/domain/schema/tools/`, composed by `ToolSchema.js`
- [x] `ToolSchema.js` — loads tools, strips unsupported strict-mode keywords for API, AJV validation, mode/required validation
- [x] `ToolSchema.test.js` — 36 tests covering definitions, API stripping, argument validation, required/mode checks
- [x] `KnownStore.js` — unified state manager (upsert, resolve, model projection, log, namespace routing, turn/result key generation)
- [x] `ContextAssembler.js` — system prompt + user message (known/unknown/log embedded in system)
- [x] `OpenRouterClient.js` — tools + tool_choice + empty-object shim, Ollama argument normalization
- [x] `ToolExtractor.js` — reads tool_calls array, separates action/structural calls, static validation
- [x] `TurnExecutor.js` — new execution flow (context assembly → LLM → tool extraction → known store). Needs update for `turn`/`meta` changes.
- [x] `AgentLoop.js` — resolve/inject operate on known store, no findings tables. Needs update for `turn`/`meta` changes.
- [x] AJV installed — server-side schema validation for constraints strict mode can't enforce
- [x] Legacy tests archived to `test_old/`
- [x] Doc alignment — ARCHITECTURE.md rewritten, consolidated to 3 docs, aligned with migration

### Remaining

**Schema & Validation (current focus):**
- [ ] Integration tests — KnownStore against real SQLite (UPSERT, resolve, model projection, log)
- [ ] Integration tests — ToolSchema validation against real model response shapes
- [ ] Update TurnExecutor/AgentLoop for `turn`/`meta` changes (replace `turnId`/`target`/`toolCallId`)

**Wiring:**
- [ ] Wire `KnownStore` into dependency injection
- [ ] File bootstrap — populate known_entries from repo map at run start
- [ ] `StateEvaluator.js` — simplify (query known store for proposed entries)

**Prompts & Plugins:**
- [ ] System prompts — `system.ask.md`, `system.act.md` rewrite
- [ ] Plugin updates — `mapping.js` (stop injecting docs), `context.js` (dead), `tools.js` (tool definitions)

**RPC & Client:**
- [ ] `run/resolve` uses `key` instead of `{category, id}`
- [ ] Notification payloads use `key` instead of `findingId`
- [ ] Client promotion RPCs (`activate`/`readOnly`/`ignore`) write to known store

**Cleanup:**
- [ ] Delete dead code (see list below)
- [ ] E2E test against real model

### Dead Code (to delete after migration)

- `src/domain/schema/ask.json`, `act.json`
- `src/application/agent/FindingsProcessor.js`
- `src/application/agent/FindingsManager.js`
- `src/application/agent/insert_finding_diff.sql`, `insert_finding_command.sql`, `insert_finding_notification.sql`
- `src/application/agent/update_finding_*_status.sql`
- `src/application/agent/get_findings_by_run_id.sql`, `get_unresolved_findings.sql`
- `src/application/agent/insert_pending_context.sql`, `get_pending_context.sql`, `consume_pending_context.sql`
- `src/application/agent/get_turn_history.sql`
- `src/application/plugins/context/context.js` (feedback injection — dead)
- `src/application/session/purge_consumed_context.sql`

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
