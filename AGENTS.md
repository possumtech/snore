# AGENTS: Planning & Progress

> **SESSION BOOTSTRAP — READ ME FIRST.** This file is the only
> cross-session ground truth. Before touching code: read the standing
> rules, the "Where We Are" paragraph, and any open "Ongoing
> Development Conversation" entries. Cross-reference SPEC.md §0 for
> the contract and PLUGINS.md §7 for the events/filters surface.
> **Append to "Ongoing Development Conversation" as you work** —
> decisions made, rules restated, choices deferred. The next session's
> coherence depends on it.

> **Standing rules that override anything else:**
> - **No fallbacks outside `src/plugins/hedberg/*` and `src/agent/XmlParser.js`.**
>   Not `|| 0`, not `?? null`, not `|| ""`. Boundaries validate;
>   interiors crash on contract violation. `biome/no-fallbacks.grit`
>   enforces — if it complains, fix the contract, not the rule.
> - **Every `createEvent` / `createFilter` in `Hooks.js` is a plugin
>   extension point and stays.** Zero current subscribers does not
>   mean "delete" — extensibility is the keystone architectural
>   promise. Adding events where core fires an unannounced phase
>   is encouraged.
> - **AGENTS.md isn't a trophy room.** When a phase lands, its
>   detail collapses to one line. Lessons survive; trivia dies.
>   Never remove a standing rule.
> - **The user is right until the DB proves otherwise.** When a
>   symptom gets reported, read `rummy_dev.db` first, don't guess,
>   don't blame the environment, don't defer to the next demo.
> - **Integration and e2e tests are 1:1 with SPEC.md's snake_case
>   anchor system.** Every SPEC.md heading carries an explicit
>   `{#snake_case_id}` anchor. Every anchor has at least one
>   `@snake_case_id` reference in `test/integration/` or
>   `test/e2e/`. Every test in those dirs is attributed to at least
>   one `@`-reference. No integration or e2e test exists outside
>   this system; no SPEC anchor exists without a test anchoring
>   it. See SPEC.md section "Spec-Anchored Testing". Enforced by
>   `npm run test:spec`. Numeric `§X.Y` references are dead — use
>   snake_case anchors that don't churn when sections move.
> - **AGENTS.md is the project memory scratchpad.** Never store
>   project-scoped decisions, plans, or state in Claude internal
>   memory (`~/.claude/projects/...`). Project-specific facts live
>   here where everyone can see them and the next session can read
>   them. Internal memory is for user-wide preferences only.

> **Instructions discipline (when touching `src/plugins/instructions/instructions.md`
> or any `instructions_10N.md` phase file):**
> - **Brief.** Every token is paid every turn. Cut before expanding.
> - **Show, don't tell.** Examples teach better than prescriptions. A
>   three-line worked example beats ten lines of "you must / you should".
> - **Mind the trade-offs both within and between tools the model must
>   succeed with.** Instructions that optimize one tool can sabotage
>   another. The model's context budget is one zero-sum pool shared
>   across `<get>`, `<set>`, `<rm>`, `<search>`, `<update>`, `<sh>`,
>   `<ask_user>`. Adding a rule that helps one can cost another its
>   oxygen.
> - **Static base in system, phase-specific in user.** The base
>   template (`instructions.md`) is part of the system prompt — it
>   must stay stable across turns within a run so prompt caching
>   holds. The phase-specific `instructions_10N.md` files render as
>   `<instructions>` in the user message (dynamic by design).
>   Anything that would change mid-run belongs in the phase files,
>   never the base template.

> **Guiding principles (enshrined):**
>
> "Is there a rummy way to do this?" Every `<tag>` the model sees is
> a plugin. Every scheme is registered by its owner. Every piece of
> data exists as an entry or a column. No exceptions without docs.
>
> **Everything is an entry.** Files, tool calls, streaming output,
> plans, unknowns, sub-agents — all entries. `<get>`/`<set>` is the
> universal grammar. (SPEC §0.1)
>
> **"Model behavior" is never an acceptable explanation for a test
> failure.** When a model misbehaves, the system failed — suboptimal
> context, poorly designed conditions, insufficient reinforcement.
> Every failure is a system bug until proven otherwise.
>
> **Reference + feedback over broadcast.** Steer the model through
> three channels in priority order: (1) tooldocs at the decision
> point, (2) error:// entries for dynamic feedback, (3) instructions
> for genuinely cross-cutting identity. System instructions pay context
> every turn; prefer the other two channels first.

---

## Where We Are

The contract (SPEC the_contract) is fully delivered. Schema,
primitives, entry grammar, client RPC surface, plugin hygiene, and
external repo rewrites (`rummy.repo`, `rummy.web`, `rummy.nvim`) are
all landed. The system instructions were split into a stable base
(identity + tools + tooldocs) plus a dynamic `<instructions>` block
that rides the user message to keep prompt caching intact. Lifecycle
handshake, budget math, and fallback hygiene are all clean. Phase 7
(verification + benchmark) is the remaining work.

## The Plan

- **Phase 1 — Schema** ✓ `run_views.state`, four writer tiers, view
  layer, boot env resolution.
- **Phase 2 — Primitives** ✓ Six-verb object-arg grammar:
  `set` / `get` / `rm` / `cp` / `mv` / `update`.
- **Phase 3 — Runs-as-entries** ✓ `run://<alias>` scheme, client
  writer tier, run:// → entry mirror with unified lifecycle.
- **Phase 4 — Client surface** ✓ RPC is a thin projection of the
  plugin API. Protocol 2.0.
- **Phase 5 — Plugin hygiene** ✓ Plugin-dep system deleted,
  TestDb+TestServer share one graph, PermissionError typed, handler
  writer plumbed via Proxy.
- **Phase 6 — External projects** ✓ `rummy.repo`, `rummy.web`,
  `rummy.nvim` all rewritten to the 2.0 wire and green.
- **Phase 7 — Verification** ⌛ Doc walk, benchmark baseline, demo
  handoff. See Open Items.

---

## E2E Failure Backlog (2026-04-25, gemma)

`npm run test:e2e` baseline after `noWeb` plumbing fix and
`record_behavior.test.js` deletion: **23 / 31 pass, 6 fail, 2
cancelled**. Work each row to root cause + fix (or deliberate test
adapt) before the next full e2e sweep — no rerunning the whole suite
to "see if it cleared up."

- [ ] **`demo_hydrology.test.js:102` — `scenario must exercise proposals`.**
  Run finishes 200 in ~9 turns with 0 proposals; gemma confabulates a
  summary instead of writing the file. Same shape as
  terminal_state_with_proposal:120 below — likely one root cause.

- [ ] **`stories.test.js:338` — `autonomous unknown investigation`
  (expected 200|202, got 499).** Run abandoned at 3 strikes during the
  Define→Discover loop. Need to read the strike sequence and figure
  out whether it's stage-protocol drift or a real recovery gap.

- [x] **`stories.test.js:362` — `lite mode sustained session`.** Test
  helper `lastResponse` was reading only the `<update>` body, missing
  the literal answer that gemma put in prose preceding the update tag.
  Gemma's reasoning showed it correctly identified the answer ("42"),
  emitted `42\n<update status="200">Answered the question with the
  remembered number.</update>` — the answer was in the response, the
  test was looking in the wrong column. Updated `lastResponse` to read
  `assistant://N` (the full raw response) which contains both prose
  and the update tag. Verified passing 2026-04-25.

- [x] **`stories.test.js:422` — `rejection and recovery`** (was 300s
  timeout). Resolver-pattern bug fixed earlier this session
  (`rm://` → `log://turn_N/rm/`). Bounded `client.act` at 60s with
  `.catch(() => null)` so the test doesn't burn 5min waiting on
  graceful self-termination after rejection — the invariant is
  "rejected rm did not delete the file," provable as soon as one
  rejection fires. Verified passing 2026-04-25.

- [x] **`stories.test.js:462` — `model answers under tight context limit`.**
  Same root cause as :362 — `lastResponse` was reading the `<update>`
  body, missing the literal answer in prose. Same fix (read
  `assistant://N`) resolved both. Verified passing 2026-04-25.

- [x] **`stories.test.js:513` — `turn demotion fires and knowns survive intact`**
  Deleted 2026-04-25. Protection invariant
  (`demote_turn_entries` excludes scheme IN ('known','unknown')) is
  covered deterministically by `test/integration/budget_demotion.test.js`
  *"does not demote known:// or unknown:// entries (deliverables)"*.
  Driving the same assertion through a real-model run added no
  coverage and ate 300s every e2e sweep.

- [ ] **`stories.test.js:566` — `pre-turn overflow triggers recovery,
  not immediate 413`** (got 499). Recovery loop not engaging when
  pre-turn is over ceiling. Possibly related to the deliverable-protection
  change — known/unknown excluded from `demote_turn_entries`, may
  starve recovery in this scenario.

- [ ] **`terminal_state_with_proposal.test.js:120` —
  `after proposal accept, terminal run/state arrives`.** Same "no
  proposals fired" assertion as demo_hydrology:102. Cluster-fix
  candidate.

**Cluster reads (work hypotheses, not commitments):**
- :102, :120 — model claims completion without producing proposals
  (no file write attempted). Likely stage 108 (Deployment) lets the
  model 200-out without the work being done; protocol-side gap.
- :338, :566 — strike-out on legitimate work. Recovery may have
  regressed under the deliverable-protection change.

---

## Open Items

- [ ] **Budget → error fold.** Subsumed by the Error paradigm
  unification (see Ongoing Development Conversation, 2026-04-22).
  Budget emits `error.log.emit({status: 413})` instead of
  `budget://`. Drop `budget://` scheme. Hard-exit 413 path at
  `TurnExecutor.js:131-141` deleted.

- [ ] **Post-unification audit: bespoke error paths.** Once the
  Error paradigm unification (2026-04-22) lands, sweep the entire
  codebase for model-facing error handling that bypasses
  `hooks.error.log.emit`. Covers:
  - Plugins: any `entries.set({state:"failed"})`, ad-hoc failure
    entries, custom "something went wrong" tags or schemes.
  - Core: `src/agent/*` — any direct failure-entry writes,
    status-code short-circuits, bespoke "tell the model" branches.
  - Renderer/view projections that surface error-like content
    outside the standard error entry shape.
  Anything found either migrates to `error.log.emit` with an
  appropriate status code, or documents why it's exempt.
  Success criterion: one channel in, one channel out; no parallel
  error paths anywhere the model can see.

- [ ] **System auto-pruning.** On loop boundary or when log size
  crosses threshold, archive `log://turn_{M}/**` where M < current -
  `RUMMY_LOG_HORIZON`. Keeps the log bounded on long runs without
  requiring model intervention.

- [ ] **Gemma/MAB benchmark run.** Published baselines are in this
  doc below (60%/5% GPT-4o; 60%/6% best). With the instructions
  system stable now, we have a meaningful number to measure against.
  Needed *before* any more instruction-shape experiments.
- [ ] **`notification_log` table.** `rpc_log` captures
  request/response; `run/state` / `run/progress` / `run/proposal`
  fly out untracked. Mirroring the shape would let us replay
  notification streams for diagnosis.
- [ ] **Plugin filter priority magic numbers.** 100 / 150 / 200 /
  300 appear throughout with no documented meaning. Either name
  the stages explicitly or document the ranges so third-party
  plugins can slot between phases without reading source.
- [ ] **Headless nvim e2e test.** Every new `run.state` telemetry
  field must be manually re-synced in `dispatch.lua` / `state.lua` /
  `statusline.lua`. A test that spins up a headless nvim against
  the server and asserts the statusline renders correctly for a
  known run would catch drift at contract time.
- [ ] **Stress test for `SocketServer.close()` drain.** Kick off N
  concurrent runs, call `close()` mid-flight, assert (a) the close
  awaits, (b) all run entries land terminal, (c) no Promises pin
  the event loop. Locks in the `abortAll` work.
- [ ] **Glossary in SPEC.** Pin exact meaning of *turn*, *loop*,
  *run*, *verdict*, *strike*, *phase*, *proposal*. Audit code for
  misuses.

## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code.
  Everything the contract doesn't name, isn't there.

## Published Baselines (MemoryAgentBench, ICLR 2026)

Source: HUST-AI-HYZ/MemoryAgentBench — arXiv 2507.05257

| Model | CR-SH (single-hop) | CR-MH (multi-hop) |
|---|---|---|
| GPT-4o | 60% | **5%** |
| Claude 3.7 Sonnet | 43% | 2% |
| Gemini 2.0 Flash | 30% | 3% |
| Best published | 60% | **6%** |

## Lessons (keep these pinned; don't let future sessions forget)

- **AGENTS.md is shared memory.** Internal LLM memory is for
  overrides only. Append project observations here, not internally.
- **Plugin extensibility is a promise, not an implementation detail.**
  Don't delete "unused" events.
- **No fallbacks outside hedberg/XmlParser.** Biome enforces.
- **Read the DB first.** When a symptom gets reported, the answer
  is in the data, not in speculation.
- **Decide, don't dawdle.** When naming or scope questions arise,
  either resolve them in-session or ask the user — don't defer
  them silently to a "follow-up pass" that never happens.
- **The codebase is the codebase.** Don't compartmentalize by
  "prior model's code vs my code" when auditing. If you're
  touching it, it's yours now.
- **Attribute semantics must not split on context.** If `visibility=`
  means one thing on a state-entry tag (`<known>`) and another on an
  action-record tag (`<set>` in `<log>`), the model will confuse them
  and re-emit actions trying to "fix" phantom state. Any attribute
  rendered in the packet must mean the same thing wherever it
  appears.
- **Time-indexed vs topic-indexed paths.** Log entries are time-
  indexed — path encodes turn. State entries (knowns, files,
  unknowns) are topic-indexed — path encodes identity, turn is
  metadata. The rule: if the entry's identity is WHEN, turn goes in
  the path. If identity is WHAT, turn is an attribute.

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Empty — reset 2026-04-25. Append entries here only when there's an
actually-ongoing conversation worth tracking across sessions (an
in-flight refactor mid-stream, a deferred decision with a real follow-up,
a debugging thread that hasn't resolved). Landed work belongs in
git history; durable rules belong in the standing rules block above;
durable observations belong in the Lessons section. Don't chronicle
what the diff already records.*
