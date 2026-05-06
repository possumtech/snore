## <sh>[command]</sh> - Run a shell command with side effects

Example: <sh>npm install express</sh>
Example: <sh>npm test 2>&1 | tee npm.log</sh>
Example: <get path="sh://turn_N/npm_test_*" line="-50"/>
<!-- Output is addressable: every <sh> result lives at sh://turn_N/<slug>. Slice with line/limit instead of re-running. -->

YOU MUST NOT use <sh></sh> to read, create, or edit files — use <get></get> and <set></set>
YOU MUST use <env></env> for commands without side effects
