# rpc

Registers all core RPC methods and dispatches client operations through the tool handler chain.

## Registration

- **No tool handler** — this plugin registers RPC methods on `hooks.rpc.registry`, not tool handlers.

## RPC Methods

### Protocol
- `ping` — liveness check.
- `discover` — returns method/notification catalog.
- `init` — initialize project (sets projectId, projectRoot, configPath).

### Models
- `getModels`, `addModel`, `removeModel` — CRUD for model aliases.

### Entry Operations
- `read` — promote entry to full state, or create persistent file constraint.
- `store` — demote entry to stored state, or manage file constraints (ignore/clear).
- `write` — create/update entry. K/V paths write directly; file paths dispatch through `set` handler.
- `delete` — remove entry via `rm` handler dispatch.
- `getEntries` — query entries by glob pattern.

### Runs
- `startRun` — pre-create a run with model/config.
- `ask` — non-mutating model query.
- `act` — mutating model directive.
- `run/resolve` — resolve a proposed entry (accept/reject).
- `run/abort` — abort an in-flight run.
- `run/rename` — rename a run alias.
- `run/inject` — inject a message into an idle or active run.
- `run/config` — update run parameters (temperature, persona, context_limit, model).
- `getRuns`, `getRun` — query run list and full run detail.

### Notifications
- `run/state` — turn state update with history, unknowns, proposed, telemetry.
- `run/progress` — turn status (thinking/processing).
- `ui/render` — streaming output.
- `ui/notify` — toast notification.

## Behavior

Client operations (read, write, delete, store) build a `RummyContext` for the target run and dispatch through the same handler chain as model operations via `dispatchTool`.
