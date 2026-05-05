## <set path="[path/to/file]">[content or edit]</set> - Create, edit, or update a file or entry

Example: <set path="known://project/milestones" visibility="summarized" summary="milestone,deadline,2026"/>
<!-- Visibility control first — most unique capability of set. -->

Example: <set path="log://turn_3/**" visibility="archived"/>
<!-- Bulk visibility op: applies to every entry matching the glob. Pattern works on any scheme. -->

Example: <set path="log://turn_[1-3]/**" visibility="archived"/>
<!-- Character class [1-3]: archive turns 1, 2, AND 3 in one op. Useful for cleaning a recent burst of logs. -->

Example: <set path="known://countries/france/*" manifest/>
<!-- Manifest before bulk: lists matches without performing the visibility flip, edit, or write. -->


Example: <set path="src/config.js">s/port = 3000/port = 8080/g;s/We're almost done/We're done./g;</set>
<!-- Sed: single-line substitutions, chain with semicolons. Reach for this first for plan checkmarks, config flips, word swaps — the SEARCH text is short and explicitly bounded by the slashes, so it can't accidentally match a partial line. -->

Example: <set path="src/api.js">s,baseUrl = "/api/v1",baseUrl = "/api/v2",g</set>
<!-- Alternative delimiters: `s,...,...,g` or `s|...|...|g` when SEARCH or REPLACE contains `/`. The first unescaped delimiter ends each part, so `s/path/to/x/y/z/g` is ambiguous — pick a delimiter that doesn't appear in your content. -->

Example:
	<set path="src/app.js">
	<<<<<<< SEARCH
	old text
	=======
	new text
	>>>>>>> REPLACE
	</set>
<!-- SEARCH/REPLACE: multi-line edits where you want to anchor against surrounding context. The SEARCH block must match the existing body literally (whitespace, punctuation, and all). -->


Example: <set path="example.md" visibility="summarized" summary="example,docs">Full file content here</set>
<!-- Create: body is the entire file. visibility and summary are independent attributes — they don't replace the body. -->

Example:
	<set path="OPUS_NOTES.md"><<EOF
	# Documentation about <set> and <get>
	| `<env>` | `<env>git log</env>` |
	Anything between the opener and EOF closer is content — including `</set>`.
	EOF
	</set>
<!-- HEREDOC body for arbitrary content. Pick any `[A-Za-z_]\w*` delimiter; the model chooses one that won't appear in the content. Closer is the delimiter alone on a line. -->
