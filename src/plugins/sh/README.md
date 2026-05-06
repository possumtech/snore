# sh {#sh_plugin}

Proposes shell command execution for client approval. Streaming
producer: the actual stdout/stderr arrive as separate data entries
after the proposal is accepted.

## Registration

- **Tool**: `sh`
- **Scheme**: `sh` — `category: "logging"` (channels are time-indexed activity, not state)
- **Handler**: Upserts the proposal entry at status 202 (proposed). The
  client must approve execution.

## Two namespaces per invocation

A single `<sh>` emission produces entries in two namespaces — one audit
record, one data payload:

- **Log entry**: `log://turn_N/sh/{slug}` — scheme=`log`, category=`logging`.
  This is the proposal the client sees and resolves. On accept, body is
  rewritten to `ran '{cmd}' (in progress). Output: {dataBase}_1, {dataBase}_2`
  and finalized by `stream/completed` with exit code + duration. Renders
  inside the `<log>` block as `<sh>`.
- **Data channels**: `sh://turn_N/{slug}_1` (stdout), `sh://turn_N/{slug}_2`
  (stderr) — scheme=`sh`, category=`logging` (time-indexed activity).
  Created at status=102 on proposal acceptance, grow via the `stream`
  RPC, transition to 200/500 via `stream/completed`. Render inside
  `<log>` adjacent to their parent `<sh>` action entry; visibility
  controls whether the body is full or compact, not which block.

The `sh` scheme exists **only** for the data channels. The proposal/log
entry itself is in the unified `log://` namespace along with every
other action record. See [scheme_category_split](#scheme_category_split).

## Projection

- **Visible**: `# sh {command}\n{body}` (channel body is the captured stream).
- **Summarized**: empty (the command + path are already shown via attrs).

## Behavior

All shell commands require client-side approval — nothing executes
server-side. Act mode only; excluded in ask mode by `resolveForLoop`.
