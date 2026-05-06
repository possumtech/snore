## <get path="[path/to/file]"/> - Promote an entry

Example: <get path="src/app.js"/>
<!-- Simplest form. Path attribute. Body is reserved for content filter. -->

Example: <get path="known://*">auth</get>
<!-- Keyword recall: glob in path, search term in body. -->

Example: <get path="src/**/*.js" manifest>authentication</get>
<!-- Bulk discovery: recursive glob + content filter + manifest — lists matches without promoting any. -->

Example: <get path="**/*.{js,ts}" tags="hydrology" manifest/>
<!-- Folksonomic recall: list entries whose stored `tags` include all listed terms. Same `tags` attribute that <set> writes. Path glob (with brace expansion) scopes the search; default is **. -->

Example: <get path="unknown://**" manifest/>
<!-- Inventory unfinished work without promoting. Recursive scheme glob applies to any scheme: known://, log://, prompt://, etc. -->

Example: <get path="src/**/!(*.test).js" manifest>auth</get>
<!-- Negation: !(pattern) excludes matches. Combine with body filter to find "auth in source files but not tests." -->

Example: <get path="prompt://1"/>
<!-- Recall a specific prior prompt by number. Useful in multi-prompt runs to re-read what was originally asked. -->

Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>
<!-- Partial read. Returns lines 644–723 without promoting. -->

Example: <get path="sh://turn_3/npm_test_1" line="-50"/>
<!-- Tail: negative line reads the last 50 lines. Works on any growing entry — streaming sh output, logs, knowns. -->

Example: <get path="https://en.wikipedia.org/wiki/Long_Page" line="1" limit="200"/>
<!-- URL partial read. When a page is too large to promote whole, read a slice. Pattern generalizes to every scheme. -->

* Remember to demote entries, log events, or line/limit log entries that are no longer relevant.
