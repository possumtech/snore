# Discovery Stage: Demote source entries that you discover after distilling them to maximize FCRM

YOU MUST ONLY perform discovery actions (Discover -> Distill -> Demote) during the Discovery Stage.
YOU MUST discover and get source entries with information relevant to the unknown:// entries.
YOU MUST create topical, taxonomized, and tagged known:// entries to resolve unknown:// entries.
YOU MUST include at least 1 link to a relevant unknown and at least 1 link to a relevant source entry or prompt in every known:// entry.
YOU MUST demote source entries and prompts to "summarized" after extracting their relevant information into known:// entries.
YOU MUST demote the unknown:// entries to "summarized" after they are referenced or resolved by known:// entries.
YOU MUST demote all irrelevant source entries, prompts, and log events to maximize FCRM.
Tip: Source entry "summarized" information is not reliable. Only place "visible" source entry and prompt information in known:// entries.
Tip: A "relevant" source entry or prompt that has been successfully distilled into known:// entries is no longer relevant.
Tip: Demote distilled source entries and prompts early and often to maximize FCRM.

## Discovery Lifecycle: Promoting a source entry, creating a known entry, demoting the source entry, then archiving the resolved unknown

### Discover

<set path="trivia/capitals.csv" visibility="visible"/>

### Distill
<set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">
# Capital of France
The capital of France is Paris.

{ ... }

## Related
[unknown resolving](unknown://countries/france/capital)
[source entry](trivia/capitals.csv)
</set>

### Demote

<set path="trivia/capitals.csv" visibility="summarized"/>
<set path="unknown://countries/france/capital" visibility="summarized"/>
<set path="unknown://countries/poland/capital" summary="REJECTED: Irrelevant" visibility="summarized"/>
<set path="https://en.wikipedia.org/wiki/Paris,_Texas" summary="REJECTED: Wrong Paris" visibility="summarized"/>
<set path="prompt://2" summary="All information distilled into knowns" visibility="summarized"/>
<set path="log://turn_1/set/*" visibility="archived"/>
<set path="log://turn_1/get/trivia/*" visibility="archived"/>
<set path="log://turn_2/get/capital%20of%20france" visibility="archived"/>

## Turn Termination (CHOOSE ONLY ONE):

Definition Stage Return: <update status="154">returning to definition stage</update>
Discovery Stage Continuation: <update status="155">referencing and resolving more unknowns</update>
Discovery Stage Completion: <update status="158">all unknowns (if any) referenced or resolved by known entries</update>
