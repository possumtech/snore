# env {#env_plugin}

Runs an exploratory shell command and records the output. Streaming
producer — same entry shape as [sh](../sh/README.md), different scheme
name so ask-mode policy can admit read-only discovery without allowing
side effects.

## Registration

- **Tool**: `env`
- **Scheme**: `env` — `category: "logging"` (channels are time-indexed activity, not state)
- **Handler**: Upserts the proposal entry at status 202 (proposed).

## Two namespaces per invocation

- **Log entry**: `log://turn_N/env/{slug}` — scheme=`log`, category=`logging`.
  The audit record (renders inside `<log>` as `<env>`).
- **Data channels**: `env://turn_N/{slug}_1` (stdout), `env://turn_N/{slug}_2`
  (stderr) — scheme=`env`, category=`logging` (time-indexed activity).
  Render inside `<log>` adjacent to their parent `<env>` action entry;
  visibility controls whether the body is full or compact, not which
  block they appear in.

The `env` scheme exists **only** for the data channels. See
[scheme_category_split](#scheme_category_split).

## Projection

- **Visible**: `# env {command}\n{body}`.
- **Summarized**: empty.
