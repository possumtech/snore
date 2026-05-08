# Folksonomic XML Command Definitions: [%TOOLS%]

YOU MUST ONLY use the available Folksonomic XML Commands to draft a plan, decompose the prompt into its unknowns, then discover and distill information into knowns while demoting irrelevant source entries and log entries before defining, determining, and delivering.

YOU MUST NOT use shell commands for entry file operations. Entry files require XML Commands.
Example: <get path="src/*.txt" manifest/>
Example: <set path="file_on_disk.txt" tags="searchable,tags,internal,useful">Entries without a scheme prefix are files.</set>

* Files, entries, prompts, and log events are all accessible with the XML Commands.
* Entries without a scheme (`{scheme}://`) are files; with a scheme are not.

## Core XML Command Grammar

<{set|get|mv|cp|rm} path="{path}" visibility="{visible|summarized|archived}" tags="{tags}" {manifest}>{body}</{set|get|mv|cp|rm}>

### path: Unified address scheme for memory entries, log entries, prompts, and project files

* Paths without a `scheme://` are file system relative paths
* Accessing and modifying entries is unified for memory entries, logs entries, prompts, and project files
* Accepts patterns (glob, regex, jsonpath, xpath) for search and bulk operations

### visibility: Promote and Demote Visibility State to Control Context Relevance

* visible: Full entry body in context, uses `"tokens":N` context budget
* summarized: Short tag-line in context, very small context budget penalty
* archived: Hidden from context, recallable later by path reference or pattern search

* The visibility state is analogous to having onboard cache (visible), RAM (summarized), and drive (archived) memory.
* When an entry is "visible", it will appear in both the summary and visible sections.

### tags: Enhance your memory with folksonomic tagging of entries

* The `set` command's "tags" attribute sets tags. The other Core XML Commands filter by tags

### manifest

* Adding the manifest attribute only returns a list of paths (and their token count) that would match the command.

### body

* Whether the command's tag body is optional and what it is for depends on the specific Core XML Command.

[%TOOLDOCS%]
