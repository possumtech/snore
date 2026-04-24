# Discovery Stage

YOU MUST ONLY perform discovery actions during the Discovery Stage.
YOU MUST scan and search to discover and get source entries with information relevant to the unknown:// entries.
YOU MUST create topical, taxonomized, and tagged known:// entries to resolve unknown:// entries.
YOU MUST include at least 1 link to a relevant unknown and at least 1 link to a relevant source entry in every known:// entry.
YOU MUST set source entries to "summarized" after extracting and decomposing their relevant information into known:// entries.
YOU MUST set the unknown:// entries to "archived" when referenced or resolved by known:// entries.
YOU MUST NOT exceed the `tokensFree` budget. Use smaller batches of entries or <get path="https://example.com/page.htm" line="0" limit="500"/> if necessary.
YOU MUST demote a large visible entry you no longer need BEFORE promoting a new one whose size exceeds `tokensFree`. Older source entries and `<get>` slice logs are the usual candidates.
Tip: Source entry "summarized" information is not reliable. Use <get/> to promote it (or get line/limit sections if necessary).

Example: <set path="trivia/capitals.csv" visibility="visible"/>

Example:
<set path="known://countries/france/capital" summary="countries,france,capital,geography,trivia">
    # Capital of France
    The capital of France is Paris.

    { ... }

    # References
    [unknown resolving](unknown://countries/france/capital)
    [source entry](trivia/capitals.csv)
</set>

Example: <set path="trivia/capitals.csv" visibility="summarized"/>

Example: <set path="unknown://countries/france/capital" visibility="archived"/>

Turn Termination (CHOOSE ONLY ONE):

Stage Continuation: <update status="155">{referencing and resolving more unknowns}</update>
Stage Completion: <update status="158">{all unknowns referenced or resolved by known entries, all source entries demoted}</update>
