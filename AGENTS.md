# AGENTS: Planning & Progress

## Current State

XML tool commands in response content, parsed by htmlparser2. Single `known_entries`
K/V store as the unified state machine. Markdown context rendering. tiktoken token
counting with `/4` fallback. 4 production dependencies. Lint fully clean (biome +
sqlfluff). TESTMAP.md at 0 untested promises. Response healing: always recover, never throw.

---

## Next

- [ ] Pattern tooling — glorp-powered bulk operations (`path`/`value`/`keys` on all store-facing tools)
- [ ] Continuation prompt makeover — "state of the run" report: what changed this turn, context budget used/remaining, open unknowns, pending actions. The model should know where it is, what it did, and what it costs.
- [ ] ResponseHealer — single class: model garbage in, structured response out. Consolidates summary healing (TurnExecutor), progress detection (AgentLoop), and repetition detection (AgentLoop). The core question is "did we make progress?" — not specific rules about unknowns. Failure modes: idle turns (nothing happened), repetitive turns (same thing happened), empty turns (no output). Unknowns are just context, not a special gate.

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

### Pre-Audit Sprint (2026-03-30)
- Bug fixes: setFileState preserves content, fileStatus queries real state, getModelInfo on ProjectAgent, summary healing
- Response healing: plain text → summary, missing summary → placeholder, empty → placeholder. Never throw on model output.
- AgentLoop catch returns `{ status: "failed" }` instead of re-throwing
- Tests: state_lock, file_scanner, context_distribution, plugin_registration, file visibility RPCs
- TESTMAP.md at 0 untested promises (134 tests: 37 unit + 56 integration + 42 E2E)
- XmlParser regex modernized (`[\s\S]` + `matchAll`), lint fully clean
- antlrmap 0.0.3 → 0.0.8

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
