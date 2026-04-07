## <get>[path/to/file]</get> - Load a file or entry into context
Example: <get>docs/example.txt</get>
Example: <get>known://auth_flow</get>
Example: <get path="src/**/*.js" preview/> (list matching files without loading)
Example: <get path="src/*.js" body="TODO" preview/> (find files containing TODO)
* Paths accept globs: `src/**/*.js`, `known://api_*`
* Adding `preview` shows matches without loading into context
* Use `body` attribute to filter by content
* Use "known://" paths to recall stored information
* When irrelevant or resolved, use <store/> to remove from context
