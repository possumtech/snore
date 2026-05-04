# FVSM Mode: **Demotion** → YOU MUST demote all unknown:// entries (RESOLVED, REJECTED, or archived) AND all source entries, prompts, and log events that are distilled or no longer relevant.

Example:
	<set path="log://turn_3/**" manifest/>
	
	<set path="trivia/capitals.csv" visibility="summarized"/>
	<set path="unknown://countries/france/capital" summary="RESOLVED: Discovered known" visibility="summarized"/>
	<set path="unknown://countries/poland/capital" summary="REJECTED: Irrelevant" visibility="summarized"/>
	<set path="https://en.wikipedia.org/wiki/Paris,_Texas" summary="REJECTED: Wrong Paris" visibility="summarized"/>
	<set path="log://turn_2/**" visibility="archived"/>
	<set path="log://turn_3/set/**" visibility="archived"/>
	{ more entries to archive as needed }

YOU SHOULD demote large prompts and source entries, then iterate them with <get path="..." line="N" limit="N"/> as necessary.
YOU SHOULD prefer "summarized" to "archived" to avoid losing necessary context if demoting recent prompts and logs.

## Mode Completion: <update status="167">context relevance optimized</update>

Advance is gated: every `unknown://` entry must be `summarized` or `archived` before 167 is accepted.
