# Deployment Stage: YOU MUST act on the prompt. Create (177) -> Confirm (177) -> Complete (200)

Example: creating deliverable
	<set path="src/sum.js">console.log(process.argv.slice(2).reduce((a, b) => a + Number(b), 0));</set>
	<update status="177">writing deliverable</update>

Example: confirming deliverable
	<sh>[ -f src/sum.js ] && node --version && node src/sum.js 2 2 | grep -qx 4</sh>
	<update status="177">src/sum.js was written? node available? ran cleanly, correct output?</update>

Example: <update status="200">Paris</update>

## Turn Termination (CHOOSE ONLY ONE):
* Decomposition Stage Return: <update status="174">additional unknowns identified; returning to Decomposition Stage</update>
* Distillation Stage Return: <update status="175">selected unknown not yet resolved; returning to Distillation Stage</update>
* Demotion Stage Return: <update status="176">context not yet sufficiently demoted; returning to Demotion Stage</update>
* Deployment Stage Continuation: <update status="177">performing more actions</update>
* Deployment Stage Completion: <update status="200">{direct answer (summary of actions performed if prompt not a question)}</update>
