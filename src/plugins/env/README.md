# env {#env_plugin}

Runs an exploratory shell command and records the output. Streaming
producer — same entry shape as [sh](../sh/README.md), different scheme
name so ask-mode policy can admit read-only discovery without allowing
side effects.

## Registration

- **Tool**: `env`
- **Scheme**: `env` — `category: "data"` (channels only; see below)
- **Handler**: Upserts the proposal entry at status 202 (proposed).

## Two namespaces per invocation

- **Log entry**: `log://turn_N/env/{slug}` — scheme=`log`, category=`logging`.
  The audit record (renders inside `<log>` as `<env>`).
- **Data channels**: `env://turn_N/{slug}_1` (stdout), `env://turn_N/{slug}_2`
  (stderr) — scheme=`env`, category=`data`. The captured payload
  (renders inside `<context>` as `<env>`).

The `env` scheme exists **only** for the data channels. See
[scheme_category_split](#scheme_category_split).

## Projection

- **Visible**: `# env {command}\n{body}`.
- **Summarized**: empty.
