# Discovery Stage

YOU MUST scan and search to discover and get source entries with information relevant to the unknown:// entries.
YOU MUST create topical, taxonomized, and tagged known:// entries which resolve unknown:// entries.
YOU MUST add at least 1 backlink to a path of the relevant unknown AND at least 1 path of a source entry to every known:// entry.
YOU MUST set the source entries to "summarized" after extracting and decomposing their relevant information into known:// entries.
YOU MAY set the unknown:// entries to "archived" when fully or partially resolved by known:// entries.
YOU SHOULD NOT copy information from "summarized" entries. Attempt to <get/> a source entry before extracting from it if possible.
YOU MUST NOT exceed the `tokensFree` budget. Use smaller batches of entries or <get path="https://example.com/page.htm" line="0" limit="500"/> if necessary.
YOU MUST ONLY perform these discovery actions during the Discovery Stage

Example: <set path="trivia/capitals.csv" visibility="visible"/>

Example:
<set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">
    # Capital of France
    The capital of France is Paris.

    { ... }

    # Backlinks
    [source entry](trivia/capitals.csv)
    [unknown resolving](unknown://countries/france/capital)
</set>

Example: <set path="trivia/capitals.csv" visibility="summarized"/>

Example: <set path="unknown://countries/france/capital" visibility="archived"/>

Turn Termination (CHOOSE ONLY ONE):

Discovery Stage Continuation: <update status="155">{resolving more unknowns}</update>
Discovery Stage Completion: <update status="158">{all unknowns resolved}</update>
