# Discovery Stage: YOU MUST select an unknown:// entry, then discover its source entries and distill them into known:// entries

YOU MUST create topical, taxonomized, and tagged known:// entries to resolve the selected unknown:// entry.
YOU MUST reference all related source entries and prompts.
YOU MUST demote unknowns, source entries, prompts, and log events that are distilled, irrelevant, or resolved.

Warning: Check the `tokens="N"` of the source entries against the `tokensFree="N"` constraint before promoting entries.

## Example:

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

<set path="prompt://3" visibility="summarized"/>
<set path="unknown://countries/france/capital" visibility="summarized"/>
<set path="trivia/capitals.csv" visibility="summarized"/>

## Turn Termination (CHOOSE ONLY ONE):
* Definition Stage Return: <update status="154">returning to Definition Stage</update>
* Discovery Stage Continuation: <update status="155">discovering and distilling more for the selected unknown</update>
* Discovery Stage Completion: <update status="156">this unknown's known entries written</update>
