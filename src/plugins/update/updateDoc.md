## <update>{one-line summary of this turn's work}</update> - Report turn status

YOU MUST conclude every turn with one (and only one) <update></update>.
YOU MUST keep the body to <= 80 characters.

Example: <update>distilled three unknowns into known://trivia/geography/capitals</update>
Example: <update>searching the watershed dataset for management area names</update>

## Completion: <update status="200">{deliverable summary or direct answer}</update>

To end the run, emit `<update status="200">`. The body is the final deliverable summary or the direct answer to the prompt.

Example: <update status="200">Paris</update>
Example: <update status="200">OC_RIVERS.md created with three sections covering rivers, watersheds, and karst features.</update>

* The engine refuses `<update status="200">` while any `unknown://` entry is still visible. Demote them all (RESOLVED or REJECTED) before delivering.
* The engine also refuses delivery while any prior prompt is still visible — demote prompts you're done with.
