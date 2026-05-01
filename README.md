# RUMMY: The General-Purpose Agent Kernel

Rummy is a headless, metacognitive relational architecture for LLM agents. It is designed to be integrated into real-world workflows—from IDEs and CLI tools to autonomous research pipelines—where project state is complex and accuracy is non-negotiable.

While traditional agents "thrash" and fail under the weight of linear chat history, Rummy treats the LLM as a **program** executing on a **managed memory substrate**. This "Virtual Memory" architecture ensures that Rummy remains reliable in sessions that span hundreds of turns and tens of thousands of files.

## The Architecture: Virtual Memory for Tokens

Rummy provides the memory hierarchy necessary to maintain high-fidelity reasoning over unlimited-turn sessions. This is not a benchmarking "harness," but a production-grade Operating System for AI agency:

*   **L1 Cache (`visible`):** High-fidelity, character-perfect context. This is the active "Working Set" the model is reasoning with right now.
*   **RAM (`summarized`):** Folksonomic metadata and searchable indices. This allows the model to know *what* information exists and how to address it without consuming the L1 token budget.
*   **The Disk (`archived`):** Persistent SQLite storage. A relational substrate where every historical finding, raw source document, and prior tool result is safely indexed and searchable, ready to be "paged" back into Cache on demand.

## Key Features

### Headless & RPC-First
Rummy is a **headless service**. It exposes a JSON-RPC over WebSocket interface, allowing it to be embedded into any client (e.g., [rummy.nvim](https://github.com/possumtech/rummy.nvim)). The server manages the project state and the "Kernel" loop, while the client drives the UI and handles local proposal resolution.

### Extensible Plugin Architecture
Rummy is built for integration. Every `<tag>` the model sees is a plugin. Every URI scheme (`known://`, `unknown://`, `sh://`) is registered by its owner. Developers can drop custom logic into `src/plugins/` to add new tools, filters, or event hooks. See [PLUGINS.md](PLUGINS.md) for details.

### The FCRM Kernel
The **Folksonomic Context Relevance Maximization (FCRM)** state machine is the Rummy Kernel. It enforces a rigorous lifecycle for information, moving the agent through four distinct stages: **Decomposition, Distillation, Demotion, and Deployment**. 

### Apophatic Reasoning (The Rumsfeld Loop)
Rummy turns "Not Knowing" into a formal state to be processed. By mapping **Unknowns** (`unknown://`) into verified **Knowns** (`known://`), Rummy provides a transparent, auditable trail of how the agent arrived at its conclusion.

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

Start the service and connect your preferred client. The server defaults to port `3044`.

*   **Official Client:** [rummy.nvim](https://github.com/possumtech/rummy.nvim) (Neovim interface)
*   **In-process CLI:** `rummy-cli` (one-shot ask/act invocations against a project; see `src/plugins/cli/`)
*   **Diagnostic Suite:** [TBENCH](TBENCH_AUDIT.md) (Autonomous diagnostic and benchmarking harness)

## Documentation

| Document | Contents |
|----------|----------|
| [SPEC.md](SPEC.md) | Technical Specification: K/V store, FCRM stages, and packet structure. |
| [PLUGINS.md](PLUGINS.md) | Extensibility: Hook registry, event filtering, and custom scheme registration. |
| [src/plugins/](src/plugins/**/README.md) | **Plugin Reference:** Internal documentation for each scheme and toolset. |
| [AGENTS.md](AGENTS.md) | Project roadmap, planning history, and architectural lessons. |

---
*Rummy: The Managed Operating System for AI Agency.*
