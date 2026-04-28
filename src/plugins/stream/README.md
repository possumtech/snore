# stream {#stream_plugin}

Generic streaming entry infrastructure. Provides RPC methods that any
producer plugin (sh, env, future: search, fetch, watch) can use to
populate data entries over time.

## Namespace split

A streaming action lives in **two namespaces** by design:

- **Log entry** (audit record): `log://turn_N/{action}/{slug}` —
  scheme=`log`, category=`logging`. Created by the producer's dispatch
  handler (via `TurnExecutor` → `logPath`). This is the proposal the
  client resolves. Renders inside `<log>`.
- **Data channels** (payload): `{action}://turn_N/{slug}_1`,
  `{action}://turn_N/{slug}_2`, ... — scheme=`{action}` (sh, env, ...),
  category=`data`. Created at status=102 on proposal acceptance. Grow
  via `stream`; terminal via `stream/completed` / `stream/aborted` /
  `stream/cancel`. Render inside `<visible>` (or `<summarized>` if
  demoted).

The stream RPC `path` param is always the **log-entry path** (the
`log://...` path the client discovers via `getEntries` after a
`run/changed` pulse). The server derives the data base path internally
via `logPathToDataBase`. See [scheme_category_split](#scheme_category_split).

## RPC Methods

### `stream { run, path, channel, chunk }`

Append `chunk` to the data channel entry at `{dataBase}_{channel}`,
where `dataBase` is derived from the log path. Entry must exist
(created by the producer plugin on proposal acceptance, at status=102).

Unix FD convention for the channel number: 1=stdout, 2=stderr, higher
numbers for additional producer channels.

### `stream/completed { run, path, exit_code?, duration? }`

Transition all `{dataBase}_*` data channels to terminal status:
- `exit_code=0` (or omitted) → status=200
- `exit_code≠0` → status=500

Rewrite the log entry at `path` with a summary: command, exit code,
duration, and channel sizes.

### `stream/aborted { run, path, reason?, duration? }`

Client-initiated cancellation. Transition all `{dataBase}_*` data
channels to status **499 (Client Closed Request)** — the de-facto HTTP
status for a request terminated by the client. Rewrite the log entry
body to note the abort (with optional `reason` and `duration`).

Client contract: kill the underlying process first, then call
`stream/aborted`. Body of each data channel is preserved at whatever
content was streamed before the kill.

### `stream/cancel { run, path, reason? }`

Server-initiated cancellation. Any client (or internal server code) can
cancel a streaming producer — the server transitions channels to **499**
immediately and pushes a `stream/cancelled` notification to all connected
clients so they can kill their local processes.

Also serves as **stale 102 cleanup**: if the originating client died
mid-stream (`stream/completed` never arrived), any client can call
`stream/cancel` to mark orphaned entries terminal.

## Producer Plugin Contract

A streaming producer plugin:

1. On model dispatch, writes the **proposal/log entry** at
   `log://turn_N/{action}/{slug}` at status=202 (this is automatic —
   `TurnExecutor` builds the path via `logPath`; the producer's
   `handler` just persists it).
2. On `proposal.accepted`, derives the data base
   (`logPathToDataBase(ctx.path)`) and creates **data entries** at
   `{dataBase}_1`, `{dataBase}_2`, etc. at status=102, category=data,
   visibility=summarized, empty body. Then rewrites the log entry body
   to reference the channel paths.
3. Client or external producer calls the `stream` RPC with chunks as
   they arrive.
4. When the producer is done, the client/producer calls
   `stream/completed`.

Current producers:
- **sh** — shell commands with side effects (stdout ch1, stderr ch2)
- **env** — safe shell (stdout ch1, stderr ch2)

Future producers that could adopt this pattern:
- **search** — web search results streaming in (primary ch1, warnings ch2)
- **fetch** — large page fetch (body ch1, redirects/headers ch2)
- **tail** — log file following (lines ch1)
- **watch** — file system events (events ch1)

## Not a Model-Facing Tool

No scheme registration, no tooldoc, no dispatch handler. The model
interacts with streamed output via `<get>` on the data entries; the
stream plugin is purely RPC infrastructure that clients and producer
plugins use.
