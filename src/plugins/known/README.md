# known {#known_plugin}

Writes knowledge entries into the store at full visibility.

## Registration

- **Tool**: `known`
- **Category**: `data`
- **Handler**: Upserts the entry body at the target path with status 200.
- **Filter**: `assembly.system` at priority 100 — renders `<knowns>` section.

## Projection

Shows `# known {path}` followed by the entry body.

## Assembly

Filters turn_context rows where `category === "data"`. Renders all
data entries (files, knowledge, skills, URLs) into the `<knowns>` section
of the system message. Third-party plugins that register with
`category: "data"` automatically appear here.
