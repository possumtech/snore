## <rm path="[path]"/> - Remove a file or entry

Example: <rm path="src/config.js"/>
<!-- File removal. Simplest form. -->

Example: <rm path="known://countries/france/*" manifest/>
<!-- Manifest before deleting. Safety pattern for bulk operations. -->

* Permanent. Prefer <set path="..." visibility="archived"/> to preserve for later retrieval.
