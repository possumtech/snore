## known:// — Track what you know

Written via `<set path="known://...">`. Knowns are facts and plans distilled from `visible` source entries.

Example: <set path="known://trivia/geography/capitals" summary="countries,france,capital,geography,trivia">
# Related
[trivia question](prompt://3)
[unknown resolving](unknown://countries/france/capital)
[source entry](trivia/capitals.csv)

# Capital of France

Paris.
</set>

* **YOU MUST ONLY populate known entries with `visible` source data, NOT from your own training or opinion.** Knowns are sourced facts.
* `summary="comma,separated,tags"` — folksonomic; tags are how you'll find the known later via `<get summary="..."/>`.
* Body convention: a `# Related` markdown link list pointing back to the prompts/unknowns/sources that justify the fact, then `# {Topic}` heading and the distilled content.

## Distillation cadence

The full pattern of resolving an unknown into a known:

	<get path="**" manifest>capital</get>
	<get path="prompt://3" line="1" limit="100"/>

	<set path="trivia/capitals.csv" visibility="visible"/>

	<set path="known://trivia/geography/capitals" summary="countries,france,capital,geography,trivia">
		# Related
		[trivia question](prompt://3)
		[unknown resolving](unknown://countries/france/capital)
		[source entry](trivia/capitals.csv)

		# Capital of France

		{ relevant information derived from the visible source entry }
	</set>

	<set path="prompt://3" visibility="summarized"/>
	<set path="unknown://countries/france/capital" summary="RESOLVED" visibility="summarized"/>
	<set path="trivia/capitals.csv" visibility="summarized"/>

	<update>distilled the capital of France into known entry; demoted the source</update>

* Check `tokens="N"` against `tokensFree="N"` before promoting source entries.
* Use `<get path="..." manifest/>` to list paths and their token amounts for bulk operations.
* Use `<get summary="..." manifest/>` to recall entries by summary tags when paths are forgotten.
* Use `<get path="..." line="X" limit="Y"/>` to read subsets of entries that would exceed your `tokensFree` budget.

## Lifecycle: visible → summarized

* Knowns can also serve as multi-turn workflow trackers (see the `known://plan` example in the system prompt — write a checklist, update it as you go).
* Demote knowns to summarized when they're no longer load-bearing for the deliverable. Prefer summarized over archived to avoid losing context you might need to recover.
