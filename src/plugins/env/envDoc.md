## <env>[command]</env> - Run an exploratory shell command

Example: <env>npm --version</env>
<!-- Version check. Safe, no side effects. -->

Example: <env>git log --oneline -5</env>
<!-- Git history. Shows env for read-only investigation. -->

YOU MUST NOT use <env></env> to read or list files — use <get path="*"/> instead
<!-- Prevents cat/ls through shell. Forces file access through get. -->

YOU MUST NOT use <env></env> for commands with side effects
<!-- Separates exploration from action. env = observe only. -->
