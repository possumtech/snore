# hedberg

The interpretation boundary between stochastic model output and
deterministic system operations.

Models speak in whatever syntax they were trained on — sed regex,
SEARCH/REPLACE blocks, escaped characters, regex anchors, malformed
XML. Hedberg normalizes all of it into clean, deterministic operations.

## API

### Hedberg.replace(body, search, replacement, options?)

Apply a replacement to text. Tries sed regex (if `sed: true`), then
literal match, then heuristic fuzzy match.

```js
const result = Hedberg.replace(fileContent, "7 - a =$", "7 - a = 5", {
    sed: true,
    flags: "g",
});
// result: { patch, searchText, replaceText, warning, error }
```

### parseSed(input)

Parse sed syntax into blocks. Handles escaped delimiters, chained
commands, flag extraction.

```js
const blocks = parseSed("s/foo/bar/g s/baz\\/qux/hello/");
// [{ search: "foo", replace: "bar", flags: "g", sed: true },
//  { search: "baz/qux", replace: "hello", flags: "", sed: true }]
```

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
