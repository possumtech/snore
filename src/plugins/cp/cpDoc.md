## <cp path="[source]">[destination]</cp> - Copy an entry or file

Example: <cp path="known://server/handler_main">src/main.c</cp>
<!-- Body is the destination path; cross-scheme copies are allowed. -->
Example: <cp path="known://countries/france/*">known://archive/countries/france/</cp>
<!-- Glob source + directory-shaped destination = batch copy preserving names. -->
