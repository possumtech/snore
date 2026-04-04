# skills

Manages skills and personas via RPC methods. Skills are stackable per-run entries; personas are exclusive per-run configuration.

## Registration

- **No tool handler** — registers RPC methods on `hooks.rpc.registry`.

## RPC Methods

### Skills
- `skill/add` — Load a skill from `config/skills/{name}.md` into the run as a `skill://` entry at full state.
- `skill/remove` — Remove a skill entry from a run.
- `getSkills` — List active skills on a run.
- `listSkills` — List available skill files from disk.

### Personas
- `persona/set` — Set persona on a run. Load from `config/personas/{name}.md` by name, pass raw text, or clear by omitting both.
- `listPersonas` — List available persona files from disk.

## Behavior

- Skills stack: multiple skills can be active on a run simultaneously as separate `skill://` entries.
- Personas are exclusive: setting a persona replaces the previous one (stored as a run column, not an entry).
- File paths resolve from `RUMMY_HOME` environment variable.
