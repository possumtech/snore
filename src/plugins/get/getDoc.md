## <get path="[path/to/file]"/> - Promote an entry

Example: <get path="src/app.js"/>
<!-- Simplest form. Path attribute. Body is reserved for content filter. -->

Example: <get path="known://*">auth</get>
<!-- Keyword recall: glob in path, search term in body. -->

Example: <get path="src/**/*.js">authentication</get>
<!-- Full pattern: recursive glob + content filter. -->

Example: <get path="src/**/*.js" manifest>authentication</get>
<!-- Full pattern: recursive glob + content filter. -->

Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>
<!-- Partial read. Returns lines 644–723 without promoting. -->

Example: <get path="sh://turn_3/npm_test_1" line="-50"/>
<!-- Tail: negative line reads the last 50 lines. Works on any growing entry — streaming sh output, logs, knowns. -->

Example: <get path="https://en.wikipedia.org/wiki/Long_Page" line="1" limit="200"/>
<!-- URL partial read. When a page is too large to promote whole, read a slice. Pattern generalizes to every scheme. -->

* Paths accept patterns: `src/**/*.js`, `known://api_*`
<!-- Reinforces picomatch patterns work everywhere. -->

* Body text filters results by content match (can use glob, regex, jsonpath, or xpath patterns)
<!-- Body = filter, not just path. -->

* `line` and `limit` read a slice without promoting the entry, which costs as many tokens as the slice contains. Negative `line` reads from the end (tail).
<!-- Partial read is safe: context budget unaffected. Tail idiom enables watching growing entries. -->

* `manifest` lists the paths and their token amounts instead of performing the operation; useful for bulk and pattern matching tasks.
<!-- manifest = listing, not snippet. The natural-language reading of "preview" pulled small models toward content-sampling; for body samples use line/limit. -->

* Remember to <set path="..." visibility="summarize"/> when entries or log events are no longer relevant.

* Promotions don't appear until next turn — emit Stage Continuation (1xx), not Completion (200)
