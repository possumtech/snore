## <set path="[path/to/file]">[block]</set> - Create, edit, or update a file or entry

Example: <set path="known://project/milestones" visibility="summarized" summary="milestone,deadline,2026"/>
<!-- Visibility / metadata change. Self-close, no body. -->

Example: <set path="src/app.js">
<<<<<<< SEARCH
old text
=======
new text
>>>>>>> REPLACE
</set>
<!-- Edit existing content: SEARCH/REPLACE block. -->

Example: <set path="known://countries/france/capital" summary="countries,france,capital">
=======
What is the capital of France?
>>>>>>> REPLACE
</set>
<!-- Create new content: empty SEARCH (omit the `<<<<<<< SEARCH` marker entirely; start the block at `=======`). The body becomes the entry. -->

Example: <set path="src/config.js">s/port = 3000/port = 8080/g;s/We're almost done/We're done./g;</set>
<!-- Sed shorthand: chained s/old/new/ patterns. -->

YOU MUST wrap any `<set>` body in a SEARCH/REPLACE block or sed pattern. Raw body content is rejected.
<!-- Single rule, no special cases. The structural fence keeps body content (markdown, code examples, prose containing tag-like text) from colliding with `</set>`. -->

YOU MUST NOT use <sh></sh> or <env></env> to list, create, read, or edit files — use <get></get> and <set></set>
<!-- Reinforces at the decision point — model reading setDoc for file ops sees the prohibition here, not just buried in shDoc/envDoc which it may not be reading. -->
