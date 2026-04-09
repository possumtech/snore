# AGENTS.md — Node Plugin Management

This document defines the delegation rules and development lifecycle for the
`node` plugin.

## 0. Development Mandates

- **Strict Isolation**: All plugin logic MUST reside in `src/plugins/node/`.
- **Zero Core Writes**: No modifications to the Rummy core (`src/agent/`,
  `src/hooks/`, etc.). All core requirements must be submitted as a proposal
  to the Project Agent.
- **Verification First**: Every feature must have a corresponding integration
  test in `test/integration/node_plugin.test.js` or a new file in `test/`.
- **Side-Effect-Free Server**: The server plugin ONLY records proposals (202)
  and projects data. The client-side executor (described in SPEC.md) handles
  all process execution.

## 1. Task Delegation

### Strategic Orchestrator (Architect)
- **Role**: Maps the `node://` namespace and sub-path projections.
- **Focus**: Ensuring the plugin adheres to the "Paradigmatically Rummy" way
  (using `<get>` for filtering, `<node>` for actions).

### Surgical Editor (Implementation)
- **Role**: Writes the `node.js` handler and projections.
- **Contract**: Execute the Multiplexer pattern exactly as specified in SPEC.md.

### Test Runner (Validation)
- **Role**: Verifies the 202-proposal lifecycle and 200-resolution data storage.
- **Focus**: Ensuring `node://trace/` and `node://profile/` entries are correctly
  filtered by the `get` handler using `hedberg`.

## ## 3. Master Project Checklist

- [ ] **Phase 1: Scaffolding**
  - [ ] Create `node.js` entry point and register `node` scheme.
  - [ ] Create `nodeDoc.js` with initial syntax examples.
  - [ ] Verify plugin loading in `service.js` via logs.

- [ ] **Phase 2: The Action Tool (`<node>`)**
  - [ ] Implement `handler` to record 202-status proposals.
  - [ ] Add attribute normalization (action, path, args).
  - [ ] Add integration test for the 202-proposal lifecycle.

- [ ] **Phase 3: The Investigation Handler (`get`)**
  - [ ] Register a handler for the `get` scheme.
  - [ ] Implement namespaced routing for `node://` paths.
  - [ ] Integrate `hedberg.search` for body-filtered retrieval.
  - [ ] Verify that `<get path="node://...">pattern</get>` works on `stored` entries.

- [ ] **Phase 4: Projections & Reporting**
  - [ ] Implement `test` projection (TAP/JSON formatting).
  - [ ] Implement `trace` projection (windowed/causal view).
  - [ ] Implement `profile`/`coverage` summary projections.
  - [ ] Add cross-linking metadata (e.g., `tracePath` in test results).

- [ ] **Phase 5: Finalization & Docs**
  - [ ] Finalize `nodeDoc.js` with comprehensive examples and constraints.
  - [ ] Comprehensive integration test suite covering all sub-actions.
  - [ ] Final review of isolation mandates.
