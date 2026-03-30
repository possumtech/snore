# AGENTS: Planning & Progress

## Current State

XML tool commands in response content, parsed by htmlparser2. Single `known_entries`
K/V store as the unified state machine. Markdown context rendering. tiktoken token
counting with `/4` fallback. 4 production dependencies.

### Completed
- [x] Migration schema — `known_entries` with domain/state/hash/meta/tokens/refs/turn
- [x] SQL consolidated — 6 files (known_store, known_queries, known_checks, runs, turns, sessions)
- [x] KnownStore — all queries are SQL, zero `getAll`, ordered context via 8 bucket queries
- [x] ContextAssembler — markdown rendering (code fences, bullet lists, file index)
- [x] TurnExecutor — file scan → context assembly → LLM → XML parsing → K/V store
- [x] AgentLoop — resolve/inject via known store, unknowns gate, validation retry
- [x] XML tool commands — htmlparser2 parsing, forgiving recovery, reasoning capture
- [x] All 3 LLM clients — stripped to `{model, messages}` in, content out
- [x] Sticky unknowns — `/:unknown:N`, deduplicated, persist until dropped
- [x] Unknowns gate — warn + retry when model idles with open unknowns
- [x] Patch generation — HeuristicMatcher computes unified diff for edits
- [x] `run/state` notification — one payload per turn (history, proposed with type, unknowns, telemetry)
- [x] Resolution — `accept`/`reject` only, auto-resume/stop
- [x] Persona — PromptManager reads session persona, injects as `## Persona`
- [x] Fork mode — `fork_known_entries` SQL copies parent store
- [x] FileScanner — async stat, mtime-first, symbols in meta
- [x] ProjectContext — git results cached per HEAD hash
- [x] PromptManager — prompt files cached after first read
- [x] tiktoken — o200k_base encoding, `/4` on hot path, async recount after turn
- [x] Content captured as `/:reasoning:N`, not suppressed
- [x] Project restructure — 7 directories, SQL consolidated
- [x] Lint fully clean — biome + sqlfluff, zero `SELECT *`
- [x] Doc alignment — ARCHITECTURE.md, README.md, AGENTS.md current with XML migration

### Remaining

- [ ] `activate`/`readOnly`/`ignore`/`drop` RPC methods E2E
- [ ] `ask_user` proposed flow E2E
- [ ] `delete` tool with file erasure on accept E2E
- [ ] Delete `test_old/` after next E2E round (428K legacy test archive from pre-K/V architecture)

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

## Future: Dependency Alternatives

**isomorphic-git** — Pure JS git implementation. Would eliminate all `execSync("git ...")` subprocess spawns in `GitProvider.js`. Currently `ProjectContext.open()` caches results keyed on HEAD hash, so the subprocess cost is amortized. Consider adopting if: (a) git operations expand beyond `ls-files`/`rev-parse`, or (b) we need to run in environments without git installed.

**JS ctags alternatives** — `CtagsExtractor.js` shells out to Universal Ctags. `@possumtech/antlrmap` already handles supported languages in-process. For unsupported languages, tree-sitter via `web-tree-sitter` or `node-tree-sitter` would provide in-process parsing without the ctags dependency. Consider adopting if: (a) ctags availability becomes a deployment issue, or (b) we need richer AST-level extraction beyond symbols.

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

### XML Tool Commands Migration (2026-03-30)
- Replaced native tool calling with XML commands in response content
- htmlparser2 for forgiving parsing, tiktoken for token counting
- Deleted ToolSchema, AJV, all JSON schema infrastructure
- Performance: async FileScanner, ProjectContext cache, PromptManager cache

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
