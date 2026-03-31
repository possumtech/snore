# AGENTS: Planning & Progress

## Current State

URI-based K/V store (`known://`, `edit://`, `summary://`, bare paths for files).
Pattern tools via glorp (glob/regex on `path`/`value`, `keys` flag for preview).
ResponseHealer (forward motion, no unknowns gate). CASE WHEN CHECK constraints
per scheme. Web search (SearXNG) and URL fetch (Playwright + Readability + Turndown).
Move/copy across file and K/V namespaces. Edit search/replace attribute mode.
75 unit + 74 integration + 50 E2E.

---

## Next

- [ ] Context budgeting — relevance engine plugin (see Future section below)

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
- **Knowledge graph** — scan `known://*` values for URI references. Build citation edges. High-connectivity nodes resist demotion.
- **Janitorial turns** — dedicated turns where the model consolidates its own key space.

