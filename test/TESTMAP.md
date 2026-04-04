# Test Map: SPEC.md → Tests

Every testable promise in SPEC.md mapped to a test.
`[x]` = tested. `[ ]` = not yet tested.

## §1 The Known Store

### §1.1 Schema
- [x] known_entries table exists with all columns (integration: known_store)
- [x] UNIQUE constraint on (run_id, key) (integration: known_store)
- [x] CHECK constraint rejects invalid scheme/state combos (integration: known_store)
- [x] tokens computed by SQL on UPSERT (integration: known_store)
- [x] write_count increments on UPSERT (integration: known_store)

### §1.2 Domains & States
- [x] file (NULL scheme): full, readonly, active, ignore, symbols (integration: known_store)
- [x] known scheme: full, stored (integration: known_store)
- [x] result scheme: proposed, pass, info, warn, error, summary (integration: known_store)
- [x] unknown://* entries are known scheme (integration: known_store)
- [x] file:ignore hidden from model (integration: known_store)
- [x] proposed hidden from model (integration: known_store)

### §1.3 Key Namespaces
- [x] bare paths → file (NULL scheme) (integration: known_store)
- [x] known:// prefix → known scheme (integration: known_store)
- [x] [tool]:// prefix → tool scheme (integration: known_store)
- [x] sequential result key generation (integration: known_store)

### §1.4 UPSERT Semantics
- [x] UPSERT overwrites value on conflict (integration: known_store)
- [x] blank value is legitimate, not a delete (integration: known_store)
- [x] delete resolution erases target key on accept (integration: known_store)
- [x] delete rejection preserves target key (integration: known_store)

### §1.5 State Lock
- [x] TurnExecutor blocks when proposed entries exist (integration: state_lock)

### §1.6 Resolution
- [x] accept changes proposed → pass (integration: known_store)
- [x] reject changes proposed → warn (integration: known_store)
- [x] auto-resume after all accepted (E2E: act_lifecycle)
- [x] stop after rejection (E2E: act_lifecycle)

## §2 XML Tool Commands

### §2.1 Tool Commands
- [x] htmlparser2 parses well-formed XML commands (unit: XmlParser)
- [x] htmlparser2 recovers from unclosed tags (unit: XmlParser)
- [x] htmlparser2 recovers from missing self-closing slashes (unit: XmlParser)
- [x] unknown HTML tags ignored (unit: XmlParser)
- [x] edit with SEARCH/REPLACE merge blocks parsed (unit: XmlParser)
- [x] edit with multiple merge blocks parsed (unit: XmlParser)
- [x] edit for new file (replace only) parsed (unit: XmlParser)
- [x] unparsed text captured as reasoning (unit: XmlParser)

### §2.2 How Commands Become Known Entries
- [x] known creates known://* entry (E2E: foundation)
- [x] summary creates summary://N entry (E2E: foundation)
- [x] unknown creates sticky unknown://N entry (E2E: rumsfeld_loop)
- [x] read promotes by setting turn (integration: known_store)
- [x] drop demotes by setting turn to 0 (integration: known_store)
- [x] env creates env://N as proposed (E2E: scenarios S6)
- [x] edit creates edit://N with patch in meta (E2E: scenarios S2)
- [x] run creates run://N as proposed (E2E: scenarios S7)
- [x] ask_user creates ask_user://N as proposed (E2E: scenarios S8)
- [x] delete creates delete://N as proposed (integration: known_store)

### §2.3 Promotion Model
- [x] read(key) sets turn to current (integration: known_store)
- [x] drop(key) sets turn to 0 (integration: known_store)

### §2.4 Enforcement Layers
- [x] prompt instructions define tool commands (prompt.act.md, prompt.ask.md)
- [x] htmlparser2 forgiving parsing (unit: XmlParser)
- [x] summary required — placeholder injected if missing (code review)
- [x] unknowns gate — warn + retry when idle with unknowns (E2E: rumsfeld_loop)
- [x] free-form content captured as reasoning://N (code review)

### §2.5 Server Execution Order
- [x] audit entries stored before LLM call (code review)
- [x] action commands execute before writes/unknowns/summary (code review)
- [x] unknowns deduplicated on insert (code review)
- [x] edit computes unified diff patch via HeuristicMatcher (E2E: scenarios S2, S5)

## §3 Model Context

### §3.1 System Message Contents
- [x] role description from prompt.ask.md/prompt.act.md (code review)
- [x] context rendered as markdown by ContextAssembler (unit: ContextAssembler)

### §3.2 Context Ordering
- [x] files rendered as code fences with language and tokens (unit: ContextAssembler)
- [x] active known rendered as bullet list (unit: ContextAssembler)
- [x] stored known rendered as comma list (unit: ContextAssembler)
- [x] file paths rendered as comma list (unit: ContextAssembler)
- [x] unknowns rendered as bullet list (unit: ContextAssembler)
- [x] results rendered with check marks (unit: ContextAssembler)
- [x] prompt rendered last (unit: ContextAssembler)
- [x] bucket ordering: active known → stored known → file paths → symbols → full files → results → unknowns → prompt (integration: known_store)
- [x] context_distribution buckets: files, keys, known, history, system (integration: context_distribution)
- [x] proposed entries excluded from context_distribution history bucket (integration: context_distribution)
- [x] unknowns counted in context_distribution history bucket (integration: context_distribution)

### §3.3 Expansion Rule
- [x] turn > 0 → expanded (integration: known_store)
- [x] turn == 0 → collapsed (integration: known_store)

### §3.4 File Bootstrap
- [x] files scanned from disk at turn start (E2E: foundation)
- [x] client-promoted files bootstrapped with correct state (E2E: rpc_methods — activate/readOnly/ignore/drop/fileStatus)

### §3.5 File Change Detection
- [x] mtime-first scan skips unchanged files (integration: file_scanner)
- [x] hash comparison detects content changes (integration: file_scanner)
- [x] new files added, deleted files removed (integration: file_scanner)
- [x] symbol extraction stores in meta (integration: file_scanner)

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
- [x] act returns {run, status, turn} (E2E: act_lifecycle)
- [x] run/resolve with accept (E2E: act_lifecycle)
- [x] run/resolve with reject (E2E: act_lifecycle)
- [x] run/abort sets status to aborted (E2E: rpc_methods)
- [x] run/inject creates inject://N entry (E2E: rpc_methods)
- [x] getRuns lists runs for session (E2E: rpc_methods)
- [x] getModels lists aliases (E2E: rpc_methods)
- [x] discover returns methods and notifications (E2E: rpc_methods)
- [x] setTemperature/getTemperature round-trip (E2E: rpc_methods)
- [x] skill/add, skill/remove, getSkills (E2E: rpc_methods)
- [x] activate/readOnly/ignore/drop set file state (E2E: rpc_methods)
- [x] fileStatus returns current state (E2E: rpc_methods)
- [x] getModelInfo returns model metadata (E2E: rpc_methods)
- [x] activate preserves file content in known store (E2E: rpc_methods)

### §5.2 Notifications
- [x] run/state sent after each turn with correct shape (E2E: run_state)
- [x] run/state.history entries have correct shape (E2E: run_state)
- [x] run/state.proposed includes type (E2E: run_state)
- [x] run/state.telemetry includes model info (E2E: run_state)
- [x] run/progress sent during turn (code review)

### §5.3 Run Lifecycle
- [x] proposed entries block turn (code review)
- [x] auto-resume after accepted resolution (E2E: act_lifecycle)
- [x] stop after rejected resolution (E2E: act_lifecycle)

### §5.4 Run Modes
- [x] new run creates fresh known store (E2E: foundation)
- [x] continue run preserves known store (E2E: run_modes)
- [x] lite mode skips file bootstrap (E2E: run_modes)
- [x] fork inherits parent known store (E2E: persona_fork)

## §6 Provider Compatibility
- [x] XML in content works with any provider (E2E: all tests use OpenRouter)
- [x] reasoning_content normalized across providers (code review)

## §7 Plugin System
- [x] plugins loaded from src/plugins/ (E2E: foundation — server boots)
- [x] onTurn hooks fire each turn (code review)
- [x] custom RPC method plugin registers and works (E2E: plugin_registration)
- [x] custom RPC method appears in discover (E2E: plugin_registration)
- [x] custom RPC method with requiresInit receives context (E2E: plugin_registration)

## §8 Testing
- [x] unit tests in src/**/*.test.js (XmlParser, ContextAssembler, HeuristicMatcher)
- [x] integration tests in test/integration/ (known_store, context_distribution, state_lock, file_scanner)
- [x] E2E tests in test/e2e/ (9 files, 43 tests)
- [x] E2E tests use real LLM, never mocked

## Summary

Tested:     ~95 promises (134 tests: 37 unit + 56 integration + 42 E2E)
Untested:   0
