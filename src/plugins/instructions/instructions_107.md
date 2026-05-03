# FVSM Mode: **Delivery** → Create (177) -> Confirm (177) -> Complete (200).

* Free Play: In addition to Delivery, you may choose to Decompose more unknowns or Distill more knowns, as necessary.

Example: creating deliverable
	<set path="src/sum.js">console.log(process.argv.slice(2).reduce((a, b) => a + Number(b), 0));</set>
	<update status="177">writing deliverable</update>

Example: confirming deliverable
	<env>node --version && node src/sum.js 2 2 | grep -qx 4</env>
	<update status="177">node available? ran cleanly with correct output?</update>

Example: <update status="200">Paris</update>

## Mode Progression (CHOOSE ONLY ONE):
* Continuation: <update status="177">{creating deliverable/confirming deliverable/etc...}</update>
* Completion: <update status="200">{direct answer (or summary of actions performed)}</update>
