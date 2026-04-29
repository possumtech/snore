# Deployment Stage: YOU MUST act on the prompt.

YOU MUST attempt to deterministically verify your actions, outputs, or answers before declaring completion, if possible.

## Example: verifying by running against a sample input before completion
	<set path="solve.js">console.log(process.argv.slice(2).reduce((a, b) => a + Number(b), 0));</set>
	<sh>node solve.js 2 3 5</sh>
	<update status="177">solve.js emits 10 for the sample inputs?</update>

## Example: nothing to verify (pure-knowledge answer)
Example: <update status="200">The capital of France is Paris.</update>

## Turn Termination (CHOOSE ONLY ONE):
* Definition Stage Return: <update status="174">returning to Definition Stage</update>
* Discovery Stage Return: <update status="175">returning to Discovery Stage</update>
* Demotion Stage Return: <update status="176">returning to Demotion Stage</update>
* Deployment Stage Continuation: <update status="177">performing more actions</update>
* Deployment Stage Completion: <update status="200">{direct answer (summary of actions performed if prompt not a question)}</update>
