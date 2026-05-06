# hedberg {#hedberg_plugin}

The interpretation boundary between stochastic model output and
deterministic system operations.

Models speak in whatever syntax they were trained on — sed substitutions,
SEARCH/REPLACE blocks, escaped characters, malformed XML. Hedberg
normalizes all of it into clean, deterministic operations.

Pattern matching elsewhere (path globs, body filters via `hedmatch` /
`hedsearch`) still supports explicit regex via `/pattern/flags` syntax.
Sed substitution itself is **literal substring replacement** — the
parser strips regex-style backslash escapes (`\[`, `\.`, `\|`, etc.)
so the model's muscle memory doesn't break, but no regex is compiled.
This sharpens the contract: `/pattern/flags` is regex; `s|search|replace|g`
is literal.

## Usage

Any plugin can access hedberg via `core.hooks.hedberg`:

```js
constructor(core) {
    const { match, replace, parseSed } = core.hooks.hedberg;
}
```

## API (available on core.hooks.hedberg)

| Method | Purpose |
|--------|---------|
| `match(pattern, string)` | Full-string pattern match (glob, regex, literal) |
| `search(pattern, string)` | Substring search, returns `{ found, match, index }` |
| `replace(body, search, replacement, opts?)` | Apply replacement (literal substring → heuristic fuzzy) |
| `parseSed(input)` | Parse sed syntax into `[{ search, replace, flags, sed }]` |
| `parseEdits(content)` | Detect edit format (merge conflict, udiff, Claude XML) |
| `generatePatch(path, old, new)` | Generate unified diff |

### Hedberg.replace(body, search, replacement, options?)

Apply a replacement to text. Always literal substring substitution
via `String.replaceAll`. With `sed: true`, regex-style backslash
escapes (`\[`, `\.`, `\|`, etc.) are stripped from search and
replacement so the model's escape habits map to literal characters.
If no exact substring match is found, falls through to heuristic
fuzzy matching.

```js
const result = Hedberg.replace(fileContent, "port = 3000", "port = 8080", {
    sed: true,
});
// result: { patch, searchText, replaceText, warning, error }
```

`sed: true` does NOT enable regex. Anchors (`^`, `$`), character
classes (`[abc]`), quantifiers (`*`, `+`, `?`), capture groups (`$1`),
and case flags (`i`, `m`) all behave as literal characters or are
ignored. For real regex matching, use the explicit `/pattern/flags`
syntax via `hedmatch` / `hedsearch`.

### parseSed(input)

Parse sed syntax into blocks. Handles escaped delimiters, chained
commands (separated by `;`, whitespace, or newlines), and flag
extraction. Recognized flags: `g`, `i`, `m`. Real-sed flags `s`
(dot-matches-newline) and `v` (POSIX mode) are NOT recognized — `s`
collides with chained `s<delim>` after whitespace and neither has any
effect on literal substring substitution.

```js
const blocks = parseSed("s/foo/bar/g s/baz\\/qux/hello/");
// [{ search: "foo", replace: "bar", flags: "g", sed: true },
//  { search: "baz/qux", replace: "hello", flags: "", sed: true }]
```

Multi-line layout (search/replace/flags on separate lines) is
tolerated — leading whitespace before flags is stripped:

```js
const blocks = parseSed("s|old|\nnew|\ng");
// [{ search: "old", replace: "\nnew", flags: "g", sed: true }]
```

Note: whitespace inside search/replace fields is preserved verbatim.
A trailing newline before the closing delimiter becomes part of the
search/replace text. Models that lay out long substitutions across
multiple lines should be aware of this.

### Pattern functions (hedmatch, hedsearch, hedreplace)

Auto-detect pattern type and match/search/replace accordingly.
Used by SQL functions for database-level pattern operations.

## Files

- **hedberg.js** — plugin class, `replace()` method
- **patterns.js** — pattern type detection (regex, glob, jsonpath, xpath, literal)
- **matcher.js** — heuristic fuzzy matching, diff generation
- **sed.js** — sed syntax parsing

## Future

This will become a separate npm package (`@possumtech/rummy.hedberg`)
to isolate the stochastic interpretation logic from the deterministic
core service.
