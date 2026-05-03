## <mv path="[source]">[destination]</mv> - Move or rename a file or entry

Example: <mv path="known://tasks/active/import_csv">known://tasks/done/import_csv</mv>
<!-- Entry rename across hierarchical namespace. Most common mv use case. -->

Example: <mv path="src/old_name.js">src/new_name.js</mv>
<!-- File rename. -->

Example: <mv path="known://project/*" visibility="summarized"/>
<!-- Batch visibility change via pattern. No destination = visibility in place. -->

Example: <mv path="known://countries/france/*" manifest/>
<!-- Manifest preview before glob rename or visibility batch. -->
