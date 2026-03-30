# AGENTS: Planning & Progress

## Current State

XML tool commands in response content, parsed by htmlparser2. Single `known_entries`
K/V store as the unified state machine. Markdown context rendering. tiktoken token
counting with `/4` fallback. 4 production dependencies. 39/39 E2E on potato (Qwen3-14B).

### Completed
- [x] Migration schema — `known_entries` with domain/state/hash/meta/tokens/refs/turn
- [x] SQL consolidated — 6 files (known_store, known_queries, known_checks, runs, turns, sessions)
- [x] KnownStore — all queries are SQL, zero `getAll`, ordered context via 8 bucket queries
- [x] ContextAssembler — markdown rendering (code fences, bullet lists, file index)
- [x] TurnExecutor — file scan → context assembly → LLM → XML parsing → K/V store
- [x] AgentLoop — resolve/inject, unknowns gate, repetition detection, abort signal
- [x] XML tool commands — htmlparser2 parsing, forgiving recovery, reasoning capture
- [x] All 3 LLM clients — lazy-init, stripped to `{model, messages}` in, content out
- [x] Sticky unknowns — `/:unknown:N`, deduplicated, persist until dropped
- [x] Unknowns gate — directive prompt ("Use `<read/>` or `<drop/>` to resolve")
- [x] Repetition detection — 3 identical summaries = force-complete, drops stale unknowns
- [x] Patch generation — HeuristicMatcher computes unified diff for edits
- [x] `run/state` notification — one payload per turn with context_distribution telemetry
- [x] Resolution — `accept`/`reject` only, auto-resume/stop
- [x] Persona — PromptManager reads session persona, injects as `## Persona`
- [x] Fork mode — `fork_known_entries` SQL copies parent store
- [x] FileScanner — async stat, mtime-first, symbols in meta
- [x] ProjectContext — git results cached per HEAD hash
- [x] PromptManager — prompt files cached after first read
- [x] tiktoken — o200k_base encoding, `/4` on hot path, async recount after turn
- [x] Reasoning capture — provider normalization + free-form text between XML tags
- [x] Symbol extraction pluginized — `hooks.file.symbols` filter, antlrmap/ctags as default plugin
- [x] Symbol formatting — kind, line numbers, tree structure via stack algorithm
- [x] Plugin hooks wired — ask/act completed, llm.request, llm.response, run.step.completed
- [x] Dead hooks removed — agent.warn, agent.action, ui.prompt, editor.diff, run.command
- [x] KnownStore on RummyContext — `rummy.store` for plugin access
- [x] Context distribution telemetry — 5 buckets: system, files, keys, known, history
- [x] Context limit RPC — setContextLimit/getContext, session-level override
- [x] AbortController — run/abort signals in-flight loop to stop
- [x] Edit history shows search/replace — model sees what it changed
- [x] i18n sweep — 28 keys in lang/en.json, all client-facing errors through msg()
- [x] Loop constants configurable — RUMMY_MAX_TURNS, RUMMY_MAX_UNKNOWN_WARNINGS, RUMMY_MAX_REPETITIONS
- [x] Delete tool integration tests — accept erases target, reject preserves
- [x] test_old/ deleted — 428K, 52 files
- [x] Lint fully clean — biome + sqlfluff, zero `SELECT *`

### Pre-Audit Checklist

**Bugs to fix:**
- [x] activate/readOnly upserts empty value — `setFileState` SQL preserves existing value
- [x] fileStatus RPC — queries actual state from known_entries via `get_entry_state`
- [x] getModelInfo RPC — `ProjectAgent.getModelInfo()`, no inline imports
- [x] "missing required summary" retry — `err.code === "MISSING_SUMMARY"` replaces string matching

**Tests to write:**
- [ ] activate/readOnly/ignore/drop RPC E2E (use wizard.txt)
- [ ] fileStatus RPC E2E
- [ ] getModelInfo RPC E2E
- [ ] abort actually stops in-flight loop E2E
- [ ] context_distribution bucket correctness (integration)

**Docs to align:**
- [ ] ARCHITECTURE.md §5.1 — add getModelInfo, update run/abort description
- [ ] TESTMAP.md — update with all new tests and wizard.txt changes

### Dead Code (already deleted)
- FindingsProcessor, FindingsManager, StateEvaluator, ResponseHealer, ToolExtractor
- ToolSchema.js, ToolSchema.test.js, src/schema/ directory, ajv dependency
- Turn.js, TurnBuilder.js
- RepoMap.js, repo_map_files, repo_map_tags, repo_map_references
- ask.json, act.json, gbnf.js, system.ask.md, system.act.md
- context.js plugin, test_old/ (52 files)
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

## Future: Context Budgeting — Relevance Engine Plugin

The `tokens`, `refs`, `turn`, and `write_count` fields are ready. The Relevance Engine will be a plugin using `hooks.onTurn()` with access to `rummy.store` and `rummy.contextSize`.

- **Relevance engine** — compute `refs` from `meta.symbols` cross-references. Files referenced by promoted files get higher refs. The preheat cascade: root files → their referenced files → symbols.
- **Budget enforcement** — before context assembly, check total tokens against `rummy.contextSize`. Demote entries from turn > 0 to turn 0 based on: low refs, old turn, high tokens.
- **Three-tier fidelity** — full (turn > 0), symbols (state = 'symbols'), path-only (turn = 0).
- **Knowledge graph** — scan `/:known:*` values for `/:` references. Build citation edges. High-connectivity nodes resist demotion.
- **Janitorial turns** — dedicated turns where the model consolidates its own key space.

---

## Historical

### Stabilization Sprint (2026-03-30)
- Plugin system: symbol extraction, KnownStore on RummyContext, all hooks wired
- Potato hardening: repetition detection, directive unknowns, wizard.txt live scratchpad
- Context management: distribution telemetry, setContextLimit/getContext/getModelInfo
- AbortController for in-flight loop termination
- i18n: 28 keys, all client-facing errors through msg()
- 39/39 E2E on quantized Qwen3-14B

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
