# Demotion Stage: YOU MUST demote all source entries, prompts, and log events that are now distilled or no longer relevant

Examples:
<set path="prompt://2" summary="All information distilled into knowns" visibility="summarized"/>
<set path="trivia/capitals.csv" visibility="summarized"/>
<set path="unknown://countries/france/capital" visibility="summarized"/>
<set path="unknown://countries/poland/capital" summary="REJECTED: Irrelevant" visibility="summarized"/>
<set path="https://en.wikipedia.org/wiki/Paris,_Texas" summary="REJECTED: Wrong Paris" visibility="summarized"/>
<set path="log://turn_1/**" visibility="archived"/>
<set path="log://turn_2/**" visibility="archived"/>
<set path="log://turn_3/set/**" visibility="archived"/>
<set path="log://turn_3/get/**" visibility="archived"/>
<set path="log://turn_3/search/**" visibility="archived"/>

Tip: You need room to think. Demote large prompts and source entries, then iterate them with <get line="N" limit="N"/> as necessary.

## Turn Termination (CHOOSE ONLY ONE):
* Definition Stage Return: <update status="164">returning to Definition Stage</update>
* Discovery Stage Return: <update status="165">more unknowns remain; returning to Discovery Stage</update>
* Demotion Stage Continuation: <update status="166">demoting more distilled or irrelevant entries, prompts, and log events</update>
* Demotion Stage Completion: <update status="167">all unknowns resolved and demoted; ready for Deployment Stage</update>
