# SNORE: Sqlite/Node OpenRouter Engine

SNORE is a high-integrity, system-wide agent service that orchestrates LLM sessions for multiple clients (e.g., Neovim instances). It treats the project codebase as a **Relational Single Source of Truth**, storing state, history, and semantic maps in a shared SQLite database.

## Key Features

- **Lean Core:** A modular, plugin-first architecture using WordPress-style hooks, filters, and events.
- **Dynamic Context:** Automated repository mapping with a "Hot/Cold" lens to optimize token usage.
- **Relational Integrity:** Strictly enforced database constraints and flattened token metrics.
- **System-Wide:** One service manages multiple projects and sessions, defaulting to `~/.snore`.
- **Audit-First:** Prettified XML turn audits for every model exchange.

## Installation

```bash
git clone https://github.com/possumtech/snore
cd snore/main
npm install
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env
```

## Usage

### Start the Service
```bash
npm start   # Production mode
npm run dev # Watch mode with dev database
npm run debug # Debug mode on port 3047 with verbose telemetry
```

### Manual Testing
You can run the live "Paris" test to verify your installation:
```bash
node test/example_paris.js
```

## Plugin Architecture

SNORE is infinitely extensible. Create a JavaScript file in `src/internal/` or `~/.snore/plugins/`.

### Creating a Plugin
```javascript
export default class MyPlugin {
    static register(hooks) {
        // Handle a Lifecycle Event
        hooks.ask.completed.on(async ({ runId, turn }) => {
            console.log(`Run ${runId} finished.`);
        });

        // Participate in the XML Pipeline
        hooks.onTurn(async (snore) => {
            // Add instructions to the system prompt
            snore.system.appendChild(
                snore.doc.createTextNode("\nYou are an expert pair programmer.")
            );

            // Inject custom context using the .tag() helper
            const myTag = snore.tag("my_extension", { version: "1.0" }, [
                "Custom extension data"
            ]);
            snore.contextEl.appendChild(myTag);
        });
    }
}
```

### Hook & Event Map

| Type | Name | Purpose |
| :--- | :--- | :--- |
| **Pipeline** | `onTurn` | The primary DOM manipulation hook for the XML document. |
| **Event** | `project.init.started` | Runs before a project is initialized. |
| **Event** | `project.init.completed`| Runs after a project is opened. |
| **Event** | `ask.started` | Runs when an LLM turn begins. |
| **Event** | `ask.completed` | Runs after a model response is received. |
| **Filter** | `rpc.request` | Intercept and modify JSON-RPC calls. |
| **Filter** | `rpc.response.result` | Modify the final result of an RPC method. |

See `AGENTS.md` for the full architectural specification and XML pipeline details.
