## <set path="[path/to/file]">[content or edit]</set> - Create, edit, or update a file or entry

Example: <set path="known://project/milestones" visibility="summarized" summary="milestone,deadline,2026"/>
<!-- Visibility control first — most unique capability of set. -->

Example: <set path="src/app.js">
<<<<<<< SEARCH
old text
=======
new text
>>>>>>> REPLACE
</set>
<!-- SEARCH/REPLACE block — primary edit pattern for existing files. -->

Example: <set path="src/config.js">s/port = 3000/port = 8080/g;s/We're almost done/We're done./g;</set>
<!-- Sed syntax: chained s/old/new/ patterns with semicolons. -->

Example: <set path="example.md">Full file content here</set>
<!-- Create: body contents are entire file. -->

When a body contains tag-like markdown (e.g. examples of `<get>` or `<set>` syntax), wrap the examples in backticks. Backtick spans inside a body are treated as literal text and will not be parsed as tags.

YOU MUST NOT use <sh></sh> or <env></env> to list, create, read, or edit files — use <get></get> and <set></set>
<!-- Reinforces at the decision point — model reading setDoc for file ops sees the prohibition here, not just buried in shDoc/envDoc which it may not be reading. -->
