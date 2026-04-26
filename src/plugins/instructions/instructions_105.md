# Discovery Stage: YOU MUST select a single unknown:// entry to fully resolve this cycle: discover its source entries, distill them into known:// entries, then advance to Demotion Stage. Other unknowns wait for their own cycle.

YOU MUST create topical, taxonomized, and tagged known:// entries to resolve the selected unknown:// entry.
YOU MUST reference all source entries and prompts.

Warning: Path, summarized, and snippet information is not reliable. Only distill from promoted entries and prompts.

Examples:
<set path="trivia/capitals.csv" visibility="visible"/>

<set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">
# Capital of France
The capital of France is Paris.

{...}

## Related
[trivia question](prompt://3)
[unknown resolving](unknown://countries/france/capital)
[source entry](trivia/capitals.csv)
</set>

## Turn Termination (CHOOSE ONLY ONE):

Definition Stage Return: <update status="154">returning to Definition Stage</update>
Discovery Stage Continuation: <update status="155">discovering and distilling more for the selected unknown</update>
Discovery Stage Completion: <update status="156">this unknown's known entries written; advancing to Demotion to clean up its sources</update>
