## <set path="{path}" tags="{topical,searchable,internal,tags}">[content or edit]</set> - Create, edit, or update an entry or file

* The <set/> command requires HEREDOC string literal syntax
* The <set/> command's SEARCH/REPLACE string literal syntax uses HEREDOC instead of git conflict markers
* The `{SEARCH|REPLACE|NEW|APPEND|PREPEND|DELETE} Operative Labels determine the type of edit

YOU MAY add additional characters to the Operative Labels to avoid collisions

Example:
	<set path="src/main.go" tags="go,source,unlinted"><<SEARCH
	exact
	text
	to be
	replaced
	SEARCH<<REPLACE
	new
	replacement
	text
	REPLACE</set>
<!-- SEARCH/REPLACE: surgical edit, fuzzy on whitespace. Multiple pairs in one body apply in order. -->

Example:
	<set path="src/main.go"><<NEW
	package main
	
	func main() {}
	NEW</set>
<!-- NEW: create with body content. -->

Example:
	<set path="known://plan" tags="plan,project,todo"><<APPEND
	- [ ] new task
	APPEND</set>
<!-- APPEND adds to the end; PREPEND to the start. -->

Example:
	<set path="known://plan" tags="docs"><<PREPEND0
	Documenting the <<PREPEND label	
	PREPEND0</set>
<!-- APPEND adds to the end; PREPEND to the start. -->

Example:
	<set path="src/main.go"><<DELETE
	deprecated_function()
	DELETE</set>
<!-- DELETE: remove a literal-matching region. -->

Example:
	<set path="docs/guide.md" tags="docs"><<GUIDE
	The pair is <<SEARCH ... SEARCH<<REPLACE ... REPLACE.
	GUIDE</set>
<!-- Any IDENT brackets opaque body. Use a custom IDENT (GUIDE, EOF, DOC, file paths, etc.) for bodies that contain `<<` literally. -->
