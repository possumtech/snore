# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
No monolithic assembler. Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).
9 model tools (store removed — fidelity control via set attributes).
Budget enforcement demotes oldest full entries to summary when context
exceeds 95% of the model's window. Token estimation via tiktoken * 2x
multiplier for cross-model safety. Glob matching via picomatch.
160 unit + 92 integration passing. 12/13 e2e (unknown investigation
flaky — model sends ask_user instead of investigating). Live tests
need rerun.

## Todo: Budget Cascade — Context Guarantee

The budget engine must guarantee that materialized context never exceeds the
model's context window. Context overflow is structurally impossible.

### Floor

The irreducible minimum context. Validated at run creation — if the model's
context can't hold the floor, reject the run before the first turn.

Floor = system prompt + tool docs + stash entries (one per scheme with stored
content) + user prompt (`<ask>`/`<act>` tag) + progress block.

### Cascade

Each tier is a deterministic transformation that strictly reduces token count.
Within each tier, demotion proceeds by **iterative halving** — demote the
oldest half of eligible entries, re-render and re-measure. If still over
budget, demote the oldest half of what remains. Repeat until the tier's
budget target is met or no eligible entries remain, then advance to the
next tier.

Halving preserves the most recent entries at the highest fidelity. In
conflict-resolution scenarios, later entries are authoritative — the model
keeps the facts most likely to be correct.

Demotion priority within each tier: prompts/results/structural first
(tier 0), then files (tier 1), then knowns (tier 2), then unknowns
(tier 3). Within each priority, oldest entries demote first.

**Tier 1: Full → summary (halving spiral).**
1. Sort eligible full entries by demotion priority (oldest first).
2. Demote the oldest half to summary. Re-render, re-measure.
3. Still over? Demote the oldest half of remaining full entries. Re-render.
4. Repeat until budget met or no full entries remain.

For files, summary = symbols + contextual description.
For known entries, summary = path visible, body hidden. The fact is still
retrievable via `<get>` but not on the desk.

**Tier 2: Summary → index (halving spiral).**
1. Sort eligible summary entries by demotion priority (oldest first).
2. Demote the oldest half to index (bare path, ~5 tokens). Re-render.
3. Still over? Demote the oldest half of remaining summaries. Re-render.
4. Repeat until budget met or no summary entries remain.

**Tier 3: Index → stash (halving spiral).**
1. Sort eligible index entries by demotion priority (oldest first).
2. Stash the oldest half — move to stored, create per-scheme stash entry
   at index fidelity containing the full URI list. Re-render.
3. Still over? Stash the oldest half of remaining index entries. Re-render.
4. Repeat until budget met or no index entries remain.

Stash entries are created at **index fidelity** — the model sees
`known://stash_file`, `known://stash_known` as path labels. To see
the contents (the list of stashed URIs), the model promotes the stash
to full with `<get path="known://stash_known"/>`.

The stash body must include every URI of every stashed entry for that
scheme. If the model cannot see the stash, those entries are orphaned.

**Tier 4: Hard error.** Floor + stashes don't fit. Configuration error —
the model's context window is too small to operate. Reject at run creation.

### 413 Budget Gate

Before the cascade runs, entry recording checks remaining budget headroom.
Any entry whose body would exceed remaining context budget is rejected with
HTTP 413 and a feedback message: "Context budget exceeded (X tokens, Y
remaining)." The model sees the rejection on the next turn and can adapt
by filing old entries with `<set stored/>` or removing them with `<rm>`.

The 413 gate prevents unbounded growth during a turn. The cascade handles
aggregate overflow after all entries are recorded and dispatched.

### Implementation

1. Materialize all candidates from `v_model_context`
2. Render full message through assembly filter chain
3. Measure assembled tokens via `countTokens()` on final strings
4. If over budget: begin tier 1 halving spiral
5. If still over after tier 1 exhausted: begin tier 2 halving spiral
6. If still over after tier 2 exhausted: begin tier 3 halving spiral
7. If still over after tier 3 exhausted: hard error
8. Never subtract estimated savings — always re-render and re-measure

The re-render is cheap (string concatenation). The LLM call is expensive.
Multiple re-renders to guarantee no wasted 500 error is the correct tradeoff.

### Token Accounting

Single source of truth: `countTokens()` on the final assembled message
strings. No estimates, no per-entry overhead calculations, no disconnect
between what's measured and what's sent. The assembled message IS the
measurement.

Entry-level `tokens` column in `known_entries` and `turn_context` used
only for demotion candidate estimation (which entries to batch-demote).
Never used as the authority on whether the budget is met.

---

## Todo: Proposal Lifecycle — Remaining Work

Sequential dispatch implemented: commands execute one at a time.
On 202 (proposed) or >= 400 (error), remaining commands abort with
409 and context message. Get handler returns 413 when files would
exceed context budget.

Remaining:
- [ ] Integration test for sequential abort behavior
- [ ] E2E test: model sends rm + summarize, rm rejected, verify
  model sees rejection + aborted summarize on next turn

## Todo: Repetition Detection — Get Handler Dedup

When the model sends `<get path="lua/*.lua">` AND individual
`<get>lua/init.lua</get>` in the same response, files promote
twice. The overhead is minimal (promotion is idempotent) but
receipt entries accumulate. Low priority.





## Todo: Test Improvements

- [x] E2E test diagnostic DBs persist to /tmp/rummy_test_diag/
- [x] Integration test for scheme registration via plugins (8 tests)
- [x] Ask mode restrictions (already covered in mode_enforcement.test.js)
- [x] Sed chaining (already covered in XmlParser.test.js)
- [ ] Fix set handler integration tests (path normalization mismatch
  between test setup `set://src%2F...` and handler's `set://src/...`)
- [ ] Live tests need rerun for HTTP status code migration

## Done: Session 2026-04-06/07 (continued)

- **`<store>` tool removed**: Fidelity control via `<set>` attributes:
  `stored`, `summary`, `index`, `full`. Direct-to-storage writes:
  `<set path="..." stored>content</set>`. 10 tools → 9.
- **`summary="..."` attribute**: Model-authored descriptions (<= 80 chars)
  persist across fidelity changes. Rendered as header in all views:
  `# <set summary="..."/>`. Falls back in ToolRegistry when no summary
  view is registered. The model describes files as it reads them —
  no janitorial pass needed.
- **Tool tags in previous/current**: Results render as `<set path="...">`
  not `<tool path="set://...">`. The history teaches the invocation syntax.
- **Native tool call normalization**: Qwen, OpenAI, Anthropic, Mistral
  formats silently translated to rummy XML in XmlParser.
- **Skill plugin**: Class renamed `Skill`, turn 0 for init-time writes.
  Persona extracted to own plugin (`persona/persona.js`).
- **XmlParser → Hedberg**: JSON edit parsing moved to `hedberg/normalize.js`.
- **Repetition detection**: Update text fingerprinting (same 3 turns =
  force-complete). Known entry dedup (80-char prefix match reuses path).
- **File scheme documented**: NULL scheme exception explained in file.js.
- **Scheme registration**: All tool plugins register. Audit schemes bootstrapped.
- **URI length cap**: 2048 chars max on known_entries.path.

## Done: Session 2026-04-06/07

- **Loops table**: projects > runs > loops > turns. Replaced prompt_queue.
  Summary/rejection checks scoped to current loop.
- **HTTP status codes**: `state TEXT` → `status INTEGER` + `fidelity TEXT`.
  Runs, loops, entries, client RPC — all integer codes. Schemes table
  simplified (no valid_states, no fidelity column). External plugins
  and rummy.nvim client migrated.
- **Budget enforcement**: Post-assembly token check demotes oldest full
  entries to summary. Token estimation via tiktoken * 2x multiplier.
  Progress section warns model. `<known ... demoted>` flag per-turn.
  Runtime context from llama.cpp `/props` endpoint.
- **Glob matching**: picomatch replaces hand-rolled globToRegex. Proper
  `**` recursive matching. Single `*` respects directory boundaries.
- **XmlParser recovery**: Known tool opening while another is current
  closes the old one. Mismatched close tags don't swallow commands.
- **Plugin loader**: Global package resolution for RUMMY_PLUGIN_* env
  vars. Local then global — no fallback, explicit error.
- **Phantom tool cleanup**: `ensureTool` only from `on("handler")`.
  File plugin no longer appears in model tool list.
- **Error feedback**: Get, set, rm return labeled errors on missing
  path (400). Rm returns 404 on no match. Path normalization for
  unencoded URIs.
- **Tool docs distributed**: Advanced patterns section removed from
  hedberg. Each tool's docs show globs, preview, body filters inline.
- **Known docs**: "entries are your memory — you forget everything else"
- **Unknowns show paths**: `<unknown path="...">` so model can rm by URI.
- **Env docs**: "Do not use env to read or list files — use get path=* preview"
- **Previous loop context**: Prompts from previous loops shown in
  `<previous>`. Assembly uses entry's own fidelity, not hardcoded.
- **File.activate promotion**: Immediately promotes matching entries,
  symmetric with File.ignore demote.
- **getEntries fidelity**: Server response includes fidelity field.
  Client uses fidelity for buffer visibility marking.
- **Set docs**: "literal SEARCH/REPLACE blocks", better error messages.
- **Rm docs**: `known://donald-rumsfeld-was-born-in-1932` example.
- **Env handler**: 202 (proposed) instead of 200 (immediate).
- **Context tokens telemetry**: Per-turn context_tokens in run/state
  for accurate statusline display.
- **rummy.nvim audit**: Status codes migrated, getEntries fidelity
  mapping, uppercase in run/rename, turn_tokens for statusline.

## Done: Earlier Sessions

- Plugin architecture refactor (18 plugins, constructor(core) pattern)
- xAI integration (Responses API)
- Hedberg plugin (patterns, matcher, sed, edits, normalize)
- Packet restructuring (system/user split, assembly filters)
- Cleanup (removed defaults, fallbacks, legacy code)

## Deferred

- Relevance engine (stochastic, separate project/plugin)
- Hedberg extraction to `@possumtech/rummy.hedberg` npm package
- Janitor plugin (deterministic context budget management)
- Bulk operation aggregation (one entry per pattern operation)
- Non-git file scanner fallback
- Separate state from fidelity (already done via HTTP codes — the
  original concern about conflation is resolved. Fidelity is its own
  column, status is HTTP codes, schemes don't constrain fidelity.)
