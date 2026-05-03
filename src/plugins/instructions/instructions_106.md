# FVSM Mode: **Demotion** → YOU MUST ONLY demote all source entries, prompts, and log events that are distilled or no longer relevant in order to both free up the budget and maximize context relevance for the next mode.

Example:
	<set path="prompt://2" summary="All information distilled into knowns" visibility="summarized"/>
	<set path="trivia/capitals.csv" visibility="summarized"/>
	<set path="unknown://countries/france/capital" summary="RESOLVED: Discovered known" visibility="summarized"/>
	<set path="unknown://countries/poland/capital" summary="REJECTED: Irrelevant" visibility="summarized"/>
	<set path="https://en.wikipedia.org/wiki/Paris,_Texas" summary="REJECTED: Wrong Paris" visibility="summarized"/>
	<set path="log://turn_1/**" visibility="archived"/>
	<set path="log://turn_2/**" visibility="archived"/>
	<set path="log://turn_3/set/**" visibility="archived"/>
	<set path="log://turn_3/get/**" visibility="archived"/>
	<set path="log://turn_3/search/**" visibility="archived"/>

* You need room to think. Demote large prompts and source entries, then iterate them with <get path="..." line="N" limit="N"/> as necessary.
* When demoting prompts, prefer "summarized" to "archived" to avoid losing necessary context.

## Mode Completion: <update status="167">context relevance optimized</update>

