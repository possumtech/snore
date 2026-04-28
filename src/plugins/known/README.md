# known {#known_plugin}

Writes knowledge entries into the store at full visibility, and renders
the project's data surface as the bifurcated `<summarized>` /
`<visible>` blocks at the top of the user message.

## Registration

- **Tool**: `known`
- **Category**: `data`
- **Handler**: Upserts the entry body at the target path with status 200.
- **Filters**:
  - `assembly.user` priority 50 — renders `<summarized>`.
  - `assembly.user` priority 75 — renders `<visible>`.

## Projection

Shows `# known {path}` followed by the entry body.

## Assembly

Filters `ctx.rows` where `category === "data"`. Two separate blocks
emit at the top of the user message in this order:

- `<summarized>` — one self-closing summary line per data entry whose
  visibility is `visible` or `summarized`. Plus the named carve-out:
  archived prompts pass through (visibility="archived"), so the model
  can `<get>` the active prompt back after demotion.
- `<visible>` — full body of each data entry whose visibility is
  `visible`. A visible entry appears in *both* blocks: as a summary
  line in `<summarized>` (its identity), and as a full body in
  `<visible>` (its current working-memory presence).

This split lets `<summarized>` stay cache-stable across promote/demote
operations — only `<visible>` mutates when the model promotes a
summary or demotes a visible entry. Third-party plugins that register
with `category: "data"` automatically appear in both blocks under
their scheme tag.
