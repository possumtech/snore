## <rm path="[path]"/> - Remove a file or entry

Example: <rm path="src/config.js"/>
<!-- File removal. Simplest form. -->

Example: <rm path="known://countries/france/*" manifest/>
<!-- Manifest before deleting. Safety pattern for bulk operations. -->

Example: <rm path="log://turn_3/get/**"/>
<!-- Bulk delete by glob. Recursive scheme glob; clears a turn's get logs in one call. -->

* Permanent. Prefer <set path="..." visibility="archived"/> to preserve for later retrieval.
