## <set path="[path]">[content or edit]</set> - Create, edit, or update an entry or file

Example: <set path="src/config.js">s|port = 3000|port = 8080|g;s|We're almost done|We're done.|g</set>
<!-- Sed: single-line substitutions, chain with semicolons. Pick any non-alphanumeric delimiter; the first unescaped delimiter ends each part, so choose one that doesn't appear in SEARCH or REPLACE. -->
Example: <set path="src/url.go">s#regex := "https://"+host#regex := "https?://"+host#g</set>
<!-- `#` and `,` read cleanly when content has both `/` and `|`. -->
Example:
	<set path="src/app.js">
	<<<<<<< SEARCH
	literal old text
	=======
	literal new text
	>>>>>>> REPLACE
	</set>
<!-- SEARCH/REPLACE: multi-line edits anchored against surrounding context. SEARCH must match the existing body literally (whitespace, punctuation, all). -->
Example:
	<set path="OPUS_NOTES.md"><<EOF
	# Arbitrary content here
	Anything between the opener and EOF closer is body — including `</set>`.
	EOF
	</set>
<!-- HEREDOC body for content with delimiter-conflicting characters. Pick any `[A-Za-z_]\w*` opener; closer is the opener alone on a line. -->
Example: <set path="example.md" tags="example,docs">Full file content here</set>
<!-- Body without an edit shape replaces the entire entry. -->
