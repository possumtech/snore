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

## Current State

Plugin-driven architecture. Instantiated classes, constructor receives
`core` (PluginContext). Registration via `core.on()` / `core.filter()`.
Assembly via `assembly.system` / `assembly.user` filter chains.
Loops table (projects > runs > loops > turns).
HTTP status codes throughout (entries, runs, loops, client RPC).

14 model tools: think, unknown, known, get, set, env, sh, rm, cp, mv,
ask_user, update, summarize, search. Tool priority ordering (think first,
search last). Unified tool exclusion via `resolveForLoop(mode, flags)`.

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
- Lifecycle: last summarize/update wins

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
- `summarize` / `update` — slug path recording
- `budget` — enforce, postDispatch (Turn Demotion)
- `policy` — ask-mode restrictions via entry.recording filter
- `think` — gated by RUMMY_THINK, tooldoc registration

## Paradigmatic Refactor: Status vs Lifecycle (Precedes Streaming)

**The confusion:** `known_entries.status` is currently used for two
distinct concerns — the HTTP outcome of the last body operation AND the
entry's lifecycle phase. Turn Demotion flips status to 413 on demoted
entries, overwriting their real outcome with a lifecycle event. We've
been papering this over with scheme-specific preservation exceptions
(set/rm/mv/cp keep 200 through budget panic). Adding 102 streaming
entries would require yet another exception. The exception list is a
symptom, not a pattern.

**The fix:** `status` reflects body operation outcome only. Lifecycle
events (budget demotion, archive, supersede) change `fidelity` but
never `status`. The model reads status for truth about the operation
and fidelity for visibility — two orthogonal signals, legible separately.

**Scope (minimum viable):**

- `demote_turn_entries` SQL: only changes `fidelity` and `updated_at`.
  Drop the scheme-specific status-preservation CASE — it becomes the
  default for everything.
- `budget/budget.js` post-dispatch: drop the get-result body rewrite
  that forces status=413. The get-result entry's original outcome
  (status=200, body "X promoted (N tokens)") stays truthful; fidelity
  demoted signals it's no longer in context. The budget:// entry is
  the canonical panic record.
- Tests: `test/integration/budget_demotion.test.js` — update assertions
  to expect preserved status (200 stays 200 after demotion).
- Diff estimate: ~25 lines source + ~15 lines test. Clear cuts, no new
  columns, no migration.

**What we lose:** the "which entries were demoted by this turn's panic?"
question becomes "which entries have fidelity=demoted AND were written
on turn N?" instead of "which entries have status=413 AND turn=N." The
budget:// entry already records the event authoritatively; per-entry
status=413 was redundant signal.

**What we gain:** streaming entries at status=102 pass through budget
demotion without needing a special case. Future lifecycle events (sub-
agent spawn, file watch start, whatever) don't accrete new status-
preservation exceptions. The data model matches reality: operation
outcome and lifecycle phase are different facts.

This refactor lands first, then streaming builds on the cleaner base.

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
- Abort: use the existing run/loop abort mechanism — no new
  cancellation protocol.
- Connection fragility: no assumption of stable client connection.
  Chunks arrive when they arrive; if completion never signals (client
  died), entries sit at 102 forever — which is truthful. Later users
  see stale 102 entries and can clean them up.
- Backpressure: none in v1. SQLite handles writes. Model uses
  line/limit on `<get>` to tail without full promote.

**Out of scope (explicitly):**

- Cancellation UI
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
    ran 'npm run test:mab' (in progress). Output: sh://turn_1/npm_test_mab_0, sh://turn_1/npm_test_mab_1
    </sh>
  <knowns> shows:
    <sh path="sh://turn_1/npm_test_mab_0" turn="1" status="102"
        summary="npm run test:mab" fidelity="demoted" tokens="847"/>

  Model reads: "still running, 847 tokens of output so far."
  Model can: <get path="sh://turn_1/npm_test_mab_0" line="800" limit="50"/>
  to tail recent output without promoting.

  Or continue unrelated work — agent isn't blocked.

Turn 7 (command completed):
  <performed>:
    <sh path="sh://turn_1/npm_test_mab" turn="1" status="200" tokens="58">
    ran 'npm run test:mab', exit=0 (4:23). Output: sh://turn_1/npm_test_mab_0 (12kb), sh://turn_1/npm_test_mab_1 (empty)
    </sh>
  <knowns>:
    <sh path="sh://turn_1/npm_test_mab_0" turn="1" status="200"
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

## Road to Production

### E2E Test Fixes (blocking)
- [ ] Fix `accepted edits visible on next turn` — AuditClient auto-resolve
  must apply file patches to disk before accepting
- [ ] Fix `rejection and recovery` — test needs ability to reject
  proposals (AuditClient currently auto-accepts everything)
- [ ] Fix `autonomous web search` — 300s timeout, proposal hang.
  Debug the notification → auto-resolve → waitForResolution chain
- [ ] Fix `model works within tight context` — investigate failure cause
- [ ] Confirm all 16 E2E stories pass

### Client Contract Update
- [ ] Document `run/proposal` notification for rummy.nvim client
- [ ] `ask`/`act` no longer returns 202 — always returns final result
- [ ] Client listens for `run/proposal`, presents to user, calls
  `run/resolve` as before
- [ ] Update rummy.nvim to handle new contract

### Demo Validation
- [ ] Fresh demo run on rummy.nvim project — verify:
  - File edits via SEARCH/REPLACE (not bare body overwrites)
  - Budget overflow handled gracefully
  - Model reasoning visible (RUMMY_THINK)
  - No `<env>` for directory listing
  - Multiple file edits in one turn (sequential proposal resolution)

### Benchmark Runs
- [ ] MAB CR full split with DeepSeek (`npm run test:mab -- --split Conflict_Resolution`)
- [ ] MAB taxonomy health check (`npm run test:mab:taxonomy`)
- [ ] LME oracle split (`npm run test:lme -- --split longmemeval_oracle --row 0-49`)

### Documentation
- [ ] SPEC.md: verify all sections match current implementation
- [ ] PLUGINS.md: verify third-party developer guide accuracy
- [ ] Plugin READMEs: update for current behavior
- [ ] README.md: final review for public consumption

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

