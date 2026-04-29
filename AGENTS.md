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

The contract (SPEC [entries](SPEC.md#entries)) is fully delivered.
Schema, primitives, entry grammar, client RPC surface, plugin hygiene,
and external repo rewrites (`rummy.repo`, `rummy.web`, `rummy.nvim`)
are landed. System instructions are split into a stable base
(identity + tools + tooldocs) plus a dynamic `<instructions>` block
that rides the user message to keep prompt caching intact. Lifecycle
handshake, budget math, and fallback hygiene are clean. Phase 7
(verification) is the remaining work; benchmarks (LME, SWE-bench
Verified Mini) are scaffolded and run on demand.

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
- **Phase 7 — Verification** ⌛ Doc walk, demo handoff. See Open Items.

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

- [ ] **`unknown://env/...` example in instructions_104.md.** Add a
  second Definition-stage example demonstrating env-sanity unknowns
  (e.g. `unknown://env/node_runtime` — "What node version is
  available on this system?") alongside the existing trivia example.
  Rationale: catch runtime/dependency assumptions in Definition,
  resolve in Discovery via `<env>`, and re-verify in Deployment via
  the _107 example. Same pattern, three-stage continuity. Helps weak
  models (gemma) avoid skipping environment checks before producing
  deliverables. Discuss namespace (`unknown://env/...`?) and exact
  wording before landing — keep abstract enough to generalize beyond
  Node.

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
- **Unknown spamming is real.** Gemma can emit 90+ visible unknowns
  in a single Definition pass on a fact-heavy ingest. The state
  machine then has to grind every one through Discovery+Demotion
  before reaching Deployment. Front-loaded over-definition is a
  documented failure mode, not a baseline to accept.
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
- **PF-2 — Persona_fork Definition stage.** Doesn't recognize
  fork-inherited knowns; gemma confabulates new unknowns.
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

**Spirit-clause-driven harness improvements that came out of
analysis** (all pushed to `test/tbench`):
- Set plugin: absolute paths honored (model emitting `/app/file.txt`
  no longer joined into `/app/app/file.txt`); silent
  `.catch(() => {})` removed; auto-mkdir parent dir on new-file set.
- Plugin loader: core-plugin failures crash; third-party
  (`RUMMY_PLUGIN_<x>`) failures log loud and continue.
- Service: env-load failures throw; database hygiene refactored to
  opt-in pre-check (skip cleanly when `RUMMY_RETENTION_DAYS` unset,
  throw on configured-but-bad value).
- SocketServer: shutdown loop uses `Promise.allSettled` with
  per-rejection logging instead of empty-catch fan-out.
- XmlParser: replaced htmlparser2 + 4 pre-passes with a custom
  recovery-tolerant tokenizer; body opacity preserves regex
  lookbehind, generics, fenced code, etc.; mismatched-close uses a
  forward-balance heuristic; brutal-corpus regression tests pin the
  contract.
- `RUMMY_PLUGIN_LOAD_TIMEOUT` → `RUMMY_PLUGINS_LOAD_TIMEOUT`
  (namespace collision with plugin-spec env vars).
- `RUMMY_MAX_TURNS` → `RUMMY_MAX_LOOP_TURNS` (clarify per-loop scope).

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
