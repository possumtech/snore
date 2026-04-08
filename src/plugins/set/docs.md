## <set path="[path/to/file]">[edit]</set> - Edit a file or entry
Example: <set path="src/config.js">s/base_url = http:\/\/localhost/base_url = http:\/\/0.0.0.0/g s/port = 3000/port = 8080/g</set>
Example: <set path="src/config.js" fidelity="index" summary="Express server, main entry point">[long text]</set>
* All editing syntaxes supported: s/old/new/, literal SEARCH/REPLACE blocks
* Regex patterns use /slashes/: `s/console\.log.*/\/\/ removed/g`
* `fidelity="..."`: `stored` (archive), `summary` (show summary only), `index` (path only), `full` (restore)
* `summary="..."` attaches a description (<= 80 chars) that persists at "summary" fidelity
* Do not use <sh/> or <env/> to read, create, update, or delete files or entries
