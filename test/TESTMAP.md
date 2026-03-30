# Test Map: ARCHITECTURE.md → Tests

Every testable promise in ARCHITECTURE.md mapped to a test.
`[x]` = tested. `[ ]` = not yet tested.

## §1 The Known Store

### §1.1 Schema
- [x] known_entries table exists with all columns (integration: known_store)
- [x] UNIQUE constraint on (run_id, key) (integration: known_store)
- [x] CHECK constraint rejects invalid domain/state combos (integration: known_store)
- [x] tokens computed by SQL on UPSERT (integration: known_store)
- [x] write_count increments on UPSERT (integration: known_store)

### §1.2 Domains & States
- [x] file domain: full, readonly, active, ignore, symbols (integration: known_store)
- [x] known domain: full, stored (integration: known_store)
- [x] result domain: proposed, pass, info, warn, error, summary (integration: known_store)
- [x] /:unknown/* entries are known domain (integration: known_store)
- [x] file:ignore hidden from model (integration: known_store)
- [x] proposed hidden from model (integration: known_store)

### §1.3 Key Namespaces
- [x] bare paths → file domain (integration: known_store)
- [x] /:known/ prefix → known domain (integration: known_store)
- [x] /:[tool]/ prefix → result domain (integration: known_store)
- [x] sequential result key generation (integration: known_store)

### §1.4 UPSERT Semantics
- [x] UPSERT overwrites value on conflict (integration: known_store)
- [x] blank value is legitimate, not a delete (integration: known_store)
- [ ] delete tool removes entry (E2E: act mode with delete)

### §1.5 State Lock
- [ ] TurnExecutor blocks when proposed entries exist (integration)

### §1.6 Resolution
- [x] accept changes proposed → pass (integration: known_store)
- [x] reject changes proposed → warn (integration: known_store)
- [x] auto-resume after all accepted (E2E: act_lifecycle) (E2E: edit resolution)
- [x] stop after rejection (E2E: act_lifecycle) (E2E: edit rejection)

## §2 Native Tool Calling

### §2.1 Tools
- [x] ask mode has 7 tools (unit: ToolSchema)
- [x] act mode has 10 tools (unit: ToolSchema)
- [x] all tools have strict: true (unit: ToolSchema)
- [x] high-frequency tools have flat string params (unit: ToolSchema)
- [x] AJV validates tool arguments (unit: ToolSchema)
- [x] API stripping removes unsupported keywords (unit: ToolSchema)
- [x] mode validation rejects act-only tools in ask mode (unit: ToolSchema)

### §2.2 How Tools Become Known Entries
- [x] write creates /:known/* entry (E2E: foundation)
- [x] summary creates /:summary/N entry (E2E: foundation)
- [x] unknown creates sticky /:unknown/N entry (E2E: rumsfeld_loop)
- [x] read promotes by setting turn (integration: known_store)
- [x] drop demotes by setting turn to 0 (integration: known_store)
- [x] env creates /:env/N as proposed (E2E: act mode)
- [x] edit creates /:edit/N with patch in meta (E2E: act mode)
- [x] run creates /:run/N as proposed (E2E: act mode)
- [ ] delete creates /:delete/N as proposed (E2E: act mode)
- [ ] ask_user creates /:ask_user/N as proposed (E2E: act mode)

### §2.3 Promotion Model
- [x] read(key) sets turn to current (integration: known_store)
- [x] drop(key) sets turn to 0 (integration: known_store)

### §2.4 Enforcement Layers
- [x] strict: true on tool schemas (unit: ToolSchema)
- [x] tool_choice: "required" sent to provider (code review)
- [x] summary required — retry on missing (E2E: foundation)
- [x] unknowns gate — warn + retry when idle with unknowns (E2E: rumsfeld_loop)
- [x] free-form content captured as reasoning (code review)
- [ ] AJV warn-and-heal on invalid args (E2E: summary truncation)

### §2.5 Server Execution Order
- [x] prompt stored as /:prompt/N (E2E: foundation)
- [x] action tools execute before writes/unknowns/summary (code review)
- [x] unknowns deduplicated on insert (code review)
- [ ] edit computes unified diff patch (E2E: act mode with edit)

## §3 Model Context

### §3.1 System Message Contents
- [x] role description from system.ask.md/system.act.md (code review)
- [x] tool schemas injected (code review)
- [x] context array embedded (code review)

### §3.2 Context Ordering
- [x] active known → stored known → file paths → symbols → full files → results → unknowns → prompt (integration: known_store)

### §3.3 Expansion Rule
- [x] turn > 0 → expanded (integration: known_store)
- [x] turn == 0 → collapsed (integration: known_store)

### §3.4 File Bootstrap
- [x] files scanned from disk at turn start (E2E: foundation)
- [ ] client-promoted files bootstrapped with correct state
- [ ] symbol extraction stores in meta

### §3.5 File Change Detection
- [ ] hash comparison detects modified files
- [ ] new files added, deleted files removed
- [ ] modified files updated across all active runs

## §4 State Scopes

### §4.1 Project Scope
- [x] projects table exists (integration: known_store setup)

### §4.2 Run Scope
- [x] known_entries scoped to run_id (integration: known_store)
- [x] turns track usage per run (code review)
- [x] sequential turn numbers start at 1 (integration: known_store)

## §5 RPC Protocol

### §5.1 Methods
- [x] init creates project + session (E2E: foundation)
- [x] ask returns {run, status, turn} (E2E: foundation)
- [x] act returns {run, status, turn} (E2E: act_lifecycle) {run, status, turn} (E2E: act mode)
- [x] run/resolve with accept (E2E: act_lifecycle) transitions proposed → pass
- [x] run/resolve with reject (E2E: act_lifecycle) transitions proposed → warn
- [x] run/abort sets status to aborted (E2E: rpc_methods) status to aborted
- [x] run/inject creates (E2E: rpc_methods) /:inject/N entry
- [x] getRuns lists runs (E2E: rpc_methods) runs for session
- [x] getModels lists aliases (E2E: rpc_methods) aliases
- [ ] activate/readOnly/ignore/drop set file state

### §5.2 Notifications
- [x] run/state sent (E2E: run_state) after each turn with correct shape
- [x] run/state.proposed includes type (E2E: run_state) type field
- [x] run/state.telemetry includes model info (E2E: run_state) model info
- [x] run/progress sent during turn (code review)

### §5.3 Run Lifecycle
- [x] proposed entries block turn (code review)
- [x] auto-resume after accepted resolution (E2E: act_lifecycle)
- [x] stop after rejected resolution (E2E: act_lifecycle)

### §5.4 Run Modes
- [x] new run creates fresh known store (E2E: foundation)
- [ ] continue run preserves known store
- [ ] lite mode skips file bootstrap
- [ ] fork inherits parent known store

## §6 Provider Compatibility
- [x] OpenRouter sends tools + tool_choice (code review)
- [x] Ollama normalizes arguments from object to string (code review)
- [x] OpenAI-compatible sends tools + tool_choice (code review)

## §7 Plugin System
- [x] plugins loaded from src/plugins/ (E2E: foundation — server boots)
- [x] onTurn hooks fire each turn (code review)
- [ ] custom tool plugin registers and works
- [ ] custom RPC method plugin registers and works

## §8 Testing
- [x] unit tests in src/**/*.test.js (exists)
- [x] integration tests in test/integration/ (exists)
- [x] E2E tests in test/e2e/ (exists, 5 tests)
- [x] E2E tests use real LLM (kimi via OpenRouter)

## Summary

Tested:     ~60 promises (88 tests: 69 unit/integration + 19 E2E)
Untested:   ~10 promises
Remaining:
  - §3.4: client-promoted file bootstrap states, symbol extraction in meta
  - §3.5: hash-based change detection, cross-run bulk updates
  - §5.4: continue/lite/fork run modes
  - §7: custom plugin registration E2E
