# AGENTS: Lessons, Practices, Todos

> **SESSION BOOTSTRAP — READ ME FIRST.** Cross-session ground truth.
> Before touching code: read the standing rules, the "Now" block, and
> any open "Ongoing Development Conversation" entries. Cross-reference
> SPEC.md §0 for the contract and PLUGINS.md §7 for the events/filters
> surface. **This file is not a trophy room** — store lessons,
> practices, and todos. Achievement narrative belongs in git history.

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
> - **Benchmark integrity.** rummy is a general agent that happens
>   to perform well at whatever task it's pointed at — never tuned
>   for a specific benchmark. No benchmark-specific prompts,
>   heuristics, or tools. Pre-flight task selection must be a
>   representative cross-section, never cherry-picked for likely
>   passes. Bridge adapters (e.g. `harbor`'s `rummy.py`) stay
>   vanilla — protocol bridges, not benchmark boosters.

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

## Sweep analysis (tbench digests)

Every tbench sweep auto-emits a deterministic analysis layer at the
end of the run (driven by `test/tbench/digest.js`, called from
`runner.js` post-sweep). Re-runnable with
`node test/tbench/digest.js <sweep-dir>` — read-only derivative of
the rummy.db / rummy.txt / verifier-reward sources, idempotent.

**Per-task artifacts** (in each task dir, alongside `agent/`,
`verifier/`):

- `digest.md` — header (status / reward / turns / cost / tokens) +
  marker list + per-turn waterfall (`T<N>: <status> "<update body>"`
  with indented `  ← <action> <target>` emission lines and
  `  ✗ error:` lines). Scan target: get the shape of a run in one
  screen. Failed emissions tagged `✗ [<outcome>]`.
- `digest.json` — same data, machine-queryable. Use for `jq` /
  cross-task aggregation.
- `reasoning.md` — per-turn `reasoning_content` bracketed by
  `## Turn <N>` headers. Drill-down anchor: when the waterfall
  raises a question (e.g., "what was the reasoning on turn 8?"),
  grep `^## Turn 8` here and read the body.
- `digest_skipped` — empty file, written when `agent/rummy.db` is
  absent (exfil-fail). Tells future passes "we tried, no data."

**Sweep-wide artifact** (at sweep root):

- `index.csv` — one row per task: `task,reward,status,turns,
  prompt_tokens,completion_tokens,cached_tokens,cost,wall_seconds,
  markers`. Standard triage front door.

**Marker taxonomy** (auto-classified, semicolon-joined in `markers`
column):

- `passed` — `reward=1`.
- `claim_success_verifier_fail` — `reward=0` AND `status=200`. The
  dominant failure pattern in the 2026-05-01 sweep.
- `max_loop_turns` — `status=499` AND turn count near
  `RUMMY_MAX_LOOP_TURNS`.
- `strike_abandon` — `status=499` AND an error body starts with
  `Abandoned after`.
- `gate_unknowns` / `gate_knowns` / `gate_demote` / `gate_delivery` —
  error body matched the corresponding state-machine gate's
  message: Decomposition advance requires ≥1 unknown / Distillation
  advance requires ≥1 known / Demotion advance requires no visible
  unknowns / Delivery is the only mode where file modifications are
  permitted. See SPEC.md `#fvsm_state_machine`.
- `reasoning_runaway_t<N>` — turn N had ≥8000 chars of
  `reasoning_content` AND zero productive emissions. Single-turn
  signal; the turn number tags which one.
- `parser_warning` — error body starts with `Unclosed` or contains
  `Tool call limit`.
- `context_overflow` — `status=413`.
- `dispatch_500` — `status=500`.
- `exfil_fail` — no `__RUMMY_RUN_SUMMARY__` line in `rummy.txt` and
  no rummy.db. Run died before drain; container-side post-mortem
  needed.
- `digest_failed` — digest.js threw on this task. Investigate.

**Standard triage queries** (assume `cd <sweep-dir>` first):

- All claim-success/verifier-fails:
  `awk -F, '$2==0 && $3==200' index.csv`
- All gate hits (any state-machine rejection):
  `awk -F, '/gate_/' index.csv`
- All Delivery-mode file-write rejections:
  `awk -F, '/gate_delivery/' index.csv`
- All runaway turns (with which turn):
  `awk -F, '/reasoning_runaway/' index.csv`
- Open one task's digest: `cat <task-dir>/digest.md`
- Reasoning on a specific turn:
  `awk '/^## Turn 8$/,/^## Turn /' <task-dir>/reasoning.md`
- Cross-task error grep:
  `grep -rh "✗ error:" */digest.md | sort | uniq -c | sort -rn`

**Output-dir control.** `test/tbench/runner.js` accepts `--out
<path>` (CLI) or `RUMMY_TBENCH_OUT_DIR` (env) to override the
default timestamped path under `test/tbench/results/`. Used for
parallel runs landing in named dirs:
`npm run test:tbench:gemma -- --out audit/gemma_1` and
`npm run test:tbench:xfast -- --out audit/xfast_1` in separate
shells. Both write their own digests and indexes.

## Now

**State-machine refactor in flight.** The substrate has to be
trustworthy before any benchmark or instruction work matters. See
`SPEC.md #fvsm_state_machine` for the contract.

The contract is four rules; everything else is concerns separate
from the state machine:

| Status | Mode advance | Gate |
|---|---|---|
| 145 | Decomposition → Distillation | unknowns ≥ 1 |
| 156 | Distillation → Demotion | knowns ≥ 1 |
| 167 | Demotion → Delivery | no visible unknowns |
| —   | (any mode) | file modifications only when phase = 7 |

Refactor scope:

1. ✅ AGENTS.md cleanup (marker taxonomy uses gate names).
2. ✅ AGENTS.md update (this section).
3. SPEC.md — `#fvsm_state_machine` section: contract table +
   reasoning. The single source of truth.
4. Implementation:
   - `validateNavigation` to the four-rule contract (add the
     Demotion gate; keep the rest).
   - Delete Shield 0 (`#enforceDecompositionMode`) from `policy.js`.
     Keep Shield 3 (file-mod gate) and the ask-mode gate.
   - On rejection in `update.js`, stop writing a phase-history
     `log://turn_N/update/...` entry — emit `error.log` only.
     This deletes the failed-update-skip patch in
     `getCurrentPhase`.
   - Strip per-mode allow-list prose from `instructions_104.md`
     (Decomposition); reframe `instructions_106.md` to make the
     Demotion contract ("no visible unknowns") explicit.
5. Testing — integration + unit tests anchor to
   `@fvsm_state_machine`. Drop Shield 0 tests. Add a Demotion
   advance-gate test set.

Once this lands, then: e2e sweep → pivot terminal-bench from grok
to local gemma. Everything below is downstream of a working
state machine.

## Open Items

- [ ] **Pattern / bulk-operation presentation in toolDocs.** Across
  multiple gemma + gpro runs, models use globs for visibility-batch
  demotion (`<set path="log://turn_5/**" visibility="archived"/>`)
  but rarely for *discovery* — they walk entry-by-entry instead of
  reaching for `<get path="**" manifest>keyword</get>`. Three changes
  worth landing once the gates above settle:
  1. Promote pattern examples in `getDoc.md` / `setDoc.md` to the
     top so they're in the model's first read, not after the
     single-entry forms.
  2. Add a "pattern idiom" line in `instructions_105.md` and
     `_106.md` — these modes are where bulk ops pay off most. One
     line each: "When inspecting many entries, prefer a pattern
     (`**`, `unknown://*`) with `manifest` over per-entry gets."
  3. Now that `<get tags="..."/>` exists, surface it in the FVSM
     mode docs as the recall-by-folksonomy idiom — a worked example
     in `instructions_105.md` showing tag-based source recall.

- [ ] **Single-turn budget escape.** A run was observed sending
  ~2.3× the configured budget cap in a single turn. Two candidate
  causes, exactly one true:
  1. **Token-counter divergence.** `countTokens(body) = length /
     RUMMY_TOKEN_DIVISOR` undercounts vs the upstream tokenizer
     for content that's binary/JSON/code-heavy. Budget enforcement
     thought it was capping at N; actual tokenization came in
     above.
  2. **Budget-enforcement escape path.** Content gets added to the
     assembled packet *after* `budget.enforce()` runs (system
     prompt assembly, post-enforcement plugin filters,
     `assembly.user` 175-priority inserts). Enforce caps at N;
     downstream insertion blows past it.

  Triage: replay the turn, compare `countTokens` to provider's
  reported count for the loaded body. Whichever diverges identifies
  the bug.

- [ ] **Chromium cgroup-OOM kills agent before watchdog fires.**
  Surfaced in tbench `caffe-cifar-10` — chromium-renderer OOM
  killed the agent process before drain could exfil. Triage: bound
  chromium memory usage in `WebFetcher` (`--memory-pressure-off`,
  `--max_old_space_size`, or `--disable-dev-shm-usage`), or surface
  the OOM as a recoverable strike rather than letting the kernel
  kill us. General fix; not benchmark-specific.

- [ ] **Continuation-forever in Distillation.** Re-evaluate after
  the state-machine refactor: the Demotion advance gate (no
  visible unknowns) forces the model to either resolve or REJECT
  every unknown before reaching Delivery, which closes most of the
  155-forever paths at the protocol level. If runaway distillation
  still surfaces post-refactor, cycle detection on `<update>` body
  fingerprints (extending `error.js#detectCycle`) is the candidate
  fix.

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
- **Claude's shell carries a stale `XAI_API_KEY`. Source `.xai.key`
  before every tbench launch (or anything that hits xAI).** The
  user fixed `.bashrc`, but Claude's persistent shell session
  pre-dates that fix and exported the old key. The shell value
  supersedes `.env` in `process.env`, so node + the harbor adapter
  forward the bad key to the docker container. xAI rejects with
  `400 Incorrect API key provided: xa***8X`, every turn dies at
  status=500, the run completes in ~60–90s with zero tokens, and
  no fix under test gets exercised. The user has warned about
  this repeatedly. Always launch via:
  ```
  source .xai.key && npm run test:tbench -- --task <name>
  ```
  `.xai.key` is a one-line `export XAI_API_KEY="..."` the user
  maintains specifically for this purpose. Do not parse `.env`
  manually — it's quoted and shell extraction strips quotes
  inconsistently (xAI then rejects the quoted value as `"x***A"`).
  The user has fixed `~/.bashrc` (line 130 exports the correct
  key) but Claude Code's Bash subshells empirically do not pick
  it up — the stale parent-process value still wins. If a future
  Claude finds a reliable way to mutate its own environment to
  pick up the bashrc value, great; until then, `source .xai.key`
  is the known-working path. Do NOT claim the user "rejected"
  shell-mutation options — they did not.
- **Plugin extensibility is a promise, not an implementation detail.**
  Don't delete "unused" events.
- **Instruction prose is signal-dense; respect the four registers.**
  The ~350 lines of `src/plugins/instructions/*.md` and
  `src/plugins/*/[a-z]*Doc.md` carry more behavioral weight than
  tens of thousands of lines of code. Each line is a teaching
  artifact the model encounters every turn for the run's lifetime.
  Tokens here are not the same currency as tokens elsewhere; treat
  every character as load-bearing.

  Model-facing prose is a calibrated grammar with four shapes,
  each carrying different weight:

  - **`YOU MUST` / `YOU MUST NOT`** — the contract floor. Heaviest
    weight; respected strongly. Reserve for actual contracts. Using
    `YOU MUST` for prose-emphasis devalues the register and the
    model rules-lawyers around it. Pair with an `Example:` wherever
    possible — a solo `YOU MUST` is abstract and ambiguous.
  - **`*` bullets** — affordance / permission tier. "You can use X
    to do Y" tells the model a capability exists without imperative
    weight. Right register for "this is one way" rather than "this
    is the only way." Insufficient for hard contracts.
  - **`Example: <tag/>`** — highest signal density per token.
    Concrete syntax + semantics in one shot. Models pattern-match
    examples more aggressively than they obey rules. The example
    IS the contract from the model's view. Bad examples poison;
    good examples compress multiple non-overlapping lessons. When
    prose and example conflict, the example wins.
  - **`{ ... }`** — compression tier. Placeholder semantics inside
    an `Example:`. Lets you teach structure without spending tokens
    on filler ("more topical knowns here," "direct answer," etc.).
    Useless standalone; the description inside the braces does the
    load-bearing work.

  **Cross-cutting craft notes:**
  - `YOU MUST` + `Example:` is the strongest combination (rule +
    canonical demonstration).
  - `*` + `Example:` is the standard shape for affordances ("you
    can; here's what it looks like").
  - Don't mix `*` with `YOU SHOULD` / `YOU MUST` on one line —
    register collision; the bullet downgrades the imperative.
  - `<!--` comments cost tokens. Keep them when they add semantic
    information the model needs; cut them when they're human-facing
    rationale or restatement of the example above.
  - Every example path teaches taxonomy by example. Underscore-
    prefix globs (`known://draft_*`, `known://temp_*`) and
    single-level globs (`known://hydrology/*`) model lazy
    folksonomy that the model imitates verbatim. Use hierarchical
    slash-segmented paths (`known://countries/france/*`,
    `known://geography/indiana/orange_county/*`) — the canonical
    shape from `instructions_105.md`.

  **Failure modes that signal register miscalibration:**
  - `YOU MUST` everywhere → models start ignoring it.
  - Examples that contradict surrounding prose → model follows
    the example, ignores the prose. Always reconcile.
  - Bullets carrying contracts → model treats contracts as optional.
  - Lazy taxonomies in examples → model produces lazy taxonomies
    in real entries. Examples are imitated literally.
  - Repeated rules across multiple docs (preamble + tooldoc + mode)
    are reinforcement, not waste — provided the rule is genuinely
    contract-floor. Reinforcement at decision points is a feature.
    But the same rule restated in different words within ONE doc
    is dilution; pick the strongest phrasing and drop the rest.

  Before adding ANY line to an instruction or tooldoc, ask: which
  register is this? Is the register right for the level of
  compulsion the protocol actually requires? Does it carry a lesson
  the surrounding examples don't already carry?
- **No fallbacks outside hedberg/XmlParser.** Biome enforces.
- **Configuration is the cascade. Period.** `.env.example` declares
  every variable the code reads, with a usable default. `.env`,
  profile overlays (`.env.tbench.<profile>`), and shell env override
  it. The npm scripts load them with `--env-file-if-exists` so
  every `process.env.X` read is already populated by the time it
  runs. Honor this and there is nothing more to do.

  The following shapes are FORBIDDEN. Each one assumes the cascade
  is unreliable, which is the same as not having a cascade.

  1. **No boot-time env validator.** `src/agent/config.js` was
     deleted on purpose. Do not reintroduce a `REQUIRED` map, a
     consolidated-error throw, or any "validate every var at module
     load" pattern. If you find yourself drafting one, you have
     already decided the cascade can't be trusted; re-read this
     section instead.
  2. **No per-module guards.** `if (!Number.isFinite(X)) throw`,
     `if (!process.env.X) throw`, `assert(X, "must be set")` next
     to a `Number(process.env.X)` read are forbidden. The cascade
     guarantees presence; the guard guarantees nothing the cascade
     doesn't already.
  3. **No fallback constants.** `Number(process.env.X) || 4`,
     `process.env.X ?? "default"`, `Number(X) || null` are
     forbidden. The default belongs in `.env.example`. If the
     cascade returns a missing value, the cascade is broken; fix
     `.env.example`, not the read site.

  **The only legitimate fix when a var read produces `undefined` /
  NaN is to declare the var in `.env.example` with a sane default.**
  Plug the hole once, where holes get plugged. Do not plug it three
  times (declaration + validator + guard + fallback). The user has
  named this anti-pattern: "belt and suspenders and elastic and
  double sided tape." The recent gemma `<search>` crash —
  `setTimeout: delay … Received NaN` — was caused by exactly one
  bug: `RUMMY_WEB_FETCH_TIMEOUT` was missing from `.env.example`.
  The instinctive plug-it-three-times response is the failure mode
  this rule exists to prevent.

  **Provider-conditional vars are the explicit exception.** API
  keys (`XAI_API_KEY`, `OPENAI_API_KEY`, `BRAVE_API_KEY`, …) and
  optional backend selectors (`RUMMY_WEB_SEARXNG_URL`,
  `RUMMY_WEB_PLAYWRIGHT_WS`, `OLLAMA_BASE_URL`, …) only matter
  when their provider is invoked. They stay as direct
  `process.env.X` reads in their plugin and may throw at first
  use when missing. They do NOT belong in `.env.example` as
  required defaults; they're commented stubs at most.

  **Feature-flag bools** (`RUMMY_NO_*`, `RUMMY_YOLO`,
  `RUMMY_DEBUG`, `RUMMY_THINK`, `RUMMY_WEB_NO_SANDBOX`) use the
  canonical `process.env.X === "1"` check — absence means off.
  Don't invent `=== "true"` variants; if you see one, normalize
  it to `=== "1"`.

  **If you are about to add code to "make sure the env is set" —
  STOP.** That is the rule's exact target. The cascade is the
  contract. Trust it. If it's broken, fix the cascade.
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
- **Model-facing error messages: state desired behavior, not enforcement
  mechanics.** The strike system, cycle detection, MAX_STRIKES, etc. are
  internal — the model figures out the pressure from accumulating entries
  in context, not from us narrating "this counts as a strike." When the
  user dictates exact wording for a model-facing message, transcribe it
  verbatim; don't pad it with rule explanations. A reminder reads as a
  directive ("Attempt to proceed to next stage."), not as a rulebook.
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
- **`reasoning_tokens` in turns table is a misleading metric.**
  Llama-server (gemma) populates `reasoning_content` via the chat
  template's split, but doesn't break out a separate
  `reasoning_tokens` counter in the OpenAI-compatible usage
  block — everything bundles into `completion_tokens`. So
  `turns.reasoning_tokens=0` does NOT mean "the model didn't
  reason." Verify reasoning capture by reading `reasoning://N`
  entry sizes (rummy.web's openaiStream captures the
  `delta.reasoning_content` chunks correctly into entries),
  not by the per-turn token counter. Earlier audit framing
  cited the counter as fix-verification; that framing is
  retracted (TBENCH_AUDIT.md retraction note 2026-04-30).
- **Parser warnings should be soft, not strikes.** Recoverable
  XML pathology (mismatched closing tag, unclosed tag with
  content captured) is exactly that: recovered. The parser fixed
  it, the turn's productive emissions survive. Counting parser
  warnings as strike-eligible (state="failed" via
  error.log.emit) punishes the model for sloppy syntax the
  framework already handled. Fix landed 2026-04-30: error.log
  takes a `soft` flag; soft entries land state="resolved" and
  skip turnErrors++. Wired only at TurnExecutor's parser-warnings
  loop. Missing-update / no-actionable-tags / dispatch crashes /
  context-exceeded all stay strike-eligible — those are real
  FCRM-compliance signals.
- **Verifier-mutation impulse is a benchmark-integrity threat
  separate from cheating-via-search.** Grok on
  `break-filter-js-from-html` (smoke 2026-04-30) emitted
  `<set known://fix/test_outputs.py>` documenting how to PATCH
  the test_outputs.py verifier — including swapping `/tests/`
  for `/app/`. The `known://` scope kept it informational, but
  if the model had emitted `<set path="test_outputs.py">` the
  current set proposal-accept gate would have allowed the
  write (file_constraints declared the test file as `add`,
  not `readonly`). Mitigated via harbor adapter excluding
  `test_*.py` / `*_test.py` / `tests/*` from the project-files find,
  so verifier source isn't ingested as entries — the model
  runs the verifier via `<sh>` to check itself, but doesn't
  see its source as something to engage with. Distinct from
  the web-search "look up the answer" risk; both want
  separate treatment in the audit writeup.
- **Tbench task containers span multiple Ubuntu base versions.**
  Surfaced by gpt2-codegolf (Ubuntu Noble 24.04, t64-renamed
  libs) vs break-filter-js-from-html (Jammy 22.04, non-t64).
  Apt package names diverge across the t64 transition. Single
  fixed install list breaks one or the other. Fix shape: split
  the install into stable names (work everywhere) + a
  t64-or-fallback chain for the renamed packages
  (libatk1.0-0t64 || libatk1.0-0, etc.). Lesson: don't assume
  homogeneous base images across a benchmark dataset; tbench
  authors compose images independently.

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

