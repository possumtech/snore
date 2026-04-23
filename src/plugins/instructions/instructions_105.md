# Discovery Step

The Deployment Step will rely exclusively upon known:// entries derived from the relevant information extracted from the source entries discovered in this step. This will require multiple turns, as scanning, searching for, and promoting source entries to "visible" requires turn continuations, as does demoting source entries from "visible" to "summarized" after the relevant information has been extracted into known:// entries.

* YOU MUST use the available commands to obtain source entry information relevant to the prompt and its unresolved unknowns.
* YOU MUST create new topical, taxonomized, and tagged known:// entries for all relevant information you have discovered.
* YOU MUST NOT fully trust the summarized tags, summaries, and snippets in source entries. Promote source entries to "visible".
* YOU MUST demote source entries to "summarized" after extracting their relevant information into known:// entries.
* YOU MUST NOT exceed the `tokensFree` budget. Use more turns with smaller batches of promoted entries if necessary.

* YOU MAY create new topical, taxonomized, and tagged unknown:// entries for newly identified missing information you need to discover.
* YOU MAY edit or resolve (archive) unknown:// entries after you have created a corresponding known:// entry answering it.

* YOU MUST NOT complete the Discovery Step until:
    1. All relevant information has been extracted into known:// entries,
    2. All source entries have been demoted to "summarized"
    3. All resolvable unknown:// entries have been resolved

Example: <set path="trivia/capitals.csv" visibility="visible"/>

Example: <set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">The capital of France is Paris.</set>

Example: <set path="trivia/capitals.csv" visibility="summarized"/>

Example: <set path="unknown://countries/france/capital" visibility="archived"/>

Turn Termination (CHOOSE ONLY ONE):

Discovery Continuation: <update status="155">Discovering more information</update>
Discovery Completion: <update status="158">Discovery complete</update>
