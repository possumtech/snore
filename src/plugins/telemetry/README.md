# telemetry {#telemetry_plugin}

Console logging for RPC lifecycle and turn events.

## Files

- **telemetry.js** — Plugin registration. Hooks into `rpc.started`, `rpc.completed`, `rpc.error`, and `run.step.completed`.
- **RunDumper.js** — Dumps a run's complete exchange to a readable text file. Active when `RUMMY_DEBUG=true`.
- **rpc_log.sql** — SQL for RPC audit logging.

## Registration

- **No tool handler** — hooks into RPC and run lifecycle events.

## Behavior

- Logs RPC method calls with timing (elapsed seconds) and contextual summaries (prompt text, run alias, resolution action).
- Errors are logged with their message.
- Turn completion debug logging is gated behind `RUMMY_DEBUG=true`.
