# stream {#stream_plugin}

Generic streaming entry infrastructure. Provides two RPC methods that
any producer plugin (sh, env, future: search, fetch, watch) can use to
populate data entries over time.

## RPC Methods

### `stream { run, path, channel, chunk }`

Append `chunk` to the entry at `{path}_{channel}`. Entry must exist
(created by the producer plugin on proposal acceptance, at status=102).

Unix FD convention for the channel number: 1=stdout, 2=stderr, higher
numbers for additional producer channels.

### `stream/completed { run, path, exit_code?, duration? }`

Transition all `{path}_*` data channels to terminal status:
- `exit_code=0` (or omitted) → status=200
- `exit_code≠0` → status=500

Rewrite the log entry at `path` with a summary: command, exit code,
duration, and channel sizes.

### `stream/aborted { run, path, reason?, duration? }`

Client-initiated cancellation. Transition all `{path}_*` data channels
to status **499 (Client Closed Request)** — the de-facto HTTP status
for a request terminated by the client. Rewrite the log entry body to
note the abort (with optional `reason` and `duration`).

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

1. On dispatch, creates a **proposal entry** at `sh://turn_N/{slug}` (or
   analogous) at status=202. Status transitions to 200 when the user
   accepts (this becomes the **log entry**).
2. On acceptance, creates **data entries** at `{path}_1`, `{path}_2`, etc.
   at status=102, category=data, visibility=summarized, empty body.
3. Client or external producer calls `stream` RPC with chunks as they
   arrive.
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
