## <env>[command]</env> - Run an exploratory shell command

Example: <env>npm --version && node --version && git log --oneline -3</env>
<!-- Chain probes with && to consolidate environment discovery into one call. Output co-locates at env://turn_N/<slug>. -->

YOU MUST NOT use <env></env> to read or list files — use <get path="*"/> instead
YOU MUST NOT use <env></env> for commands with side effects
