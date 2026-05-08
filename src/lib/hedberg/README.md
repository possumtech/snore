# hedberg {#hedberg_plugin}

The interpretation boundary between stochastic model output and
deterministic system operations.

Pattern matching (`hedmatch`, `hedsearch`) auto-detects glob, regex
(via `/pattern/flags`), jsonpath, xpath, or literal. `Hedberg.replace`
does fuzzy literal substitution — exact substring first, falling
through to heuristic whitespace-tolerant matching when the literal
miss is plausibly indentation drift. Edit-shape parsing
(`<<:::IDENT...:::IDENT` markers in `<set>` bodies) lives in
`marker.js` and is invoked by the XmlParser at `<set>` resolution
time; see SPEC.md "Edit Syntax".

## Usage

Any plugin can access hedberg via `core.hooks.hedberg`:

```js
constructor(core) {
    const { match, search, replace, generatePatch } = core.hooks.hedberg;
}
```

## API (available on core.hooks.hedberg)

| Method | Purpose |
|---|---|
| `match(pattern, string)` | Full-string pattern match (glob, regex, literal) |
| `search(pattern, string)` | Substring search, returns `{ found, match, index }` |
| `replace(body, search, replacement)` | Fuzzy literal replacement (whitespace-tolerant) |
| `generatePatch(path, old, new)` | Generate unified diff |

### Hedberg.replace(body, search, replacement)

Apply a replacement to text. Exact substring substitution via
`String.replaceAll` first; if no literal match, falls through to
heuristic fuzzy matching that's tolerant of whitespace and
indentation drift.

```js
const result = Hedberg.replace(fileContent, "port = 3000", "port = 8080");
// result: { patch, searchText, replaceText, warning, error }
```

For regex matching, use the explicit `/pattern/flags` syntax via
`hedmatch` / `hedsearch`.

## Files

- **hedberg.js** — plugin class, `replace()` method
- **marker.js** — edit-syntax marker parser (`<<:::IDENT...:::IDENT`)
- **patterns.js** — pattern type detection (regex, glob, jsonpath, xpath, literal)
- **matcher.js** — heuristic fuzzy matching, diff generation

## Future

This will become a separate npm package (`@possumtech/rummy.hedberg`)
to isolate the stochastic interpretation logic from the deterministic
core service.
