# PLAN

## Remaining

### Features
(none pending)

### Quality
- [x] ~~Unit tests achieve 80/80/80 coverage~~ — 90/81/89
- [ ] Apply a slug and numbering convention to readme and architecture documents, then use that lexicon for integration test file naming that defends every documented claim
- [ ] Maintain twelve e2e tests against live models covering distinct, realistic use cases
- [ ] Never run integration or e2e tests against mock models, only live models

### Docs
- [ ] Update ARCHITECTURE.md for structured output protocol (JSON schema, Markdown context, run aliases, model alias enforcement)
- [ ] Update PLUGINS.md for plain-object node API and Markdown rendering

### Client to Server

Things the client does that we wish to move server-side:

- [ ] Token/cost accumulation — The client sums usage.prompt_tokens and usage.cost across turns. The server could send cumulative totals in
each turn in addition to per-turn deltas. Would make the client even simpler.

- [ ] Temperature state — The client tracks temperature and sends it per request. If the server stored it per-session, the client would just
send tempUp/tempDown RPCs instead of managing the value.

- [ ] Skill active state — The client tracks which skills are on. The server already knows (it processes skill/add/skill/remove). We could
query it instead of caching.

- [ ] The normalize() function — If the server sent nil instead of JSON null in optional fields... but that's a JSON limitation, not the
server's fault. Consider adjusting how json is sent to be easier on clients? Or would that just be making a weird exception for lua quirks?


## Done

### Run Inject + Run Naming + Model Enforcement (2026-03-28)
- [x] **run/inject** — `{ run, message }`. If run is active, queues message as pending context for next turn. If idle, resumes the run with injected context. Uses existing `pending_context` pipeline via ContextPlugin.

### Run Naming + Model Enforcement (2026-03-28)
- [x] **Model alias enforcement** — `LlmProvider.resolve()` requires `RUMMY_MODEL_{alias}` env var. Raw model IDs rejected.
- [x] **Run aliases** — `alias TEXT NOT NULL UNIQUE` on runs table. Auto-generated as `{model}_{N}` (e.g. `ccp_1`). Clients use `run` field, never see UUIDs.
- [x] **RPC contract** — all params/responses renamed `runId` → `run`. Notifications emit `run` (alias).
- [x] **New RPCs** — `getRuns` (list all session runs), `run/rename` (validate `[a-z_]{1,20}`, enforce uniqueness).
- [x] **FileChangePlugin** — renamed from GitPlugin, VCS-agnostic (hash comparison only). Tag `modified_files`.

### XML Elimination (2026-03-28)
- [x] **@xmldom/xmldom removed** — zero XML in codebase. Dependency uninstalled.
- [x] **TurnBuilder** — plain objects `{ tag, attrs, content, children }` replace DOM.
- [x] **RummyContext** — `tag()` returns plain objects. Plugin API: `.children.push()`.
- [x] **Turn rendering** — Markdown renderer. Code fences with language detection, blockquote feedback, heading sections.
- [x] **All plugins updated** — RepoMapPlugin, FileChangePlugin, ContextPlugin, DebugLoggerPlugin (JSON audits).

### Dead Code Sweep + Bug Fixes (2026-03-28)
- [x] **Act file creation hang** — ToolExtractor routes `search: ""` to `tool: "create"`.
- [x] **Timeout wiring** — `RUMMY_FETCH_TIMEOUT` and `RUMMY_RPC_TIMEOUT` enforced.
- [x] **Dead code removed** — `allForMode()`, unused variables, unreachable protocol retry block.
- [x] **Create diffs** — proper unified diffs via `generateUnifiedDiff()`.

## Next

Next up: coverage push to 80/80/80, then doc updates.
