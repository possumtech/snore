## <rm path="[path]"/> - Remove a file or entry

Example: <rm path="src/config.js"/>
<!-- File removal. Simplest form. -->

Example: <rm path="known://temp_*" preview/>
<!-- Preview before deleting. Safety pattern for bulk operations. -->

* Permanent. Prefer <set path="..." visibility="archived"/> to preserve for later retrieval
<!-- Nudges toward archive over rm. Path attr included so the model sees a complete invocation shape, not a fragment. -->

* `preview` shows what paths would be affected without performing the operation.
<!-- Canonical preview teaching lives here — rm is the most intuitive 'check before committing' case. Model generalizes to cp/mv/get by analogy. Advanced uses (e.g. archive rediscovery via <get preview>) belong in persona/skill docs, not here. -->
