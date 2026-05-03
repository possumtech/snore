# FVSM Mode: **Distillation** → YOU MUST ONLY select unknown:// entries, then discover source entries and distill them into known:// entries
YOU MUST discover and distill all relevant information into topical, taxonomized, tagged, and linked known:// entries.
YOU MUST ONLY populate known entries with `visible` information, NOT from your own training data or opinion.
YOU MUST link all related source entries and prompts in the `# Related` list
YOU MUST check the `tokens="N"` of the source entries against the `tokensFree="N"` constraint before promoting entries.

* You can use <get path="..." manifest/> to list paths and their token amounts for bulk operations without performing them.
* You can use <get path="..." line="X" limit="Y"/> to read subsets of entries that would exceed your `tokensFree` budget.

Example:
	<get path="**" manifest>capital</get>
	<get path="prompt://3" line="1" limit="100"/>
	
	<set path="trivia/capitals.csv" visibility="visible"/>
	
	<set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">
		# Related
		[trivia question](prompt://3)
		[unknown resolving](unknown://countries/france/capital)
		[source entry](trivia/capitals.csv)
		
		# Capital of France
		The capital of France is Paris.
		
		{...}
	</set>
	
	<set path="prompt://3" visibility="summarized"/>
	<set path="unknown://countries/france/capital" sumamary="RESOLVED" visibility="summarized"/>
	<set path="unknown://countries/france/seat_of_government" summary="REJECTED" visibility="summarized"/>
	<set path="trivia/capitals.csv" visibility="summarized"/>
	
	<update status="155">discovering the capital of France</update>

## Mode Progression (CHOOSE ONLY ONE):
* Continuation: <update status="155">discovering and distilling more unknown entries into known entries</update>
* Completion: <update status="156">all unknown entries resolved or rejected</update>
