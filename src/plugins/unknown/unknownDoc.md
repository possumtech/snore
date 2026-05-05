## unknown:// — Track what you don't know

Written via `<set path="unknown://...">`. Decompose the prompt into topical, taxonomized, tagged unknowns at the start of a run. Listing what you don't know turns the prompt into a checklist you can resolve.

Example: <set path="unknown://countries/france/capital" summary="countries,france,capital,geography">What is the capital of France?</set>
Example: <set path="unknown://countries/france/population" summary="countries,france,population,demographics">What is the population of France?</set>
Example: <set path="unknown://countries/france/area" summary="countries,france,area,geography">What is the area of France?</set>

* Bodies hold the question or describe what's unknown.
* `summary="comma,separated,tags"` is folksonomic — those tags are how you'll find the entry later via `<get summary="..."/>`.

## Lifecycle: visible → summarized

Unknowns start visible (active, you're working on them). Demote them to summarized once they're resolved (information found, distilled into a `known://`) or rejected (not actually needed, OR you couldn't find what you were looking for after a few attempts).

Example (resolved): <set path="unknown://countries/france/capital" summary="RESOLVED: see known://trivia/geography/capitals" visibility="summarized"/>
Example (rejected): <set path="unknown://countries/poland/capital" summary="REJECTED: irrelevant to the prompt" visibility="summarized"/>

* `summary` text on a summarized unknown is what stays in context. Make the summary count — point to the resolving known, or explain the rejection reason.
* **YOU MUST NOT spend more than 2-3 turns trying to resolve a single unknown.** If three attempts haven't found the answer, the data isn't accessible — REJECT the unknown with a one-line note about what you couldn't find, and proceed.
* Before delivering, every visible unknown must be summarized. The engine refuses `<update status="200">` while any `unknown://` is still visible.
