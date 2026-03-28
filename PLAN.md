# PLAN

## Remaining

### Bugs
- [ ] **Foundation test 5 flaky** — "read and retain" test intermittently fails. Likely model non-determinism; observe now that create hang is fixed.
- [ ] no more allowing direct model stuff, requiring an alias for all models, change paradigm
- [ ] replace runId with runAlias - We must generate a unique runalias for each run that's the modelalias plus the next number
- [ ] create endpoints allowing clients to rename runalias, enforcing uniqueness with error handling on uniqueness and [a-z_]{1,20} enforcement

- [ ] no more allowing direct model stuff, requiring an alias for all models, change paradigm
- [ ] replace runId with runAlias - We must generate a unique runalias for each run that's the modelalias plus the next number
- [ ] create endpoints allowing clients to rename runalias, enforcing uniqueness with error handling on uniqueness and [a-z_]{1,20} enforcement
- [ ] new run/inject endpoint with {runalias, message} params, which copies the previous turn's ask/act mode and sends a new prompt/turn to the run if the run isn't running, but sends an info with the message to the next turn if the run is ongoing. a "btw" option
- [ ] Unit tests achieve 80/80/80 coverage
- [ ] Apply a slug and numbering convention to our readme and architecture documents, then apply that lexicon to the file naming convention for a suite of integration tests that defend against regressions on every claim and promise made in our documentation.
- [ ] Maintain twelve e2e tests against live models that each cover a distinct, realistic use case
- [ ] Never run any integration or e2e test against mock models, only live models


### Architecture
- [ ] Update ARCHITECTURE.md for structured output protocol (JSON schema, Markdown context)
- [ ] Update PLUGINS.md for plain-object node API and Markdown rendering

## Done

### XML Elimination (2026-03-28)
- [x] **@xmldom/xmldom removed** — zero XML in codebase. Dependency uninstalled.
- [x] **TurnBuilder** — plain objects `{ tag, attrs, content, children }` replace DOM. `saveTurnToDb` traverses object tree.
- [x] **RummyContext** — `tag()` returns plain objects. Section getters find nodes in tree. Plugin API: `.children.push()` replaces `.appendChild()`.
- [x] **Turn rendering** — `toXml()` replaced with `#renderNode()` Markdown renderer. Documents render as `### \`path\`` + code fences with language detection. Feedback renders as blockquotes. Git changes as headings.
- [x] **All plugins updated** — RepoMapPlugin, GitPlugin, ContextPlugin, DebugLoggerPlugin (now outputs JSON audits).
- [x] **All tests updated** — 135 unit tests pass with zero XML.

### Dead Code Sweep + Bug Fixes (2026-03-28)
- [x] **Act file creation hang** — ToolExtractor routed `search: ""` edits to HeuristicMatcher (which rejects empty search), causing `hasAct` infinite loop. Fix: emit `tool: "create"` for `search === ""`, handled by existing FindingsManager create path.
- [x] **Timeout wiring** — `RUMMY_FETCH_TIMEOUT` (AbortSignal.timeout on all LLM fetches) and `RUMMY_RPC_TIMEOUT` (Promise.race on non-longRunning RPCs) now enforced.
- [x] **Dead code removed** — `ToolRegistry.allForMode()`, `_todoHasEdit`/`_hasEdits` stubs, `tags: []` pass-through, unreachable protocol violation retry block, `validationErrors` field, `protocol_constraints` doc references.
- [x] **Create diffs** — now generate proper unified diffs via `generateUnifiedDiff()`.
- [x] **Undeclared variables** — `protocolRetries`/`MAX_PROTOCOL_RETRIES` were referenced but never declared (latent ReferenceError in dead code, removed with the block).

## Next

The system is at feature freeze. The plugin contract (`PLUGINS.md`) is documented.
Next stage: eliminate XML from Turn building/serialization (Markdown + code fences), then third-party plugin development and real-world testing.
