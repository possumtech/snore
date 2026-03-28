# PLAN

## Remaining

### Bugs
- [ ] **Act file creation hangs** — "Create HELLO.md" test hangs after first model call. Model returns JSON without edits, server enters turn loop and never exits. Debug from DB records of the stuck run.
- [ ] **Foundation test 5 flaky** — "read and retain" test intermittently fails. Redundant read detection (`newReads`) may not be wired correctly through all paths.

### Cleanup
- [ ] Update ARCHITECTURE.md for structured output protocol (JSON schema, no XML)
- [ ] Update PLUGINS.md for JSON response format
- [ ] Remove xmldom dependency if Turn building can use plain objects
- [ ] Remove dead `protocol_constraints` references from any remaining code
- [ ] Delete `ToolRegistry.allForMode()` and related code (schema enums replaced it)

## Done

### Pluginification Refactor (2026-03-27)
- [x] **ToolRegistry** — `hooks.tools.register()` replaces hardcoded ACT_TOOLS. ToolExtractor queries the registry.
- [x] **RpcRegistry** — `hooks.rpc.registry.register()` replaces 300-line switch. `discover` auto-generates.
- [x] **AgentLoop decomposition** — TurnExecutor, FindingsProcessor, StateEvaluator extracted. AgentLoop is orchestrator only.
- [x] **CoreToolsPlugin** — 9 core tools registered via `hooks.tools.register()`.
- [x] **CoreRpcPlugin** — 20 RPC methods registered via `hooks.rpc.registry.register()`.
- [x] **Hookable state table** — `hooks.agent.warn` and `hooks.agent.action` filters let plugins modify rules.
- [x] **PLUGINS.md** — Plugin author contract documented.

### Earlier Work (2026-03-27)
- [x] Cross-reference population, heat wiring, fidelity decay fix
- [x] Structured feedback delivery, concrete nag templates, stray output detection
- [x] Empty SEARCH append fix, rejection flow (no auto-resume)
- [x] Doc/impl alignment, retention policies, client promo ranking integration
- [x] E2E test hardening (prefill workflow, notification isolation, discover contract)

## Next

The system is at feature freeze. The plugin contract (`PLUGINS.md`) is documented.
Next stage: third-party plugin development and real-world testing.
