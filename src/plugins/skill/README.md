# skill {#skill_plugin}

Drop-in deep skills: a single markdown file, a folder of markdown files,
or a `.zip` archive — local or URL — archived under `skill://<name>/...`
for the run.

## Files

- **skill.js** — `<skill>` tag handler + `skill://` scheme.
- **skillDoc.md** — model-facing tooldoc.

## Tag

`<skill path="[path-or-url]"/>`

- Single `.md` file → archived at `skill://<basename>` (summarized).
- Folder → walk `*.md`; index file (`index.md`) → `skill://<foldername>`
  (summarized); rest → `skill://<foldername>/<relpath-without-.md>`
  (archived). `index.md` segments collapse: `foo/index.md` becomes
  `skill://<foldername>/foo`.
- `.zip` → unpack `*.md`; same layout as folder. Top-level archive
  folder is stripped (`example/index.md` inside `example.zip` ↦
  `skill://example`).
- URL → fetch. `.zip` extension or `Content-Type: application/zip`
  triggers zip unpack; otherwise treated as a single markdown file.

Relative paths resolve against the project root. Absolute paths used
as-is.

## Authoring

Skill files reference each other with absolute `skill://...` URIs:
`[next](skill://playbook/next)`. No relative-link rewriting at archive
time — the contract is explicit so navigation works the same regardless
of how the skill was packaged.

## Visibility

- Index page → `summarized` (model sees a header in summary; pulls
  full body via `<get>`).
- All other pages → `archived` (out of context until promoted).

## Re-emit

Re-emitting `<skill path="..."/>` overwrites prior entries — source may
have changed mid-run.
