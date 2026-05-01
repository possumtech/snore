# RUMMY: The Virtual Memory Yoke for LLM Agency

Rummy is a metacognitive relational architecture that treats the LLM as a **program** executing on a **virtual memory substrate**. 

Traditional agents "thrash" and fail because they rely on linear chat history—a format that is expensive, noisy, and prone to context overflow. Rummy replaces the chat log with a tiered, SQLite-backed memory hierarchy managed by a deterministic state machine kernel.

## The Architecture: Virtual Memory for Tokens

In Rummy, the model does not "remember" the conversation; it manages a project state. Rummy provides the memory hierarchy necessary to maintain high-fidelity reasoning over unlimited-turn sessions:

*   **L1 Cache (`visible`):** High-fidelity, character-perfect context. This is the active "Working Set" the model is reasoning with right now.
*   **RAM (`summarized`):** Folksonomic metadata and searchable indices. This allows the model to know *what* information exists and how to address it without consuming the L1 token budget.
*   **The Disk (`archived`):** Persistent SQLite storage. A relational substrate where every historical finding, raw source document, and prior tool result is safely indexed and searchable, ready to be "paged" back into Cache on demand.

## Key Features

### The FCRM Kernel
The **Folksonomic Context Relevance Maximization (FCRM)** state machine is the Rummy Kernel. It enforces a rigorous lifecycle for information, moving the agent through four distinct stages: **Decomposition, Distillation, Demotion, and Deployment**. This ensures that irrelevant data is "swapped" out to the Disk (Demotion) before final execution (Deployment).

### Apophatic Reasoning (The Rumsfeld Loop)
Rummy is built on the strategy of **entropy reduction**. Instead of guessing, the agent is forced to map the project's "Shadow World" of **Unknowns** (`unknown://`) and systematically process them into verified **Knowns** (`known://`). The agent only acts when the unknowns are zeroed out.

### Hedberg: The Interpretation Boundary
The boundary between stochastic model output and deterministic system operations. **Hedberg** normalizes messy model syntax—sed regex, SEARCH/REPLACE blocks, and escaped characters—into character-perfect patches and system actions.

### Relational Substrate
Built on **SqlRite**, a high-performance, async WAL-mode SQLite engine. Rummy treats the model's entire history as a queryable database, enabling **State-as-Memory** that survives indefinitely across sessions.

## Installation

Rummy loads configuration from exactly **one** directory per invocation:

1. The current working directory (if it contains `.env.example`).
2. Otherwise, `${RUMMY_HOME}` (default `~/.rummy`).

```bash
# Set your RUMMY_HOME
export RUMMY_HOME=~/.rummy

# Install globally
npm i -g @possumtech/rummy

# Configure your environment
$EDITOR ~/.rummy/.env.example   # set model aliases and keys
rummy
```

## Usage

Rummy is a headless service. It exposes a JSON-RPC over WebSocket interface (default port `3044`) for clients to drive the engine. 

*   **Official Client:** [rummy.nvim](https://github.com/possumtech/rummy.nvim) (Neovim interface)
*   **Automation:** [TBENCH](TBENCH_AUDIT.md) (Autonomous benchmarking harness)

## Documentation

| Document | Contents |
|----------|----------|
| [SPEC.md](SPEC.md) | Technical Specification: K/V store, FCRM stages, and packet structure. |
| [PLUGINS.md](PLUGINS.md) | Extensibility: Hook registry, event filtering, and custom scheme registration. |
| [src/plugins/](src/plugins/) | **Plugin Reference:** Each internal plugin (e.g., `set`, `get`, `sh`) contains its own detailed `README.md` documenting its specific tools and behaviors. |
| [AGENTS.md](AGENTS.md) | Project roadmap, planning history, and "Lessons" derived from development. |
