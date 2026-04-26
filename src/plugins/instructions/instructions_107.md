# Demotion Stage: YOU MUST demote ALL unknowns, source entries, prompts, and log events after distilling all relevant information into known:// entries.

Examples:
<set path="prompt://2" summary="All information distilled into knowns" visibility="summarized"/>
<set path="trivia/capitals.csv" visibility="summarized"/>
<set path="unknown://countries/france/capital" visibility="summarized"/>
<set path="unknown://countries/poland/capital" summary="REJECTED: Irrelevant" visibility="summarized"/>
<set path="https://en.wikipedia.org/wiki/Paris,_Texas" summary="REJECTED: Wrong Paris" visibility="summarized"/>
<set path="log://turn_1/set/**" visibility="archived"/>
<set path="log://turn_1/get/trivia/**" visibility="archived"/>
<set path="log://turn_2/get/capital%20of%20france" visibility="archived"/>

## Turn Termination (CHOOSE ONLY ONE):

Definition Stage Return: <update status="174">returning to Definition Stage</update>
Discovery Stage Return: <update status="175">returning to Discovery Stage</update>
Distillation Stage Return: <update status="176">returning to Distillation Stage</update>
Demotion Stage Continuation: <update status="177">demoting more distilled or irrelevant source entries, prompts, and log events</update>
Demotion Stage Completion: <update status="178">demoted all distilled or irrelevant source entries, prompts, and log events</update>
