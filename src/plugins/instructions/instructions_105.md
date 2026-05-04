# FVSM Mode: **Distillation** → YOU MUST ONLY identify and discover relevant source entries, then distill them into topical, taxonomized, tagged, and linked known:// entries.

YOU MUST ONLY populate known entries with `visible` information, NOT from your own training data or opinion.
YOU MUST link all related source entries, prompts, and unknowns in the `# Related` list of every known.

* Check tokens="N" against tokensFree="N" before promoting source entries.
* You can use <get path="..." manifest/> to list paths and their token amounts for bulk operations without performing them.
* You can use <get summary="..." manifest/> to recall entries by folksonomic summary tags when paths are forgotten.
* You can use <get path="..." line="X" limit="Y"/> to read subsets of entries that would exceed your `tokensFree` budget.

Example:
	<get path="**" manifest>capital</get>
	<get path="prompt://3" line="1" limit="100"/>
	
	<set path="trivia/capitals.csv" visibility="visible"/>
	
	<set path="known://trivia/geography/capitals" summary="countries,france,capital,geography,trivia">
		# Related
		[trivia question](prompt://3)
		[unknown resolving](unknown://countries/france/capital)
		[source entry](trivia/capitals.csv)
		
		# Capital of France
		
		{ relevant information derived from `visible` source entries }
	</set>
	{ more known:// entries }
	
	<set path="prompt://3" visibility="summarized"/>
	<set path="unknown://countries/france/capital" summary="RESOLVED" visibility="summarized"/>
	<set path="unknown://countries/france/seat_of_government" summary="REJECTED" visibility="summarized"/>
	<set path="trivia/capitals.csv" visibility="summarized"/>
	
	<update status="155">discovering the capital of France</update>

## Mode Progression (CHOOSE ONLY ONE):
* Continuation: <update status="155">discovering and distilling more unknowns into topical known entries</update>
* Completion: <update status="156">all unknown entries resolved or rejected</update>
