## <cp path="[source]">[destination]</cp> - Copy a file or entry

Example: <cp path="src/config.js">src/config.backup.js</cp>
<!-- Simple file copy. Path = source, body = destination. -->

Example: <cp path="known://server/handler_main">src/main.c</cp>
<!-- Land a known entry's body as a file. When an implementation has
     been worked out as a known, copy it to its target path rather than
     re-emit the body as a <set>. -->

Example: <cp path="known://plan_*">known://archive_</cp>
<!-- Glob batch copy across known entries. -->
