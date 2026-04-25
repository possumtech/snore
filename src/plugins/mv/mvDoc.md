## <mv path="[source]">[destination]</mv> - Move or rename a file or entry

Example: <mv path="known://active_task">known://completed_task</mv>
<!-- Entry rename. Most common mv use case. -->

Example: <mv path="src/old_name.js">src/new_name.js</mv>
<!-- File rename. -->

Example: <mv path="known://project/*" visibility="summarized"/>
<!-- Batch visibility change via pattern. No destination = visibility in place. -->
