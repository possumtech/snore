## <cp path="[source]">[destination]</cp> - Copy a file or entry

Example: <cp path="src/config.js">src/config.backup.js</cp>
<!-- Simple file copy. Path = source, body = destination. -->

Example: <cp path="known://server/handler_main">src/main.c</cp>
<!-- Land a known's body as a file: cp instead of re-emitting via <set>. -->

Example: <cp path="known://countries/france/*">known://archive/countries/france/</cp>
<!-- Glob batch copy across known entries. -->

Example: <cp path="known://countries/france/*" manifest/>
<!-- Manifest preview before glob batch copy. -->
