## <set path="[path]">[content or edit]</set> - Create, edit, or update an entry or file

Example: <set path="src/config.js">s|port = 3000|port = 8080|g;s|We're almost done|We're done.|g</set>
<!-- Sed: single-line substitutions, chain with semicolons. Pick any non-alphanumeric delimiter; the first unescaped delimiter ends each part, so choose one that doesn't appear in SEARCH or REPLACE. -->
Example: <set path="src/api.js">s,baseUrl = "/api/v1",baseUrl = "/api/v2",g</set>
<!-- Pick a delimiter that doesn't appear in SEARCH or REPLACE. Comma reads clean here because the content has slashes. -->
Example:
	<set path="src/app.js">
	<<<<<<< SEARCH
	literal old text
	=======
	literal new text
	>>>>>>> REPLACE
	</set>
<!-- SEARCH/REPLACE: multi-line edits anchored against surrounding context. SEARCH must match the existing body literally (whitespace, punctuation, all). -->
Example: <set path="example.md" tags="example,docs">Full file content here</set>
<!-- Body without an edit shape replaces the entire entry. -->
Example:
	<set path="OPUS_NOTES.md"><<EOF
	# Arbitrary literal content here
	Anything between the opener and closer is body — including `</set>`.
	EOF
	</set>
<!-- HEREDOC body for content with delimiter-conflicting characters. Pick any `[A-Za-z_]\w*` opener; closer is the opener alone on a line. -->
