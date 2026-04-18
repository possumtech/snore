# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

> **Everything is an entry.** Unix's "everything is a file" principle
> applied to agent systems. Files, tool calls, streaming output, plans,
> unknowns, sub-agents — all entries. Read/write (`<get>`/`<set>`) is the
> universal grammar. New capabilities compose by producing entries in
> the shared substrate. See SPEC §0.1.

> **"Model behavior" is never an acceptable explanation for a test failure.**
> When a model misbehaves, the system failed — suboptimal context, poorly
> designed test conditions, insufficient reinforcement of correct behavior.
> Every failure is a system bug until proven otherwise.

> **Reference + feedback over broadcast.** Steer the model through
> three channels, in priority order: (1) tooldocs, at the decision
> point — the model reads setDoc when writing `<set>`; (2) error://
> entries, dynamic feedback when something goes wrong; (3) preamble,
> only for what's genuinely cross-cutting and unreachable from the
> other two (identity, per-turn tool cap, Token Budget invariant).
> Preamble is a broadcast channel that pays context every turn for
> behavior the other two channels shape more cheaply. If behavior
> regresses, the fix isn't "add it back to preamble" — it's "which
> tooldoc or error entry should have caught this?"

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).

11 model tools: think, get, set, env, sh, rm, cp, mv, ask_user, update,
search. Tool priority ordering (think first, search last). Unified tool
exclusion via `resolveForLoop(mode, flags)`. `known` and `unknown` retired
as emission tags (model uses `<set path="known://...">` and
`<set path="unknown://...">`); plugins remain for rendering and filters.

Three fidelity levels: full, summary, archive.

Token math: `ceil(text.length / RUMMY_TOKEN_DIVISOR)`. No tiktoken.
`known_entries.tokens` always stores full body cost. `turn_context.tokens`
stores actual context cost at current fidelity. Budget enforcement
measures assembled messages, never stored token sums.

### Dispatch

Tools dispatch as a sequential queue in the order the model emitted
them. No lifecycle/action split. No reordering.

- Each tool succeeds (200), fails (400+), or proposes (202)
- On failure: abort remaining tools
- On proposal: push `run/proposal` notification to client, await
  resolution inline, continue dispatch
- `ask`/`act` RPC response sent only when all tools complete
- Post-dispatch: budget check (independent of tool outcomes)
- Lifecycle: `<update status="200">` terminates, `<update status="102">` continues

### Budget

Ceiling = `floor(contextSize × RUMMY_BUDGET_CEILING)`. 10% headroom.

- **Turn Demotion** (post-dispatch): context exceeds ceiling → budget
  plugin demotes all entries from this turn, writes `budget://` entry
  with per-entry token costs and overflow amount
- **Prompt Demotion** (pre-LLM): new prompt doesn't fit → summarize
  prompt, model runs in headroom
- **LLM rejection**: turn-1 estimate drift → `isContextExceeded` catch
- Previous-loop entries: model-managed via preamble instruction

### Preamble Structure
```
Preamble (identity)
# Tool Commands (tool list)
# Tool Rules
  ## Response Rules
  ## Folksonomic Memory Management
  ## Fidelity Management
  ## Token Budget Management
  ## Response Termination
# Tool Usage (tooldocs)
```

### Plugin Ownership

Each tool plugin owns its own recording, dispatch, and view logic.
TurnExecutor orchestrates the pipeline; plugins handle specifics:

- `known` — size gate, slug path, dedup, scheme prefix
- `unknown` — dedup, slug path
- `update` — slug path recording, status attribute for lifecycle
- `budget` — enforce, postDispatch (Turn Demotion)
- `policy` — ask-mode restrictions via entry.recording filter
- `think` — gated by RUMMY_THINK, tooldoc registration

## Streaming Shell / Env (Design Sketch — v1)

Shell and env commands vary in duration by orders of magnitude (0.5s for
`git log` to 4 hours for benchmarks). The current synchronous-block model
freezes the client and the run for the command's entire duration. For
real daily-driver use, this is disqualifying. Applying Unix's
"everything is a file" principle: shell output is first-class data in
the folksonomy. Every command produces entries that live, grow, and
terminate. Short commands appear complete by next turn; long commands
stay at status 102 across many turns. The agent's interface is identical.

**Entry shape: log + data split, numeric channels**

Each command produces a **log entry** (event record) plus **data
entries** (output streams, one per channel):

```
sh://turn_N/{slug}     category=logging  status=200
                       body: "ran 'command', exit=0 (2.3s). Output: sh://turn_N/{slug}_1 (12kb), sh://turn_N/{slug}_2 (empty)"
                       attrs: { command, duration, exit_code }
                       (renders in <performed>)

sh://turn_N/{slug}_1   category=data     status=102→200/500
                       body: stdout stream
                       summary="{command}"  fidelity=demoted
                       (renders in <knowns>)

sh://turn_N/{slug}_2   category=data     status=102→200/500
                       body: stderr stream (empty if none)
                       summary="{command}"  fidelity=demoted
                       (renders in <knowns>)
```

**Channel numbering follows Unix file descriptor convention.**
Channel 1 is stdout, channel 2 is stderr; stdin (0) doesn't apply to
output entries. Producers that aren't process-shaped still map their
streams onto the same numeric space: `_1` for primary output, `_2`
for errors/anomalies, `_3`+ for additional streams. Mapping to FD
numbering gives shell users an immediately familiar convention and
generalizes cleanly for future producers.

**Rationale for the split:**

- The **log entry** answers "what actions happened on turn N?" — read
  by the model scanning history. Renders in `<performed>`. Small, cheap.
- The **data entries** answer "what did those actions produce?" — read
  only when the model cares about details. Render in `<knowns>`.
  Demoted by default, promoted selectively via `<get>`.

The log entry's body links to the data entries by path (e.g.
`"exit=0. Output: sh://.../_1 (12kb)"`), so discoverability is
preserved without a separate relation mechanism.

**Status lifecycle:**

- Log entry: created at status=200 when the user accepts the proposal
  (the action "happened"). Body updates on completion to include the
  exit code and durations.
- Data entries (_1, _2, ...): created at status=102 when the user
  accepts the proposal. Transition to 200 (exit_code=0) or 500
  (non-zero) on completion. 102 is HTTP "Processing" — existing
  paradigm fits.
- Proposal entry itself (the original `sh://turn_N/{slug}` at 202)
  transitions to 200 on accept → becomes the log entry.

**Protocol:**

- Generic stream RPC: `stream { run, path, channel, chunk }` — channel
  is a numeric id. Server appends chunk to `{path}_{channel}` via the
  new `append_entry_body` SQL prep. Any plugin producing a streaming
  entry uses this RPC.
- Completion RPC: `stream/completed { run, path, exit_code? }` — sets
  terminal status on all `{path}_{N}` entries (200 on exit_code=0, 500
  otherwise). Updates the log entry body with final stats. Producers
  whose completion isn't process-shaped (search, fetch) can omit
  exit_code and default to 200.

**Plugin ownership:**

- A dedicated `stream` plugin owns the generic `stream` and
  `stream/completed` RPC handlers. Writes to the shared substrate via
  `appendBody` and status transitions.
- `sh` and `env` plugins just create the proposal entry on dispatch
  and declare scheme ownership. The transition from 202 proposal to
  102 streaming happens in `AgentLoop.resolve()` (sh/env branch) or
  via a hook subscription from the stream plugin. They are consumers
  of the streaming substrate, not implementers.

**sh and env are one behavior under two schemes.** Policy differs (env
is safe/read-only; sh has side effects — different ask-mode
restrictions). The streaming mechanism is identical. Client can
distinguish in UI; the server treats them identically for streaming.

**Other decisions:**

- Concurrency: no wake-on-completion. Turns remain human-triggered.
  A command completing mid-idle queues the completion; next user
  prompt assembles context including the now-complete entry.
- Abort/cancel: two directions, symmetric outcome (both → 499).
  `stream/aborted` = client-initiated (client kills, then reports).
  `stream/cancel` = server-initiated (server transitions immediately,
  pushes `stream/cancelled` notification to connected clients).
  Also handles stale 102 cleanup when the originating client is gone.
- Connection fragility: no assumption of stable client connection.
  Chunks arrive when they arrive; if completion never signals (client
  died), entries sit at 102 forever — which is truthful. Any client
  can call `stream/cancel` to mark stale entries terminal.
- Backpressure: none in v1. SQLite handles writes. Model uses
  line/limit on `<get>` to tail without full promote.

**Out of scope (explicitly):**

- Client-side cancellation UX (keybinds, confirmation, etc. — client concern)
- Sub-agents, forks, swarms
- LLM-as-tool streaming reasoning
- File watches / observer tools
- Multi-agent collaboration protocols (future: emerges naturally from
  multiple agents sharing `data` category entries with separate
  `logging` — no special protocol needed)

**What the agent sees:**

```
Turn 1: <sh>npm run test:mab</sh>
  → proposal (202), user accepts, command starts

Turn 2 (command still running):
  <performed> shows:
    <sh path="sh://turn_1/npm_test_mab" turn="1" status="200" tokens="22">
    ran 'npm run test:mab' (in progress). Output: sh://turn_1/npm_test_mab_1, sh://turn_1/npm_test_mab_2
    </sh>
  <knowns> shows:
    <sh path="sh://turn_1/npm_test_mab_1" turn="1" status="102"
        summary="npm run test:mab" fidelity="demoted" tokens="847"/>

  Model reads: "still running, 847 tokens of output so far."
  Model can: <get path="sh://turn_1/npm_test_mab_1" line="800" limit="50"/>
  to tail recent output without promoting.

  Or continue unrelated work — agent isn't blocked.

Turn 7 (command completed):
  <performed>:
    <sh path="sh://turn_1/npm_test_mab" turn="1" status="200" tokens="58">
    ran 'npm run test:mab', exit=0 (4:23). Output: sh://turn_1/npm_test_mab_1 (12kb), sh://turn_1/npm_test_mab_2 (empty)
    </sh>
  <knowns>:
    <sh path="sh://turn_1/npm_test_mab_1" turn="1" status="200"
        summary="npm run test:mab" fidelity="demoted" tokens="12443"/>

  Model sees terminal state. Promotes data entry if interested.
```

**Generalization — streaming entries as a rummy idiom:**

Once the stream plugin exists, other tools that produce data over time
adopt the pattern: search results streaming in, web fetch of large
pages, log tails, file watches. Each creates a log entry plus N data
entries (numbered channels), appends via `stream` RPC, transitions to
200 on completion. The grammar stays uniform. The agent's mental
model stays simple: entries are data; some grow, some don't; status
tells you which; numbered channels tell you severity rank.

The core bet, extending "everything is an entry": **time becomes a
property of data, not a property of calling conventions.** Currently
most agent systems model "this is fast" vs "this is slow" implicitly
via sync/async API boundaries. Rummy makes duration a property: status
102 means "still producing," status 200/500 means "done." The
distinction is semantic data the model reads, not an API boundary the
system enforces. Parallel execution, cancellation, timeout — all
uniform operations on entries rather than per-tool machinery.

## Next: Modularization & Dead Code Review

### Goal

TurnExecutor is an orchestrator. It should dispatch to plugins via
hooks and receive results. It should not contain budget math, context
materialization, or recovery state machines. Every concern that has a
plugin home should live there.

### Phase 1: Plugin code out of TurnExecutor

**Principle:** TurnExecutor is an orchestrator. Its only jobs are turn
row creation, RummyContext skeleton, hook emission sequencing, and the
record+dispatch loop (sequential queue, abort cascade, proposal wait).
Every scheme-specific or lifecycle-specific decision belongs in the
plugin that owns it. Rough target: ~250 orchestration lines, down from
~730. Prior refactors stopped at "budget is big, move budget" — the
same rule applies to every plugin whose knowledge currently lives in
core.

**Tier 1 — DONE this session.**

Materialization extracted to `src/agent/materializeContext.js` — a
neutral module that TurnExecutor and the budget plugin both import.
(Not a new plugin; materialization is infrastructure, not scheme-owned.)

Budget plugin now owns Prompt Demotion and post-dispatch
re-materialization internally. TurnExecutor passes a `ctx` bag
`{runId, loopId, turn, systemPrompt, mode, toolSet, demoted, loopIteration}`
to `budget.enforce` / `budget.postDispatch`; plugin re-materializes via
`core.db` + `core.entries` when it needs fresh numbers.

**Design decision:** `budget.enforce`/`budget.postDispatch` stay as
direct method calls on `core.hooks.budget`, not filter hooks. The
existing namespace works and formalizing as pub/sub filters would be
overhead for marginal benefit (only one subscriber ever).

Scheme classification (ACTION/MUTATION/READ_SCHEMES,
actionCalls/writeCalls/unknownCalls, hasAct/hasReads/hasWrites) deleted
outright — not replaced with plugin-declared classification.

**ResponseHealer simplified** (folded in since classification removal
gutted its API):
- Fingerprint is now `tag + sortedAttrs`. No body, no target
  normalization, no theory of mind about what tools do.
- `cmdPaths`, `#pathRuns`, path-stagnation detection removed. Cycle
  detection alone catches the same patterns a few turns later.
- `assessRepetition(recorded)` takes the raw array.
- `assessProgress` takes `recorded` and derives "did the turn do
  non-update work?" as `recorded.some(e => e.scheme !== "update")`.
  One scheme special-cased; update is the status-reporting channel,
  everything else is work.

**Tier 2 — mostly done this session.**

- [x] `instructions://system` projection → `instructions` plugin
  exposes `hooks.instructions.resolveSystemPrompt(runId)`; TurnExecutor
  calls it in one line.
- [x] `<update>` lifecycle (status classification, 200-with-errors
  override, missing-status error, healer fallback) → `Update.resolve()`
  exposed via `hooks.update.resolve({recorded, hasErrors, content,
  commands, runId, turn, loopId})`. Returns
  `{summaryText, updateText, statusHealed}`.
- [ ] `<think>` tag → `reasoning_content` merge (lines remaining in
  TurnExecutor) — DEFERRED. Moving it cleanly needs new filter-hook
  plumbing for ~10 lines of output-field cleanup that aren't really
  scheme-behavior. Revisit if another reason arises.

**Tier 3 remaining:**

- [ ] Incremental `run.state` push after each dispatch: plausibly a
  `state` plugin concern, but currently tightly coupled to the dispatch
  loop's waterfall semantics. Leave for now.

LLM retry and context-exceeded detection now live in LlmProvider;
context-exceeded surfaces as `ContextExceededError` (src/llm/errors.js)
so TurnExecutor catches by type rather than regex-matching messages.

**Exit criterion:** TurnExecutor imports neither budget, instructions,
think, update, nor scheme classification tables. What remains is hook
emission and sequential queue mechanics. Current: 441 lines (from 730
at Phase 2 start — 40% reduction).

### Phase 2: Schema V2 — content/view split

Plan in `SCHEMA_V2.md`. Phases B and C landed:

- **Phase B (Repository surface)**: plugins no longer touch `core.db.*`
  for entry/run/turn-stats ops; five new semantic methods on KnownStore
  (`forkEntries`, `getUnknowns`, `demoteTurnEntries`, `getRun`,
  `updateTurnStats`). Abstraction layer is the buffer against future
  schema churn.
- **Phase C (schema split)**: `entries` (content, `(scope, path)`
  unique) + `run_views` (per-run projection with fidelity/status/turn)
  now the storage. `known_entries` reborn as a compat VIEW for reads;
  writes target the real tables. `v_model_context` / `v_unresolved`
  rewritten. ~20 preps in `known_store.sql` rewritten with subquery
  patterns (SQLite's `UPDATE...FROM` with target alias didn't carry
  cleanly). `KnownStore.upsert`, `resolve`, `updateBodyByPattern`,
  `demoteTurnEntries` each multi-prep flows. Fork is now cheap —
  view rows only, no body copies. All 418 tests (246 unit + 172
  integration) pass. Currently: all entries land at `scope=run:${runId}`
  — Phase D turns scope into a first-class plugin-declared concept.

**Phase D landed.** Scope + permissions mechanism in place:

- `schemes` table gains `default_scope` (`run` | `project` | `global`)
  and `writable_by` (JSON array of `model` | `plugin` | `system`).
- `registerScheme({ scope, writableBy })` on PluginContext, validated.
- `KnownStore.upsert(..., { writer })` resolves scope via scheme lookup
  and enforces `writer ∈ writable_by` (throws `403: writer "X" not
  permitted for scheme "Y"` on violation).
- `RummyContext.writer` carries writer identity for handlers (defaults
  to `'model'`).
- Audit schemes declared `writable_by=['system']`; prompt scheme
  declared `writable_by=['plugin']`; other schemes stay
  `['model', 'plugin']` (permissive, matches pre-D behavior).
- Telemetry plugin explicitly passes `writer: 'system'` for audit
  writes.
- Lazy scheme loading in KnownStore — loads on first permission check,
  so ad-hoc `new KnownStore(db)` (common in tests) works transparently.

Verified end-to-end by `test/integration/scope_permissions.test.js`:
permissive schemes accept both `model` and `plugin`; audit schemes
reject non-`system` writers; prompt scheme rejects `model` writer;
entries land at `scope=run:${runId}`.

**Policy plugin — decision to keep as-is.** The original plan item
envisioned reframing policy as a writer-capability narrowing on top
of `writable_by`. That doesn't fit: policy's ask-mode rejections are
path-content-dependent (reject `<set>` only when the target is a file;
reject `<rm>` only when the path is a file; etc.) — they require
inspecting entry attributes, not just the scheme name. Static
`writable_by` lists can't express that. Policy stays as an
`entry.recording` filter; its rejections already emit `error://` via
the shared mechanism, so it coexists cleanly with the permission system.

**Handler writer plumbing — partial.** Fixed the three known latent
bugs where non-handler plugin code writes restrictive schemes
(instructions → `writer: "system"`, prompt + AgentLoop.inject →
`writer: "plugin"`, telemetry audit writes → `writer: "system"`).
Tool handlers (`set`, `rm`, etc.) still default to `'plugin'` via
KnownStore's default; fine today because all model-facing schemes are
permissive. When a restrictive scheme lands that needs to distinguish
model-originated writes from plugin-originated writes, handlers will
plumb `writer: rummy.writer` through.

**`'project'` scope resolution** falls back to `run:${runId}`
(projectId isn't plumbed to Repository yet). Add when the first
project-scoped scheme lands.

COALESCE(scheme, 'file') cleanup still deferred — orthogonal.

## Hardening Roadmap

Transitioning from adapting the service to iteratively hardening it.
Six phases, roughly sequential:

1. **Spec-Driven Integration/E2E** — walk SPEC.md + PLUGINS.md
   numbered-section by numbered-section; audit each claim for truth,
   staleness, or vestigiality; rewrite or delete; write the tests that
   enforce remaining claims. Catches "minor issues" en route (compat-
   VIEW read-only assertion, error-type consistency, dead plugin-dep
   system, etc.) because each surfaces when you try to test its claim.
2. **Documentation Meta-Review** — broader doc audit (CLIENT_CHANGES,
   FIDELITY_CONTRACT, READMEs, plugin docs). Staleness sweep.
3. **Linting** — code hygiene pass. Unused imports, dead code,
   formatting, naming consistency.
4. **Demo Drills** — real end-to-end use cases exercised. Validates
   the system works for the workflows it claims to support.
5. **MAB Budget Drills** — MemoryAgentBench runs focused on budget
   behavior under real load.
6. **LME Performance Drills** — LME benchmark runs; memory/recall
   performance validation.

Currently in Phase 1.

### Phase 3: E2E reliability (superseded by Hardening Roadmap)

- [ ] All 26+ E2E tests pass consistently
- [ ] Each failure investigated to root cause
- [ ] Persona/fork timeout investigated (120s on trivial question)

## Infrastructure

- **Plugin load dependency.** Loader refactored into collect-then-
  topo-sort-then-instantiate (see `src/plugins/index.js`). Plugins can
  declare `static dependsOn = ["other-plugin"]` on their default export
  class; loader orders accordingly and fails loudly on missing deps or
  cycles. No current plugin declares dependencies — the mechanism is
  in place for external plugins / MCP / sub-agent plugins.
- **Client protocol version.** `src/server/protocol.js` exports
  `RUMMY_PROTOCOL_VERSION` (currently `"1.0.0"`). Server sends
  `rummy/hello` notification with `{ rummyVersion }` on client connect.
  Clients SHOULD check MAJOR and refuse to operate on mismatch.
  Bump MAJOR when RPC shapes break; MINOR for additive changes.
- **LLM provider protocol.** `hooks.llm.providers` is a registry of
  `{ name, matches, completion, getContextSize }` entries. Each
  provider owns a path-segment-prefix namespace (`openai/`, `ollama/`,
  `xai/`, `openrouter/`); the first segment picks the provider, the
  rest is the provider-internal model identifier passed through
  verbatim. N-level aliases (`openrouter/xai/grok-beta`) fall out
  naturally. Vendor-specific HTTP is owned by plugins under
  `src/plugins/{openai,ollama,xai,openrouter}/` — adding a new vendor
  is a new plugin, not a patch to core. `LlmProvider` (src/llm/)
  thinned to DB model-alias resolution + retry + registry dispatch;
  old per-vendor client classes retired. External plugins (anthropic,
  google, etc.) can drop in without core changes.

## Road to Production

### Client handoff
- [ ] CLIENT_CHANGES.md delivered to rummy.nvim team
- [ ] rummy.web published with all session changes
- [ ] rummy.nvim updated for new contract

### Benchmark validation
- [ ] MAB CR full split with current preamble
- [ ] LME oracle split with updated system.md
- [ ] Compare against pre-session baselines

## Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

## Ongoing Development Checklist

- [ ] Perform gemma/mab benchmark run

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

> I wish to perform a short run of gemma/mab to see if we have any benchmark regressions after our long session that's been focused on improving the agent in project/development workflows.

