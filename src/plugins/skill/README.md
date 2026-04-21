# skill

Runtime skill management. A skill is a markdown file that gets
attached to a run as a `skill://<name>` entry. Models see skills
like any other entry.

## Files

- **skill.js** — RPC registration and skill file loading.

## Registration

- **Scheme**: `skill` (category: `data`)
- **Projections**: promoted → body; demoted → empty.

## RPC Methods

| Method | Params | Notes |
|--------|--------|-------|
| `skill/add` | `{ run, name }` | Load `${RUMMY_HOME}/skills/<name>.md` and attach it to the run as `skill://<name>`. |
| `skill/remove` | `{ run, name }` | Remove the skill entry from the run. |
| `getSkills` | `{ run }` | Skills active on a run. |
| `listSkills` | — | Available skill files on disk. |
