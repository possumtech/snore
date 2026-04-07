## <set path="[path/to/file]">[edit]</set> - Edit a file or entry
Example: <set path="src/config.js">s/base_url = http:\/\/localhost/base_url = http:\/\/0.0.0.0/g s/port = 3000/port = 8080/g</set>
Example: <set path="src/config.js" summary="Express server, main entry point"/> (describe and show summary only)
Example: <set path="known://notes" stored>Long research notes to save for later.</set>
Example: <set path="known://old_data" stored/> (archive — remove from context)
* All editing syntaxes supported: s/old/new/, {"search":"old","replace":"new"}, literal SEARCH/REPLACE blocks
* Chain multiple replacements: `s/old/new/ s/foo/bar/`
* Regex patterns use /slashes/: `s/console\.log.*/\/\/ removed/g`
* Fidelity flags: `stored` (archive), `summary` (show summary only), `index` (path only), `full` (restore)
* `summary="..."` attaches a description (<= 80 chars) that persists across fidelity changes
* Write directly to storage: `<set path="..." stored>content</set>` saves without entering context
* Do not use <sh/> or <env/> to read, create, update, or delete files or entries
