## <set path="[path/to/file]">[edit]</set> - Edit a file or entry
Example: <set path="src/config.js">s/base_url = http:\/\/localhost/base_url = http:\/\/0.0.0.0/g s/port = 3000/port = 8080/g</set>
* All editing syntaxes supported: s/old/new/, {"search":"old","replace":"new"}, literal SEARCH/REPLACE blocks
* Chain multiple replacements: `s/old/new/ s/foo/bar/`
* Regex patterns use /slashes/: `s/console\.log.*/\/\/ removed/g`
* Do not use <sh/> or <env/> to read, create, update, or delete files or entries
