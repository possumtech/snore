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

## Documentation placement (where each kind of doc belongs)

| Kind | Lives in |
|---|---|
| Non-obvious *why* / hack warning at the site | One-line `//` comment in source, nowhere else |
| *What* the code does | Nowhere — rename until the identifier says it |
| Contract / promised behavior of the system | `SPEC.md`, anchor-tagged so tests can `@`-reference it |
| Plugin's behavior, internal design, helper rationale | `src/plugins/<name>/README.md` |
| Plugin extension surface (events / filters) | `PLUGINS.md` §7 |
| Model-facing guidance at the decision point | `src/plugins/<name>/<name>Doc.js` (tooldoc) |
| Cross-cutting model identity / global rules | `instructions.md` (sacred — touched only on explicit approval) |
| Phase-specific model guidance | `instructions_10N.md` |
| Project state, standing rules, in-flight threads | `AGENTS.md` |

Per-comment decision flow when sweeping source: says *what* → delete;
says *spec* → move to `SPEC.md` / `PLUGINS.md` / plugin README and
delete; warns about a hack/gotcha → trim to one line; duplicates the
constant name → delete.

---

## Where We Are

The contract (SPEC [entries](SPEC.md#entries)) is delivered through
Phase 6. Phase 7 (harness verification) is the active surface: the
FCRM stage rename to Decomposition / Distillation / Demotion /
Deployment, the retry classifier, the prompt-archive paradigm
cleanup (carve-out removed; archived means archived), and the
test-suite parallelism harmonization landed 2026-04-30 with full
e2e green (31/31). The next signal is the tbench cross-section
pre-flight.

## The Plan

- Phases 1–6 (schema, primitives, runs-as-entries, client surface,
  plugin hygiene, external projects) ✓ landed.
- **Phase 7 — Harness verification** ⌛ tbench cross-section pre-flight
  (`regex-log`, `extract-elf`, `git-multibranch`) is the next signal;
  Codex+grok comparison pre-flight after.

---

## Open Items

- [ ] **System auto-pruning.** On loop boundary or when log size
  crosses threshold, archive `log://turn_{M}/**` where M < current -
  `RUMMY_LOG_HORIZON`. Keeps the log bounded on long runs without
  requiring model intervention.

- [ ] **rummy.nvim migration to pulse + query.** The server side is
  done — the typed `run/state` / `run/progress` / `run/proposal`
  notifications are gone (deleted 2026-04-28). `rummy.nvim` still
  consumes the legacy notifications and must be migrated to the new
  contract documented in `CLIENT_INTERFACE.md`: subscribe to
  `run/changed`, track last-seen entry id per run, call
  `getEntries(run, { since, pattern })` to reconcile, and drive UI
  from the entry stream. Substantial lua refactor across
  `dispatch.lua`, `state.lua`, `statusline.lua`, `diff.lua`, plus
  tests. Cannot be validated from this repo — drive from the nvim
  side. Until migrated, `rummy.nvim` will not function against a
  current server.

- [ ] **Headless nvim e2e test.** A test that spins up a headless
  nvim against the server and asserts the statusline renders
  correctly for a known run would catch contract drift at the wire
  layer. Especially valuable now that nvim is consuming the entry
  stream directly — any change to `getEntries` shape or `run/changed`
  cadence is a silent break otherwise.

- [ ] **Core → plugin extraction conversation.** Audit what still
  lives in `src/agent/*` that could plausibly be a plugin. Top
  candidates: `XmlParser` (syntax-layer; would need a `parser.parse`
  hook in `TurnExecutor`), the cycle-detection / strike machinery
  in `src/plugins/error/error.js` (already a plugin but the verdict
  hook is core-coupled), telemetry side of `AgentLoop.#emitRunState`,
  the YOLO-style "report current run status on resolve ack" RPC
  shaping. The Rummy Way: everything is entries+hooks+plugins; a
  conversation needed to decide which extractions are principled vs.
  ceremony. Discuss before refactor.

- [ ] **Render empty user-message section blocks for cache stability.**
  Today rummy renders sections (`<log>`, `<summarized>`, `<visible>`,
  `<unknowns>`) only when they have content. Result: any turn that
  adds the first entry of a category — or removes the last — *changes
  the byte at that position* in the user message and invalidates
  the prefix cache from there forward. Empirically traced in the
  passing gemma regex-log run on 2026-04-29: T1→T2 cliff at the
  first `<log>` block, T2→T3 cliff at the first `<summarized>`
  block, T3→T4 cliff when log entries were demoted out. Mitigation:
  always render the section structure (e.g., `<summarized></summarized>`
  even when empty); content APPENDS into stable shapes. Cost:
  ~20 tokens per empty section per turn. Win: deeper prefix cache
  on structurally-stable user messages. Worth doing once we have
  baseline numbers to A/B against.

- [ ] **`unknown://env/...` example in instructions_104.md.** Add a
  second Decomposition-stage example demonstrating env-sanity
  unknowns (e.g. `unknown://env/node_runtime` — "What node version
  is available on this system?") alongside the existing trivia
  example. Rationale: catch runtime/dependency assumptions in
  Decomposition, resolve in Distillation via `<env>`, and re-verify
  in Deployment via the _107 example. Same pattern, three-stage
  continuity. Helps weak models avoid skipping environment checks
  before producing deliverables. Discuss namespace
  (`unknown://env/...`?) and exact wording before landing — keep
  abstract enough to generalize beyond Node.

- [ ] **Tooldoc example weight.** (CC-13 in the audit.) System prompt
  is ~6KB / ~2K tokens, of which ~5.5KB is tool docs (10 tools × 5+
  examples each). Strong models pattern-match tools from one example;
  weaker models benefit from multiple. Worth measuring same prompts
  with 2-example vs 5-example tooldocs against grok and gemma to
  see if the example density is earning its cost. Benchmark, not a
  fix — frame as a measurement task.

- [ ] **resolveCommand `||` empty-string conflation.**
  `src/agent/XmlParser.js` `resolveCommand` uses chains like
  `a.path || trimmed || null` for path/command/options/etc. Empty
  string is falsy, so `<get path=""/>` collapses to `path: null` —
  conflating "explicit empty" with "unset." Probably benign for all
  current callers (empty path is meaningless in every tool we ship)
  but the pattern is fallback-shaped and worth a `??` pass when a
  real caller surfaces the distinction. Cross-tool sweep, not a
  one-liner.

- [ ] **Sudden-death turn warning.** On the last turn of
  `RUMMY_MAX_LOOP_TURNS`, surface an error/notice to the model giving
  it a heads-up that it's on its sudden-death turn — close cleanly
  rather than getting capped mid-thought. Implementation deferred;
  this is a reminder.

- [ ] **Zero-downtime model swaps on `gemma.possumtech.com`.** Today
  a model swap on the prod endpoint produces a measurable window of
  Cloudflare 502s (origin unreachable) followed by `503 "Loading
  model"` (origin alive, model not yet warm). Observed during e2e
  validation on 2026-04-29: one test passed in 84 s, the next chewed
  300 s of retry budget on 502/503 before timing out. A public
  benchmark service can't be trusted to retry through this kind of
  window, so it's launch-blocking infrastructure work — `gemma.possumtech.com`
  is the launch endpoint. Three real fixes (pick one or layer):
  (a) blue/green `llama-server` pair behind the proxy — load new
  model on standby, atomic upstream flip, drain old; (b) origin
  health-gate at the proxy — `llama-server` reports not-ready until
  `/v1/models` returns 200, proxy surfaces honest `Retry-After`
  instead of letting Cloudflare 502 the gap; (c) operator
  discipline — never swap models during external benchmark windows.
  (a) is the launch-grade answer. Outside this repo (proxy / server
  config) but pinned here so it doesn't get folded into "we'll
  handle it in retry" — retry is the bandage, this is the wound.
  Cross-ref: `src/llm/retry.js` classification refactor landed
  2026-04-29.

- [ ] **Streaming-pipeline integrity from `llama-server` to
  Cloudflare.** Even with rummy doing SSE on its side, the full
  end-to-end stream depends on the origin proxy and `llama-server`
  preserving streaming behavior. Two concerns to verify on the
  prod box, both infra-side (no rummy code change):
  (a) **Origin proxy buffering.** Whatever fronts `llama-server`
  (nginx, Caddy, etc.) must pass `text/event-stream` through
  unbuffered. Nginx specifically needs `proxy_buffering off` and
  `proxy_http_version 1.1` on the upstream block; otherwise it
  accumulates SSE chunks until its buffer fills, defeating
  streaming end-to-end and turning fast-token streams into
  batched responses (which exposes us to Cloudflare's TTFB cap on
  long completions). Cheap to verify, free to fix if wrong.
  (b) **Heartbeat during cold-start prompt-eval silence.** When
  the model is parsing a large prompt before generating its first
  token, no bytes flow on the stream — and Cloudflare's free-tier
  TTFB cap is ~100s. A 32K-token prompt at ~500 tok/s prompt-eval
  gets close to that ceiling. The standard SSE-comment heartbeat
  (`:keep-alive\n\n` every 5–15s during silence) resets the TTFB
  timer. Either find the right `llama-server` flag (if there is
  one), or run a tiny heartbeat-injecting sidecar between
  `llama-server` and Cloudflare. Our consumer (`openaiStream.js`)
  already tolerates SSE comments — they're skipped in the parse
  loop — so this is purely a producer-side fix. Sibling to the
  blue/green Open Item; both protect different lanes of the same
  failure surface.


## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code.
  Everything the contract doesn't name, isn't there.

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
- **OpenRouter routing can flip mid-session.** Observed during regex-log
  pre-flight: turns 1–3 routed `is_byok: false` (relay-funded), turns 4–5
  flipped to `is_byok: true` (BYOK). Different upstream pools mean
  different cache state — saw cache hit drop 99% → 2% across the flip
  with bit-identical system prompt and append-only user content. This
  is OpenRouter behavior, not a rummy design issue. For clean
  latency/caching analysis, route direct (`xai/grok-4-1-fast-reasoning`)
  rather than via OpenRouter (`openrouter/x-ai/grok-4.1-fast`).
  Reserve OpenRouter for the final leaderboard-comparison run where
  matching the leaderboard's upstream matters; document which routing
  was used in the writeup.
- **Cost reporting under BYOK.** OpenRouter's `usage.cost` reads `0`
  when routed via BYOK — the relay didn't bill, the upstream charged
  the user's API key directly. The truth is in
  `usage.cost_details.upstream_inference_cost`. Telemetry uses that
  as a fallback so the run-summary line reflects real spend.
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
- **When the model emits malformed XML or "wrong" syntax, scan
  `instructions.md`, `instructions_10N.md`, and `*Doc.md` for that
  exact pattern first.** Models reproduce what they see modeled.
  "Unclosed `<set>`" or "wrong attribute name" has been our fault
  more than once — an example with a typo, an inconsistent attribute
  spelling, an unbalanced tag in a code block. Treat the model's
  syntax mistake as an audit trigger before treating it as a model
  capability problem.
- **Unknown spamming is real.** Weak models can emit 90+ visible
  unknowns in a single Decomposition pass on a fact-heavy ingest.
  The state machine then has to grind every one through
  Distillation+Demotion before reaching Deployment. Front-loaded
  over-decomposition is a documented failure mode, not a baseline
  to accept.
- **When a model misbehaves, audit the test prompt against the
  documented protocol first.** Don't theorize about model
  non-determinism or harness bugs until you've verified the prompt
  isn't asking the model to violate a documented rule. A prompt that
  says "run `ls` via `<sh>`" violates `shDoc.md`'s "use `<env>` for
  read-only commands" rule, and a small model that obeys the docs
  will struggle. The "small model is flaky" interpretation is almost
  always a prompt smell.
- **Reasoning-runaway is a model pathology, not an instruction
  failure.** Small models can spiral inside `reasoning_content` —
  planning the same action over and over, never emitting it,
  burning completion tokens until the response truncates. The
  model isn't forgetting that XML tags execute; it's stuck. No
  instruction edit reaches a model in this state. The framework's
  answer is the strike-streak watchdog: a single empty-emission
  turn fires a strike, the next productive turn resets, and
  sustained runaways accumulate to abandon. Observed and recovered
  cleanly in the 2026-04-28 demo run (turn 7 = 34K reasoning, 0
  emissions; turn 8 productive; run completed at 200). Don't add
  forward-looking coaching for the runaway state — analyze upstream
  instead (what was the model facing on the turn *before* it
  spiraled?).
- **Stochastic agentic tests should accept the engine's terminal
  set, not just success.** Identical prompts on identical models
  can land 200 or 499 depending on the decision tree the model
  walks. A test asserting strict 200 on an agentic run is flaky by
  construction. Either widen the assertion to `[200, 499]` (or
  whichever set is legitimate for the test's intent) or move the
  test to `test/live/` where stricter outcome verification is the
  whole point. The protocol-as-state-machine guarantees terminal
  reachability, not deterministic success. (Source: CC-8c in the
  E2E audit; seen in `persona_fork` 3rd subtest pre-session.)
- **Output rendered inside a tag the model also emits as input gets
  reproduced as input.** rummy.web's search log entry rendered
  under `<search>` (the same tag the model emits as a tool call)
  with a body of `URL — title (N tokens)` lines. Weak gemma
  reading prior search-result blocks then emitted NEW `<search>`
  queries with that same line shape inside — confusing output for
  input. Fixed by switching the body to a markdown bullet list
  (`* URL — title (N tokens)`); the leading `*` is the
  load-bearing signal that this is prose output, not a query the
  model would type. Tag-shaped fixes (whether a new tag like
  `<hit>` or an existing scheme tag like `<https>`) are also at
  risk of being reproduced as tool calls — markdown bullets are
  the unambiguous choice. General rule: when an action's log
  entry shares its wrapper with the input tag, the body must use
  a marker (markdown bullet, indent, prose) the model has no
  training-prior to emit as a tool.
- **State transitions don't mint new entry ids; since-based pulse
  filters miss them.** `AuditClient` originally used `since:
  lastSeen` to filter `getEntries` for new proposed entries on
  every `run/changed` pulse. But proposals are *materialized* by a
  plugin hook that rewrites the existing run_view row in place
  (state: resolved → proposed) — the entry id doesn't change.
  Result: the auto-resolver's first snapshot saw the entry as
  resolved, advanced lastSeen past it, and every subsequent pulse
  filtered it out. The proposal sat unresolved forever; tests
  hung. Fix shape: drop the since-based optimization for state-
  sensitive scans, full-scan + dedupe via a resolved-set. Lesson:
  any client tracking state changes via `since: id` filters needs
  to think about whether state transitions allocate new ids.
- **Multi-CTE views need carve-outs mirrored at every stage that
  processes the affected column.** `v_model_context` had a
  carve-out for archived prompts at the visibility layer (CTE 1)
  but not at the body-projection layer (CTE 2), silently zeroing
  the prompt body even though the row passed through. Symptom: the
  model in Deployment Stage saw `<prompt>...</prompt>` with an
  empty body and emitted "please provide a prompt to act upon"
  instead of answering. When you add a carve-out at one stage of a
  multi-stage view or pipeline, audit every downstream stage that
  touches the same data — partial carve-outs are worse than no
  carve-out because the entry's *presence* is preserved while its
  *content* silently vanishes. Pin with an integration test at
  every layer, not just the entry layer.
- **Block ordering matters for prefix caching.** Within the user
  message, blocks are ordered slowest-mutating-first (top) to
  fastest-mutating-last (bottom). This isn't aesthetic — KV cache
  reuse extends through the longest prefix that matches the prior
  turn, so a block that mutates frequently kills cache for
  everything below it. Current order: `<summarized>` (slow) →
  `<visible>` (per-turn unchanged unless promote/demote) → `<log>`
  (appends per turn) → `<unknowns>` → `<instructions>` (per phase)
  → `<budget>` (recomputed) → `<prompt>` (run-stable, conventionally
  last). The system message stays fully stable post-bifurcation.
  Don't reorder blocks without considering the cache impact at the
  bottom of the order.
- **Wire-body literals masquerade as config-driven defaults.** The
  provider plugins (`openai.js`, `ollama.js`, `openrouter.js`) hardcoded
  `think: true` / `include_reasoning: true` for weeks while
  `src/agent/config.js` declared `RUMMY_THINK` and `.env.example`
  defaulted it to `1`. The flag was unused; the literal was
  load-bearing. Symptoms presented as "gemma reasoning-runaway" — a
  documented model pathology — and the strike-streak watchdog
  cleanly recovered, so the harness bug hid behind a model story.
  A reasoning-capable model (grok-fast-reasoning) would have
  absorbed the forced reasoning and still produced output, masking
  the bug from any non-gemma benchmark. Lesson: when a model
  exhibits a documented pathology, **read the actual wire body**
  before classifying. A literal `true` in plugin source that
  ignores its config knob is the most expensive kind of bug —
  every prior benchmark number on the affected provider is
  potentially compromised. Cross-ref: TBENCH_AUDIT.md
  `@audit_task_regex_log_smoke_1`, the audit's first STRUCTURAL
  finding (2026-04-30).
- **Models reach for tools we never advertised.** Gemma 4 IT has a
  deep CoT training prior — it emits `<think>...</think>` even
  when the harness doesn't advertise the `<think>` command and no
  prompt content references it. Verified post-RUMMY_THINK=0 fix
  via `regex-log` smoke #2: zero `think` tokens in the system
  prompt, model still emitted `<think>` blocks across all 5 turns.
  The think plugin already absorbs this gracefully (scheme
  registers unconditionally; tool handler conditional on `THINK`;
  reasoning-merge filter folds `<think>` bodies into
  reasoning_content for telemetry regardless), so the parser
  doesn't trip and the entries land cleanly. But: extended
  CoT-in-content blows past n_ctx the same way server-side
  reasoning would. Mitigations are model-side (chat template
  tweaks, sampler/stop tokens, swap to a non-reasoning gemma
  variant) — not harness-side. Document the observation; expect
  it on every gemma run.

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Append entries here only when there's an actually-ongoing
conversation worth tracking across sessions (an in-flight refactor
mid-stream, a deferred decision with a real follow-up, a debugging
thread that hasn't resolved). Landed work belongs in git history;
durable rules belong in the standing rules block above; durable
observations belong in the Lessons section. Don't chronicle what
the diff already records.*

### Instruction-side findings (gathering for a focused session)

Sacred prompts (`prompt.ask.md`, `prompt.act.md`,
`instructions.md`, `instructions_10N.md`, `*Doc.md`) get edited
together in a single deliberate pass, never piecemeal. As the audit
surfaces instruction-side issues, append here. When the list feels
saturated, request explicit go for a focused instruction-edit
session and work the batch.

- **CC-8a — Reasoning-vs-emission gap.** Model plans actions in
  `reasoning_content`, doesn't emit them. Cross-test pattern.
  Explanation-side fix.
- **CC-12a — `sh`/`env` MUST-clause repetition.** 6 negatives for
  2 binary distinctions. Tooldoc cleanup.
- **PF-2 — Persona_fork Decomposition stage.** Doesn't recognize
  fork-inherited knowns; weak models confabulate new unknowns.
  Likely instruction-side.
- **`repo://overview` file-op regression.** Open Item filed; the
  fix is partly packet-shape (system) and partly instruction-side
  (teach the model how to navigate the overview / when to expand).
  Cross-reference once packet-shape decision lands.
- **`<summarized>` / `<visible>` packet split — model orientation.**
  Tooldocs need to teach: summary lines live in `<summarized>` (your
  identity-keyed map of what exists); full bodies live in `<visible>`
  (your current working set). Promote `<get>`s a summarized entry into
  `<visible>`. Demote drops it back. The structural split changes how
  the model should reason about its working memory; tooldoc examples
  should reflect the new shape.

### terminal-bench 2.0 / Harbor wiring (2026-04-27, in flight)

**Goal.** Land rummy on the terminal-bench 2.0 leaderboard
(https://www.tbench.ai/leaderboard/terminal-bench/2.0). Submission
runs via Harbor (`harbor run --dataset terminal-bench@2.0 ...`),
not the legacy `terminal-bench` repo's `installed_agents/`.
Comparison: **rummy+grok vs codex+grok**, same model both sides,
harness-only delta. Cost-bound to ~$30–90 by avoiding the GPT-5.5
re-run (cite the public leaderboard number for that). User is fine
publishing negative results.

**Locked decisions.**
- Model alias: `xfast` = `openrouter/x-ai/grok-4.1-fast` via
  OpenRouter BYOK (`OPENROUTER_API_KEY`).
- Comparison harness: Codex (Harbor's `codex` adapter).
- Adapter approach: fork `laude-institute/harbor`, add
  `src/harbor/agents/installed/rummy.py` (BaseInstalledAgent subclass).
- CLI client: in-process, `src/plugins/cli/` plugin + bin
  (faster/simpler than subprocess+WebSocket, uses ProjectAgent
  directly via boot.completed hook).
- Env-var-everywhere: all config uses `RUMMY_*` prefix; CLI flags
  are 1:1 with env names (`--RUMMY_YOLO=1`, `--RUMMY_PROMPT="..."`).
  No second naming surface. Profile cascade via Node's
  `--env-file-if-exists=.env.tbench`.
- Test scaffolding lives in `test/tbench/`, mirrors `test/swe/`.

**Status.** Mechanics verified end-to-end. The harbor fork
(`possumtech/harbor`, branch `add-rummy-agent`) holds the rummy
adapter, registered in `AgentName` enum and `AgentFactory`. Adapter
clones rummy's `test/tbench` ref into the docker sandbox at install
time, runs `rummy-cli`, exfils `turns/`, `last_run.txt`, and
`rummy.db` from `$HOME/rummy/` into `/logs/agent/` for analysis. Cli
plugin emits a trailing `__RUMMY_RUN_SUMMARY__ {…}` line on stdout
(status, turns, cost, tokens, model) consumed by
`populate_context_post_run`.

**Spirit-clause-driven harness improvements** that came out of
tbench analysis are landed (set/get plugin hygiene, plugin loader
crash-vs-warn split, env-load throws, XmlParser recovery-tolerant
tokenizer, env namespace fixes, FCRM stage rename, retry
classifier, prompt-archive paradigm cleanup, AuditClient
zombie-run abort) — all in git history, summarized in "Where We
Are" above.

**Next steps:**
1. Cross-section pre-flight (3 representative tasks) once mechanics
   pre-flight repeats cleanly with the parser refactor: `regex-log`,
   `extract-elf`, `git-multibranch`. Different muscle groups.
2. Codex+grok pre-flight to verify the comparison adapter works
   off-distribution. Fall back to Goose / Aider if Codex+grok has
   friction.
3. Full eval: 89-task × 3-seed × both adapters (~$30–90).
4. Tabulate + writeup.

**Spirit clause (load-bearing):**
- Goal is harness analysis + general improvement, not a leaderboard
  number. Any tbench-driven change must be a *general* improvement
  benefiting any agent task — no benchmark-specific prompts,
  heuristics, or tools. Pitch must remain "rummy is a general agent
  that just happens to perform well at tbench," not "rummy is tuned
  for tbench."
- Pre-flight task selection must be a representative cross-section,
  never cherry-picked for likely passes.
- The harbor adapter (`rummy.py`) stays vanilla — it's a protocol
  bridge, not a benchmark booster.

**Risks / open questions:**
- Codex's Harbor adapter may not accept `openrouter/x-ai/grok-*`
  cleanly (Codex is OpenAI-tuned). Pre-flight resolves.
- Inside Harbor's docker sandbox, rummy's `<sh>`+YOLO flow needs
  to work robustly. YOLO landed but unproven at tbench scale.
- `RUMMY_MAX_LOOP_TURNS` is per-loop only (no per-run cap), so the
  default 99 is fine for tbench. Re-evaluate if per-loop drift
  becomes a problem.

**Story angles for the writeup:**
- "Same model, different harness — rummy beat / lost to Codex by X
  points." Cleanest harness-contribution claim.
- Caveat: Codex is OpenAI's harness, sandbagged off-distribution
  on grok. Document, don't hide.
- Cite leaderboard's published 82.0% Codex+GPT-5.5 number for
  context, no re-run on our side.
