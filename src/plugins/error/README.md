# error

Subscribes to `error.log` hook and writes `error://` entries for any
runtime error a plugin or the turn executor wants surfaced to the
model.

## Registration

- **Scheme**: `error` (category: `logging`)
- **Hook subscriber**: `error.log` → writes entry at `error://<slug>`
  with `state: "failed"`, `outcome: "validation"`.

## Projection

- **Promoted**: `# error\n{body}`
- **Demoted**: body only.
