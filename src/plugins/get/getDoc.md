## <get path="[path]"/> - Promote an entry

Example: <get path="known://*">auth</get>
<!-- Body is a content filter, not new content. Path glob + body keyword = filtered recall. -->
Example: <get path="src/**/!(*.test).js" manifest>auth</get>
<!-- Negation: !(pattern) excludes matches; combine with body filter for "auth in sources, not tests." -->
Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>
<!-- line/limit: read a slice without promoting. line=-50 tails the last 50 lines. -->
Example: <get path="https://en.wikipedia.org/wiki/Long_Page" line="1" limit="200"/>
<!-- URL slice. line/limit works on any scheme — files, sh stdout, knowns, urls. -->

* Remember to demote entries that are no longer relevant.
