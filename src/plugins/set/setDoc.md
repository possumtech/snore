## <set path="[path]">[content or edit]</set> - Create, edit, or update an entry or file

Example:
	<set path="src/main.go"><<:::NEW
	package main

	func main() {}
	:::NEW</set>
<!-- NEW: create with body content. -->

Example:
	<set path="known://plan"><<:::APPEND
	- [ ] new task
	:::APPEND</set>
<!-- APPEND adds to the end; PREPEND to the start. -->

Example:
	<set path="src/main.go"><<:::SEARCH
	old line
	:::SEARCH<<:::REPLACE
	new line
	:::REPLACE</set>
<!-- SEARCH/REPLACE: surgical edit, fuzzy on whitespace. Multiple pairs in one body apply in order. -->

Example:
	<set path="src/main.go"><<:::DELETE
	deprecated_function()
	:::DELETE</set>
<!-- DELETE: remove a literal-matching region. -->

Example:
	<set path="docs/guide.md"><<:::GUIDE
	The pair is <<:::SEARCH ... :::SEARCH<<:::REPLACE ... :::REPLACE.
	:::GUIDE</set>
<!-- Any IDENT brackets opaque body. Use a custom IDENT (GUIDE, EOF, DOC, file paths, etc.) for bodies that contain `<<:::` literally. -->
