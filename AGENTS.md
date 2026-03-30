# AGENTS: Planning & Progress

## Active: Tool Calling Migration — Final Phase

### Completed
- [x] Migration schema — `known_entries` with domain/state/hash/meta/tokens/refs/turn
- [x] SQL consolidated — 6 files (known_store, known_queries, known_checks, runs, turns, sessions)
- [x] Tool definitions — 10 tools in `src/schema/tools/`, composed by ToolSchema.js with AJV
- [x] KnownStore — all queries are SQL, zero `getAll`, ordered context via 8 bucket queries
- [x] ContextAssembler — one flat ordered context array in system prompt
- [x] TurnExecutor — file scan → context assembly → LLM → tool extraction → K/V store
- [x] AgentLoop — resolve/inject via known store, unknowns gate, validation retry
- [x] All 3 LLM clients — native tool calling via ToolSchema
- [x] Sticky unknowns — `/:unknown/{seq}`, deduplicated, persist until dropped
- [x] Unknowns gate — warn + retry when model idles with open unknowns
- [x] Patch generation — HeuristicMatcher computes unified diff for edits
- [x] `run/state` notification — one payload per turn (history, proposed with type, unknowns, telemetry)
- [x] Resolution — `accept`/`reject` only, auto-resume/stop
- [x] `write`/`unknown` flat tools — no nested objects
- [x] `ask_user` renamed from `prompt`
- [x] Content captured as reasoning, not suppressed
- [x] AJV warn-and-heal (summary truncation)
- [x] Project restructure — 7 directories, SQL consolidated
- [x] Lint fully clean — biome + sqlfluff, zero `SELECT *`
- [x] 88 tests (69 unit/integration + 19 E2E)
- [x] TESTMAP.md maps ~60 of ~70 architectural promises to tests
- [x] ARCHITECTURE.md fully aligned with implementation
- [x] Client integration in progress

### Remaining — checklist

**Data integrity:** ✅
- [x] FileScanner: full content in `value`, symbols only in `meta`
- [x] FileScanner: root files promoted to current turn on first scan
- [x] Delete resolution: erase file key on accept

**ResponseHealer:** ✅
- [x] `src/agent/ResponseHealer.js` — centralized, 9 unit tests
- [x] Summary truncation + empty placeholder
- [x] Empty key/text rejection (write, read, unknown)
- [x] Mode validation (act-only in ask)
- [x] AJV warnings (heal first, validate after)
- [x] ToolExtractor eliminated — ResponseHealer replaces it

**Persona:** ✅
- [x] PromptManager reads session persona from DB
- [x] Injected as `## Persona` after system prompt

**Fork mode:** ✅
- [x] `fork_known_entries` SQL copies parent store
- [x] AgentLoop wired

**E2E coverage:** ✅ (23 tests)
- [x] Persona: stored and applied to model context
- [x] Fork: preserves parent known store
- [x] Continue: preserves store across calls
- [x] Lite mode: skips file bootstrap
- [ ] `activate`/`readOnly`/`ignore`/`drop` RPC methods
- [ ] `ask_user` proposed flow
- [ ] `delete` tool with file erasure on accept

### Dead Code (already deleted)
- FindingsProcessor, FindingsManager, StateEvaluator, ResponseHealer, ToolExtractor
- ToolSchema.js, ToolSchema.test.js, src/schema/ directory, ajv dependency
- Turn.js, TurnBuilder.js
- RepoMap.js, repo_map_files, repo_map_tags, repo_map_references
- ask.json, act.json, gbnf.js, system.ask.md, system.act.md
- context.js plugin
- All findings SQL, pending_context SQL, file_promotions SQL, turn_elements SQL

---

## Response Healing Philosophy

Every malformed model response is a diagnostic opportunity, not a "model drift" excuse. When healing a response, ask in order:

1. **Can we recover?** Extract the data and continue. htmlparser2 handles unclosed tags, missing slashes, etc.
2. **Can we warn usefully?** Log structured warnings that help future healing rules.
3. **Did our structure cause this?** Check if context formatting, prompt wording, or tool definitions nudged the model toward the failure.
4. **Did we miss something in prompts?** Check examples, instructions, continuation prompts.
5. **Model drift is the LAST answer**, after all of the above have been ruled out.

---

## Remaining

- [ ] libtiktoken integration for industry-standard token counting (optional, with `length / 4` fallback)
- [ ] `activate`/`readOnly`/`ignore`/`drop` RPC methods
- [ ] `ask_user` proposed flow E2E
- [ ] `delete` tool with file erasure on accept E2E

---

## Future: Context Budgeting (final mission)

The `tokens`, `refs`, `turn`, and `write_count` fields are ready. When we get there:

- **Relevance engine** — compute `refs` from `meta.symbols` cross-references. Files referenced by promoted files get higher refs. The preheat cascade: root files → their referenced files → symbols.
- **Budget enforcement** — before context assembly, check total tokens. Demote entries from turn > 0 to turn 0 based on: low refs, old turn, high tokens.
- **Knowledge graph** — scan `/:known:*` values for `/:` references. Build citation edges. High-connectivity nodes resist demotion.
- **Janitorial turns** — dedicated turns where the model consolidates its own key space.

---

## Future: Beyond Budgeting

- **Smart context budgeting** — dynamic token allocation per bucket
- **Simulation harness** — replay recorded runs offline
- **Cross-run knowledge** — gated, careful, explicitly opted-in

---

## Historical

### Tool Calling Migration (2026-03-29)
- Replaced response_format with native tool calling
- Collapsed 12 tables to 5 + 1 K/V store
- Killed all legacy systems

### Provider Hardening (2026-03-29)
- OpenAI-compatible provider, reasoning normalization
- Provider model catalog with 24h cache

### Quality & Docs (2026-03-28)
- Doc-driven integration tests, 12 e2e tests
- ARCHITECTURE.md + PLUGINS.md alignment

### Run Naming + Model Enforcement (2026-03-28)
- Model alias enforcement, run aliases, RPC contract

### XML Elimination (2026-03-28)
- @xmldom/xmldom removed, plain objects, Markdown rendering
