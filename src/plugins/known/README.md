# known {#known_plugin}

Writes knowledge entries into the store at full visibility, and renders
the project's data surface as the bifurcated `<summary>` /
`<visible>` blocks at the top of the user message.

## Registration

- **Tool**: `known`
- **Category**: `data`
- **Handler**: Upserts the entry body at the target path with status 200.
- **Filters**:
  - `assembly.user` priority 50 — renders `<summary>`.
  - `assembly.user` priority 75 — renders `<visible>`.

## Projection

Shows `# known {path}` followed by the entry body.

## Assembly

Filters `ctx.rows` where `category === "data"`. Two separate blocks
emit at the top of the user message in this order:

- `<summary>` — each data entry whose visibility is `visible` or
  `summarized`, rendered under its scheme tag with the plugin's
  summary projection as body (truncated knowns, code symbols,
  page abstracts — whatever the plugin's `summary()` hook produces).
  Archived entries — including prompts — are filtered out uniformly
  (no carve-out).
- `<visible>` — each data entry whose visibility is `visible`,
  rendered with the plugin's visible projection (full body) as the
  tag body. A visible entry appears in *both* blocks: summary
  projection up top, full body below.

This split lets `<summary>` stay cache-stable across promote/demote
operations — only `<visible>` mutates when the model promotes a
summary or demotes a visible entry. Third-party plugins that register
with `category: "data"` automatically appear in both blocks under
their scheme tag.
