## <set path="[path/to/file]">[content or edit]</set> - Create, edit, or update a file or entry

Example: <set path="known://project/milestones" visibility="summarized" summary="milestone,deadline,2026"/>
<!-- Visibility control first — most unique capability of set. -->

Example: <set path="known://countries/france/*" manifest/>
<!-- Manifest before bulk: lists matches without performing the visibility flip, edit, or write. -->


Example:
	<set path="src/app.js">
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

Example:
	<set path="OPUS_NOTES.md"><<EOF
	# Documentation about <set> and <get>
	| `<env>` | `<env>git log</env>` |
	Anything between the opener and EOF closer is content — including `</set>`.
	EOF
	</set>
<!-- HEREDOC body for arbitrary content. Pick any `[A-Za-z_]\w*` delimiter; the model chooses one that won't appear in the content. Closer is the delimiter alone on a line. -->
