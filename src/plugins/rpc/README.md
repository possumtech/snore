# rpc

Registers core RPC methods and provides automatic tool dispatch for
all registered tools.

## Registration

- **No tool handler** — registers RPC methods on `hooks.rpc.registry`.
- **Tool fallback** — any registered tool is automatically callable via
  RPC without explicit registration. Third-party plugins get RPC for free.

## RPC Methods

### Protocol
- `ping`, `discover`, `init`

### Models
- `getModels`, `addModel`, `removeModel`

### Entry Operations (all dispatch through tool handler chain)
- `get` — promote entry; with `persist` flag, also sets file constraint.
- `store` — demote entry or manage file constraints (not a model tool).
- All other registered tools — auto-dispatched via tool fallback.
- `getEntries` — query entries by glob pattern.

### Runs
- `startRun`, `ask`, `act`
- `run/resolve`, `run/abort`, `run/rename`, `run/inject`, `run/config`
- `getRuns`, `getRun`

### Notifications
- `run/state`, `run/proposal`, `ui/render`, `ui/notify`, `stream/cancelled`
