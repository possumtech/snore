# AGENTS: Lessons, Practices, Todos

> **SESSION BOOTSTRAP — READ ME FIRST.** Cross-session ground truth.
> Before touching code: read the standing rules, the "Now" block, and
> any open "Ongoing Development Conversation" entries. Cross-reference
> SPEC.md §0 for the contract and PLUGINS.md §7 for the events/filters
> surface. **This file is not a trophy room** — store lessons,
> practices, and todos. Achievement narrative belongs in git history.

> **Standing rules that override anything else:**
> - **No fallbacks outside `src/lib/hedberg/*` and `src/agent/XmlParser.js`.**
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
> - **Read `rummy_dev.db` via the digest, not via raw SQL.** Run
>   `npm run dev:digest` (writes `digest.md`, `digest.json`,
>   `reasoning.md` to `/tmp/rummy_dev_digest/`) and read the curated
>   artifacts. Direct SQL spelunking encourages half-engaged review
>   and hallucinated patterns. The same digest pipeline that powers
>   tbench analysis works on the dev DB; use it.
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

> **Instructions discipline (when touching `instructions-system.md`
> or `instructions-user.md`):**
> - **Brief.** Every token is paid every turn. Cut before expanding.
> - **Show, don't tell.** A three-line worked example beats ten
>   lines of "you must / you should".
> - **Cross-tool trade-offs.** The model's context is one zero-sum
>   pool across `<get>`, `<set>`, `<rm>`, `<search>`, `<update>`,
>   `<sh>`, `<ask_user>`. A rule that helps one can starve another.
> - **System-stable, user-static.** `instructions-system.md` (with
>   `[%TOOLS%]` / `[%TOOLDOCS%]` expansions) is the cacheable system
>   prompt — must stay byte-identical across turns within a run.
>   `instructions-user.md` renders as `<instructions>` at user
>   priority 165 (sandwich tail) — same bytes every turn, no phase
>   keying.

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
| Cross-cutting model identity / global rules | `instructions-system.md` (sacred — touched only on explicit approval) |
| Per-turn imperative reminders | `instructions-user.md` (sacred) |
| Project state, standing rules, in-flight threads | `AGENTS.md` |

Per-comment decision flow when sweeping source: says *what* → delete;
says *spec* → move to `SPEC.md` / `PLUGINS.md` / plugin README and
delete; warns about a hack/gotcha → trim to one line; duplicates the
constant name → delete.

---

## Sweep analysis (tbench + e2e + integration digests)

Both `npm run test:tbench:*` and `npm run test:e2e` auto-emit a
deterministic analysis layer at the end of the run (driven by
`test/tbench/digest.js`). Re-runnable with
`node test/tbench/digest.js <dir>` — read-only derivative of the
rummy.db / rummy.txt / verifier-reward sources, idempotent.

**Where to look:**
- `test/tbench/results/<sweep>/...` for tbench (one run per task dir)
- `/tmp/rummy_test_diag/<suite>_<ts>/...` for e2e/integration (one
  TestDb per suite; many runs per DB; per-run digests at
  `<task>/<alias>/`)

The digest tool detects single-run vs multi-run DBs automatically
and emits the appropriate layout — single-run (tbench) writes
`digest.md` directly in the task dir; multi-run (e2e) nests at
`<task>/<alias>/`.

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

**Sweep-wide artifacts** (at sweep root):

- `index.csv` — one row per task: `task,reward,status,turns,
  prompt_tokens,completion_tokens,cached_tokens,cost,wall_seconds,
  markers`. Standard triage front door.
- `errors.md` / `errors.json` — cross-task error report. Header
  counts by outcome, by task. Top signatures (recurring failures
  grouped by `outcome :: source-path-pattern :: body-prefix`) with
  compressed turn-lists and the originating action body for each.
  Per-task chronological tail with full body + source body for
  every error. When `digest.js` is invoked on a single task dir
  these land alongside the per-task artifacts instead of at sweep
  root. Use this to surface recurring patterns the per-task
  waterfall truncates (e.g., gemma26's 44× SEARCH/REPLACE retry
  against `tests/runner_test.go` turns 96-224).

**Marker taxonomy** (auto-classified, semicolon-joined in `markers`
column):

- `passed` — `reward=1`.
- `claim_success_verifier_fail` — `reward=0` AND `status=200`. The
  dominant failure pattern in the 2026-05-01 sweep.
- `max_loop_turns` — `status=499` AND turn count near
  `RUMMY_MAX_LOOP_TURNS`.
- `strike_abandon` — `status=499` AND an error body starts with
  `Abandoned after`.
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
- All runaway turns (with which turn):
  `awk -F, '/reasoning_runaway/' index.csv`
- Open one task's digest: `cat <task-dir>/digest.md`
- Reasoning on a specific turn:
  `awk '/^## Turn 8$/,/^## Turn /' <task-dir>/reasoning.md`
- Cross-task error report (preferred): read `errors.md` at sweep root.
- Cross-task error grep (fallback for ad-hoc digging):
  `grep -rh "✗ error:" */digest.md | sort | uniq -c | sort -rn`

**Output-dir control.** `test/tbench/runner.js` accepts `--out
<path>` (CLI) or `RUMMY_TBENCH_OUT_DIR` (env) to override the
default timestamped path under `test/tbench/results/`. Used for
parallel runs landing in named dirs:
`npm run test:tbench:gemma -- --out audit/gemma_1` and
`npm run test:tbench:xfast -- --out audit/xfast_1` in separate
shells. Both write their own digests and indexes.

## Now

**The contract is lean.** The engine enforces three things via the
strike system: budget overflow, repetition (cycle detection), and
per-turn `<update>` inclusion. Plus the ask-mode shield (run-mode
permission, separate concern). Everything else is the model's
responsibility, taught via the model-facing prose.

Implementation, tests, SPEC.md, AGENTS.md aligned. Lint clean.
880 unit, 245 integration, 31/31 e2e (sandwich run), 101 spec
anchors × 44 test files.

**Packet ordering — locked in (sandwich):** the user message is
ordered `<prompt>` (priority 30, front, cacheable) → dynamic state
blocks `<summary>` / `<visible>` / `<log>` / `<unknowns>` (50–150)
→ `<instructions>` (165, late so the rules sit at the action site
for recency) → `<budget>` (175, last). The system message is
unchanged — instructions-system.md + tool docs, fully cacheable
across all runs. The sandwich exists because front-loaded ordering
(instructions first for max cache) regressed `act_no_completion`
in e2e: the model lost the discipline to emit terminal `<update>`
when "YOU MUST update with status=200" was buried 3K tokens before
the action site. Sandwich restored 31/31 pass at the cost of cache
hit rate. **Why:** recency at the action site beats cache savings
when the action depends on remembering a rule. **How to apply:**
when adding a new `assembly.user` filter, slot it by purpose —
static reference (manual, quick-ref) goes near `<prompt>` for
cache; per-turn discipline reminders go near `<instructions>` for
recency; live accounting goes after `<budget>`.

**Bench environment.** Local llama-server build `b199-82209ef`
(Blackwell-targeted CUDA) on RTX 5070 Ti / 16 GB VRAM / single
slot, `n_ctx=65536`. Loaded model: **Gemma 4 26B-A4B-It** IQ4_XS,
~168 t/s generation. Sampler: temp=0.1, reasoning-budget=4096.
**Cache=0 is structural, not a bug** — Gemma 4 uses sliding-window
attention; llama.cpp's prompt-cache path doesn't support hybrid
KV state (PR #13194). Server logs `cache_reuse is not supported by
this context` at boot; every request re-processes the full prompt.
Don't treat cache rate as harness-side signal on this model.

**Open items unblocked by the cleanup:**

- Pivot terminal-bench from grok to local gemma.
- Tooldoc example weight measurement (CC-13).
- `unknown://env/...` example proposal — sacred-prompt territory; awaiting user direction.
- Sudden-death turn warning — calibration-relevant once baseline numbers exist.
- ProgramBench integration (see Open Items).

### Architectural exceptions (keep, document)

These are deliberate paradigm deviations with real justification.
None should be refactored; all should be named in PLUGINS.md so
they aren't mistaken for ceremony by the next session.

- **`hooks.instructions.resolveSystemPrompt`** — single-owner
  cache-stability concern. The system prompt is *deliberately* not
  a filter chain because multiple participants would defeat
  prefix-cache reasoning.
- **`hooks.update.resolve`** — single-owner with synchronous
  return value. Caller needs `{ summaryText, updateText }` back;
  events emit but don't return; only the update plugin knows
  terminal-vs-continuation status semantics.
- **`Entries.scheme(path)` / `Entries.normalizePath(path)` static
  imports across plugins** — pure utility statics. Routing through
  hooks would be ceremony for zero capability gain.
- **`countTokens`, `stateToStatus` utility imports** — same shape:
  stateless utility functions, fine to import.
- **CLI / RPC importing `ProjectAgent` / `RummyContext` directly**
  — these are *transport* plugins, not action plugins. Their job
  is to bridge external interfaces to the agent; the import is
  what makes them transports.

### Refactor candidates (deferred)

- **`XmlParser` extraction → parser plugin.** With a generic
  `parser.parse` hook in TurnExecutor. Multi-format input becomes
  possible (native tool-calls, JSON shapes, thinking-channel
  formats) without forking core. Drive by "do we actually need
  multi-format input?" rather than by seam pressure.
- **`file/` plugin reached by 3 other plugins** (rpc, set, cli).
  Cross-plugin direct imports, classification unclear without
  reading the file plugin's role.

### Spirit clause

Reduce complexity by manifesting ideals already described, not by
extending the architecture with new features. Each move should
make the codebase smaller and the contract crisper. If a proposed
extraction adds a hop without separating concerns, it's ceremony
— drop it.

## Open Items

- [ ] **Programbench prompt iteration — model behavior matrix
  experiment.** In flight 2026-05-06/07. Iterating on
  `test/programbench/prompt.md` (extracted to a flat file for
  collaborative editing, runner.js does `{{orientation}}` substitution
  for language/repo from task.yaml). Current prompt is the user's
  "radical refactor" with five `### YOU MUST` workflow steps:
  Draft SPEC.md → Design unit/integration/e2e tests → Modularize
  with tag interpolation → Iterate against suite → Verify clean
  compile. Single task: `tomnomnom__gron.88a6234`.

  **Matrix runs on `gron` task with the radical-refactor prompt:**

  | Model (alias) | Status | Turns | Cost | Result |
  |---|---|---|---|---|
  | grok (grok-4-1-fast-non-reasoning) | 200 | 14 | $0.06 | gate ✗ — `ParseStatements` redeclared. Hallucinated done. |
  | grokR (grok-4-1-fast-reasoning) | 200 | 16 | $0.18 | gate ✗ — `#` in Go from over-literal tag interpolation. Reasoning didn't fix self-skepticism. |
  | gfast (gemini-3.1-flash-lite-preview) | 200 | 17 | $0.05 | gate ✗ — no go.mod. Wrote SPEC.md as `known://spec/gron` (DB, not file). Used memory primitives. |
  | gemma (local macher.gguf) | 499 | 30 | $0 | strike abandon — output-budget exhaustion under 5-step volume; emitting multi-file source per turn, hit max_tokens mid-emission, never reached `<update>`. Was *operating on the real task* throughout. |
  | grok+THINK=1 | 200 | 9 | $0.035 | gate ✗. Faster, same hallucination. |
  | gfast+THINK=1 | 200 | 10 | $0.027 | gate ✗ — unused import. Same hallucination, faster. |
  | ccp (deepseek-v4-flash) | 499 | 3-5 | ~$0.002 | strike abandon ×3 runs. Emits well-formed `<get>`/`<set>` but inconsistently closes with `<update>`. Reasoning_content shows model planning task substantively without acknowledging the rejection error visible in its packet. **Knows the protocol (T2 proved it); doesn't integrate compliance with action-emission.** |
  | ibm (granite-4.1-8b) | 200 | 3 | $0.001 | gate ✗. Answered the persona's France/capital example literally — emitted "Paris". Disqualifying: can't generalize from `Example:` blocks. |
  | kimi (moonshotai/kimi-k2.6) | 499 | 16 | $0.42 | strike abandon. Most expensive run by far (30K reasoning tokens). Real artifacts produced (SPEC.md + testdata/ with 6 captured fixtures). Stalled in late turns then loop-detector fired. |
  | mmax (minimax-m2.7) | 499 | 4 | $0.007 | strike abandon. Same protocol non-adoption as ccp. |
  | qwen (qwen3.6-plus) | 499 | 6 | $0.02 | strike abandon. Has reasoning (3K tokens) but still hits protocol wall. |
  | xemma (gemma-4-31b-it via openrouter) | 200 | 80+ | $? | gate ✗ — reference binary destroyed (model copied executable AFTER first build, not before). Adopted protocol cleanly through openrouter — falsifies "openrouter is the problem." |
  | opus (anthropic/opus-4) | 200 | 60+59 phantom | $24.70 | gate ✗. Read explicit `### YOU MUST copy and perfectly reverse engineer the inspiration executable`, skipped step 1 anyway. Reference destroyed. **Orphaned-child harness bug:** parent kill left rummy-cli reparented to init, racked up 59 phantom LLM turns. Fixed (detached spawn + process-group signaling). |
  | haiku (anthropic/claude-haiku-latest) | 200 | 7 | $0.20 | gate ✗ — `declared and not used: i`. Single unused-var away from clean compile. Tier-appropriate strong showing — followed step 1, drafted SPEC.md, modularized into `cmd/`, almost passed. |
  | gemma26 (gemma-4-26b-a4b-it via openrouter) | running 54+ | $0.10 so far | running. Methodical small-step at 4B-active. Produced compile.sh + src/ + tests/, currently iterating against test failures on bracket-notation core walk logic. **Determine step in flight — the one frontier models skip.** |

  **Pattern across runs:**
  - **Verification hallucination is universal in US capable models.** grok variants + gfast variants all emit `<update status="200">` despite broken builds. THINK=1 makes them *faster*, not more self-skeptical.
  - **Protocol non-adoption clusters in non-US capable models** (ccp/mmax/qwen). Models emit beautifully structured tool calls in their *own* trained shape; rummy's `<update>` close convention isn't picked up from a single instruction read.
  - **xemma falsifies "openrouter as transport is the issue"** — Google's gemma-4-31b through openrouter adopts the protocol cleanly. The non-US protocol failure is **model-family-specific**, not transport-layer.
  - **gemma (local) is the best non-fake performer** — operates on the real task throughout, fails by capacity exhaustion under heavy prompt, not by faking compliance.

  **Two orthogonal failure axes (revised after broader sample):**

  1. **Task-oriented vs protocol-rejecting** — does the model
     adopt rummy's protocol and operate on the actual task?
  2. **Self-skeptical vs self-confident-at-verify** — does the
     model verify its work before declaring done, or trust its
     own narrative?

  Mapping the matrix:

  | Model | Task-oriented? | Self-skeptical? | Result |
  |---|---|---|---|
  | grok-fast | ✓ | ✗ | Real impl, hallucinated verify |
  | grokR | ✓ | ✗ | Real impl with bugs, hallucinated verify |
  | gfast | ✓ (partial — SPEC in DB) | ✗ | Hallucinated verify |
  | gemma | ✓ | ✓ | Capacity-bound; ran out before completing |
  | xemma | ✓ | ✓ | **Best run** — actually iterating on test failures (80+ turns) |
  | kimi | ✓ | ✗ | Stalled then strike-abandoned |
  | glm | ✓ (partial) | ? | Every-other-turn protocol gap; uses memory primitives |
  | ccp / mmax / qwen | ✗ | n/a | Never adopted protocol; emit own trained tool shape |
  | ibm/granite | n/a | n/a | Confused example with task ("Paris") |

  **grok-fast belongs in the task-oriented camp with gemma**, not
  with the protocol-rejecters. Failure mode is verification
  hallucination, separate from refusal to engage with the task.
  Cost-efficiency: $0.06 producing a near-working submission vs
  kimi's $0.42 producing strike-abandon.

  **The "task-oriented + self-skeptical" cell** (gemma + xemma) is
  the only cell that produces credible engagement. Both are gemma
  family. Both are instruction-tuned without aggressive
  tool-call-format RLHF. The hypothesis: **gemma's lineage is
  uniquely calibrated for general tool-following** rather than for
  any specific tool-call format, which keeps it amenable to
  rummy's idiosyncratic XML conventions. xemma (gemma-4-31b
  through openrouter) confirms this isn't a local-vs-cloud
  artifact — it's the model family.

  **Capable models trained on tool use have priors about tool-call
  format that compete with prompt instructions.** RLHF on
  function-calling, on Anthropic's `<tool_use>`, on OpenAI's JSON
  schema, on Gemini's structured output, on Qwen's function-call
  schema — produces strong priors that prompt-side instruction
  can't fully override. The pattern is roughly inverted-U: models
  with no tool-RLHF (small open weights) and models trained for
  *general* tool-following (gemma family) sit at the bottom and
  top of the curve respectively, both amenable to rummy. The
  middle (specifically tool-RLHF'd models like Qwen, DeepSeek,
  Minimax) defects to its trained shape and rejects rummy's.

  **In-bounds prompt has hit its ceiling.** Out-of-bounds (per
  AGENTS.md "Benchmark integrity") would be runner-level enforcement:
  refuse-to-tar without a clean compile, or loop-on-fail with stderr
  fed back. Both crossing the line we set. Also out-of-bounds: a
  per-model protocol-adaptation layer in `rummy.web` translating
  rummy's protocol to/from each model's trained tool-call shape.

  **Files in flight:**
  - `test/programbench/prompt.md` — collaboratively-edited prompt
  - `test/programbench/runner.js` — substitutes `{{orientation}}`
  - `.env`'s `RUMMY_MODEL_*` aliases name the matrix participants

  **Forensic target for next session:** xemma's 80+-turn run dir
  (`test/programbench/results/2026-05-07T03-51-59/`) regardless of
  where it ends up. Real iterate-against-tests workflow execution.
  Look at: how the test-fix loop actually worked turn-by-turn,
  what triggered the runner_test.go compilation issue, what the
  agent did to recover, whether memory primitives were used,
  total token economy. This is the richest dataset in the matrix.

  **Hypothesis for next prompt iteration: scale-specification
  over process-prescription.** The current heavy "YOU MUST do X"
  prompt reads as a checklist to capable models — they produce a
  token of each step and tick the boxes. Replacing process
  instructions with scale anchors might force the model to
  *infer* what "enough work" looks like rather than satisfying
  a checklist:

  - Process: "YOU MUST design unit, integration, and e2e tests"
    → model writes one of each, declares done
  - Scale: "The eval runs ~200 behavioral tests across every
    documented flag/mode/option. Real CLI tools at this caliber
    expose 10-15 flags; submissions that handle only the happy
    path fail systematically." → model has to figure out what
    200-behavior coverage looks like, which is harder to satisfy
    with token effort

  Sketch (~150 words vs current ~400):

  ```
  We're reproducing this program from scratch. The compiled
  binary `./executable` is the reference; you have its docs but
  cannot read its bytes.

  The eval rebuilds your submission via
  `chmod +x ./compile.sh && ./compile.sh` from a clean
  container, then runs ~200 behavioral tests against the
  resulting binary. Tests cover every flag, mode, and option
  the documentation names.

  Real CLI tools at this caliber expose 10–15 flags.
  Submissions that implement only the happy path fail every
  test that exercises a flag they don't.

  You have whatever process you choose. The deliverable is
  `./compile.sh` plus source files that produce a binary
  matching the reference's observable behavior across the full
  documented surface.
  ```

  Tradeoff: less guarantee weaker models pick a sensible
  workflow. But heavy process prescription didn't produce
  sensible workflow either — most models satisfied the form
  without the substance. Worth A/B'ing: same matrix, two prompt
  variants, see which spread of outcomes is more useful.

  **State 2026-05-07 morning:**
  - Gemma family thesis confirmed at 4B-active. Gemma26 produces
    real artifacts and iterates against tests at $0.10 / 50+ turns.
    Protocol functions as bricklayer's scaffold for small-active-
    parameter models — they can't outrun their working memory, so
    the rails are infrastructure they actually use.
  - **Frontier-model failure is discipline-bounded, not capability-
    bounded.** Opus on the same task: $24.70 / 60+ turns / no clean
    artifact. Read explicit YOU MUST instructions and skipped step 1
    anyway. The synthesize-and-ship RLHF prior dominates surface
    persona/prompt strengthening.
  - The frontier-paid hypothesis (Gemini Pro / Opus as plausible
    high performers) was wrong for opus. Gemini Pro untested.
  - Grok family owes partial apology — task-oriented in the gemma
    cluster, just bound by verification hallucination.

  **Path forward:** engine-side rails (see Open Items below).
  Surface prompt-strengthening hit ceiling; discipline must be
  enforced through existing strike + entries machinery, not
  through stronger pleading.

- [ ] **Forensic investigation: programbench 1298-error matrix → solution grind.**
  Forensic source: `errors.md` / `errors.json` at the sweep root,
  produced by `digest.js` (extended 2026-05-07 to emit cross-task
  error report + handle programbench's `rummy_programbench.db`).
  Corpus: 43 programbench gron runs across 2026-05-06/07, 1298
  total errors (273 strike, 1025 soft). Distribution:

  | Outcome | Count | Class |
  |---|---|---|
  | `not_found` | 687 | tooldoc gap |
  | `conflict` | 197 | tooldoc + engine |
  | `status:422` | 125 | engine (parser-swallow) |
  | `unparsed` | 105 | engine + persona |
  | `exit:127` | 60 | (cmd not installed; out of scope) |
  | `validation` | 36 | (per-plugin; not yet investigated) |
  | other | 88 | tail |

  **Findings + solutions to grind. Status legend: tooldoc / engine / mixed.**

  - **CC-14 — Glob-on-`<set>` `not_found` (~673).** Models emit
    `<set path="log://turn_N/*"/>`, `sh://turn_N/**`,
    `env://turn_*"` trying to bulk-demote past-turn artifacts.
    `<get>` and `<rm>` support globs (per their tooldoc examples);
    `<set>` does not. Models infer the natural extension and the
    harness rejects. Concrete shape (gemma 5/6 T9):
    `<set path="env://turn_[2-5]/**" visibility="archived"/>` + 4
    siblings. The model is doing exactly what the
    `<set visibility="archived"/>` tooldoc tells it to (per
    `rmDoc.md` "Prefer `<set path="..." visibility="archived"/>`
    to preserve for later retrieval"); the grammar gap is that
    metadata-only `<set>` should fan out across the glob like
    `<rm>` does. Fix is paradigm-aligned: extend `<set>` to fan
    out on globs when the operation is metadata-only (visibility,
    tags, summary). Body-write `<set>` with a glob remains an
    error (no body fan-out semantics). **mixed:** engine extension
    + tooldoc reinforcement of "one-path or glob with metadata-
    only" once the engine supports it.

  - **CC-15 — Multi-path-in-attr `not_found` (~22).** Model sends
    `"README.mkd ADVANCED.mkd LICENSE"` as a single path attr.
    Tooldoc example reinforcing one-path-per-tag. **tooldoc.**

  - **CC-17 — SEARCH/REPLACE retry-without-refetch (~196).** When
    SEARCH text doesn't match the current entry body, conflict
    error echoes the failing patch back — useless feedback. Model
    retries verbatim. Combined file (105) and `known://` (91 — all
    on `known://plan`) cases share the same root cause: model's
    SEARCH text uses an old version of the body. The model is
    using SEARCH/REPLACE to update the plan as work progresses,
    but the plan keeps drifting and the SEARCH text drifts behind.
    Gemma26 ceiling case: 44× same patch turns 96-224 against
    `tests/runner_test.go`. File sub-pattern: `./main.go` vs
    `main.go` path-form split (24+12 occurrences) — verify
    `Entries.normalizePath` strips leading `./` for file-scheme.
    **mixed:** tooldoc edit (read current first) + engine fix
    via EN-3 (conflict body includes the current entry body so
    the model can author a delta).

  - **CC-18 — Unparsed HTML-comment thinking (~17).** Models use
    `<!-- ... -->` as alt-think channel. Fix: think-plugin
    absorb-or-filter `<!--` (already does so for `<think>`); or
    tooldoc points at `<think>` as the answer. **mixed.**

  - **EN-1 — 422 verdict misleads when parser swallows `<update>`
    (load-bearing).** When `<set>` containing SEARCH/REPLACE is
    malformed (missing `<<<<<<< SEARCH` head OR missing `</set>`
    tail), XmlParser absorbs every following tag — including
    `<update>` — as nested body. The 422 fires "no <update>
    emitted" but the model emitted one; the parser can't see it.
    Confirmed at packet level on 5/6 14:39 T9: malformed second
    `<set known://plan>` with no `</set>` swallowed `<sh>` and
    `<update status="102">` at end-of-stream. Two paths:
    (a) parser closes parent at next sibling-shaped top-level
    tag; (b) verdict body changes to "Unclosed `<set>` swallowed
    your `<update>` — check SEARCH/REPLACE markers and `</set>`"
    so model gets accurate feedback. Per
    `feedback_no_specificity_to_model`: prefer (a) — fix the
    parser, don't paper over with verbose error prose.
    **engine.** Highest-leverage fix in the dataset.

  - **EN-3 — Conflict feedback verbosity.** Conflict error body
    should include the current entry body context, not just echo
    the failing patch. SEARCH/REPLACE conflict on a file: 20-line
    window around where SEARCH text fuzzy-matches (or full file
    if small). Conflict on a non-file scheme entry (`known://`,
    `unknown://`): include current entry body so the model can
    author a delta. Closes the loop for CC-17 (both file and
    scheme variants). **engine.**

  **Out of scope (do not address here):**

  - Mode-collapse degenerate sampling (e.g., 130k-char loop of
    `setPath,main,...` filling completion budget). Sampler escape
    on small models; not a harness concern.
  - Mid-emission truncation by completion-tokens budget — already
    tracked separately as "Single-turn budget escape" below.
  - `exit:127` errors — agent calling commands not installed in
    container; benchmark-task-specific, not harness.
  - **Discipline rails for prose-only / zero-emission turns
    (~85 unparsed prose errors).** Capable models (Claude family
    especially) fall out of tag-discipline under stress. Tempting
    to add a zero-emission strike, but per
    `feedback_protocol_over_enforcement`: strikes catch repeated
    failures, they don't reform models that have structural
    resistance to the protocol. Open philosophical question
    (also frames the existing knowns/unknowns lifecycle strikes
    item below): does *any* engine-side rail close the discipline
    gap, or does it just abandon the resistant model faster?
    Defer pending data. Don't grind here.

  **Grind order:**

  1. EN-1 — parser tail-recovery for unclosed tag bodies. **DONE
     2026-05-07** (`src/agent/XmlParser.js`). Recovers trailing
     well-formed tool calls after a botched close, so the verdict
     layer sees the model's `<update>` instead of swallowing it.
  2. EN-3 — conflict error body includes current entry body and
     the attempted merge. **DONE 2026-05-07** (`src/plugins/set/set.js`).
     Closes the SEARCH/REPLACE retry-without-refetch loop.
  3. CC-17 path-form split — `./main.go` vs `main.go`. **DONE
     2026-05-07** (`src/agent/Entries.js#normalizePath` strips
     leading `./` on bare file paths).
  4. CC-14 — sh/env entry slug pollution by `./` segments.
     **DONE 2026-05-07** (`src/sql/functions/slugify.js` drops
     `.` and `..` segments). Diagnosis revised: not a fan-out
     gap (`<set>` already fans out via `getEntriesByPattern` for
     metadata-only ops); root cause was slug paths like
     `sh://turn_N/./executable_--help` that picomatch globs
     can't cross. Future entries slug clean.
  5. CC-15 — one-path-per-tag reinforcement in `getDoc.md`.
     **DONE 2026-05-07** (one example + comment line). CC-18
     (HTML-comment thinking, ~17 errors) declined: the soft
     unparsed turns are already caught by the existing missing-
     `<update>` path; teaching against them would spend tokens
     on a behavior the engine already handles.

- [ ] **Engine-side rails: knowns/unknowns lifecycle strikes — DESIGN.**
  (Note: under philosophical question per the Out-of-scope rails
  block above. Defer pending data on whether *any* engine-side rail
  closes the discipline gap.) Three deterministic checks against
  existing entries infrastructure — lifecycle-only, never content
  judgment:

  1. **Turn 1 must create unknowns.** No entries at any visibility
     → strike "Unknowns must be defined." Protocol expects
     discovery-first; absence is wrong setup.
  2. **Attempted status=200 with no knowns at any visibility** →
     strike "Knowns must be distilled from Unknowns before
     Completion."
  3. **Attempted status=200 with unknowns still at visible
     fidelity** → strike "Unknowns must be resolved and demoted
     before Completion."

  One strike per turn (existing machinery). Multiple striking
  errors stack on the attempt; earliest-violation message wins so
  the model gets walked through the protocol in order. Rules 2/3
  fire before the 200 lands — the strike is on the attempt, not
  after the run terminates.

  **Why paradigm-aligned, not accretion:** uses existing
  knowns/unknowns infrastructure + existing strike machinery. No
  new tags, no new rules in the prompt, no thou-shalt accretion.
  The discipline-pressure compartmentalizes to one load-bearing
  decision (knowns/unknowns) and one transition (completion). The
  rest of the protocol cascades from there.

  **Validation experiment:** opus-with-rails on the same gron
  task, compared against opus's $24.70/no-artifact baseline. Tells
  us whether the rails close the discipline gap or whether the
  synthesize-and-ship prior breaks through. Defer implementation
  until current gemma26 baseline run completes (data cleanliness).

  **Open implementation questions:**
  - Where does the 200-validation actually live? Need to scope
    before writing.
  - Calibration risk: too-tight strikes corner opus into gemma26-
    style mode-collapse (high protocol fidelity, low artifact).
    Triggers must fire on *handling* (sequence, demotion proof,
    premature resolution), not on *content*.

- [ ] **ProgramBench sweep readiness.** Integration mirrors
  mini-swe-agent's reference: agent runs on host, every `<sh>` is
  proxied via `docker exec` into a per-task cleanroom container with
  `--network=none`, bind-mount `host_workspace ↔ /workspace` keeps
  host file ops in sync with the container view. Per AGENTS.md
  "Benchmark integrity": no benchmark-specific prompts, no behavioral
  coaching — task prompt is structurally aligned to the SWE-bench
  reference (`test/programbench/runner.js buildPrompt()`).

  **Runbook — single-task run:**
  ```
  npm run test:programbench -- --task tomnomnom__gron.88a6234 --model grok
  ```
  - Slug accepts either `__` (canonical / programbench data form) or
    `_1776_` (Docker form); runner normalizes both. Pass canonical for
    readability — it matches programbench's data dir and instance ids.
  - `--model grok` resolves via `.env`'s `RUMMY_MODEL_grok` →
    `xai/grok-4-1-fast-non-reasoning`. `RUMMY_PROGRAMBENCH_MODEL` env
    overrides default; default is `grok`.
  - Runner reads `task.yaml` (`programbench/data/tasks/<id>/task.yaml`)
    and surfaces `language` + `repository` to the agent's prompt so it
    knows the target language and upstream repo.
  - Project files default to git-tracked workspace contents (no
    whitelist override). Cleanroom workspaces typically commit their
    docs to a stub `.git`; the executable stays untracked + `0o111`
    unreadable, so it's invisible to the agent's read tools.
  - The runner does not pre-judge the submission. Whatever the agent
    leaves at `<task>/workspace/` is tarred verbatim into
    `submission.tar.gz` and goes straight to `programbench eval` for
    verdict. The agent's self-reported terminal status is captured in
    the run audit, not used as a gate. Hallucinated completions land
    in the eval as 0-score data points — that's the measurement, not
    a failure mode to filter out.
  - Eval (separate step, runs the test suite):
    ```
    npm run test:programbench:eval -- results/<run-id>/
    ```
    Path is relative to `test/programbench/` (script `cd`s in).
    Output: `<run-id>/<instance>/<instance>.eval.json` per submission.

  **Layout** — matches upstream usage guide
  (`<run-root>/<instance_id>/submission.tar.gz`):
  ```
  results/<timestamp>/
    <instance_id>/
      submission.tar.gz   ← what programbench eval ingests
      workspace/          ← scratch project root (admin)
      agent/              ← rummy_programbench.db (audit/replay)
  ```

  **Before any sweep:**
  - [ ] Per-profile env files: `.env.programbench`,
    `.env.programbench.gemma`, `.env.programbench.xfast` (currently
    reuses `.env.tbench` — sloppy coupling)
  - [ ] Sweep driver `test/programbench/sweep.js`: iterates task
    list, spawns runner.js per task, isolates per-task failures,
    supports same-folder skip-completed for resume
  - [ ] Pre-pull all ~200 cleanroom images (broadband-bound, runs
    once before sweeping)
  - [ ] First gemma sweep on full task set with eval; sanity-check
    against published baselines before announcing anything

  **Post-sweep (parallel runs of gemma + xfast):**
  - [ ] xfast profile uses xAI endpoint (different upstream from
    gemma's local llama-server, so true parallelism — concurrency
    matches each upstream's parallelism, not affected by cost)
  - [ ] Sweep dirs separated by profile + invocation; never mixed

- [ ] **Cache eviction anomaly with sandwich ordering.** Sandwich
  e2e showed cache hitting only on turn 2 of multi-turn runs —
  turns 3+ report `cached=0` despite system+prompt being
  byte-identical across all turns. Aggregate hit rate dropped
  from 61.4% (front-loaded) to 14.9% (sandwich) — much larger
  than the design predicts (~400 tokens/turn delta vs observed
  ~1900 tokens/turn delta). Possibly llama-server's `cache_reuse`
  threshold giving up when the cacheable prefix is shorter
  (~1900 tok system+prompt vs ~2400 tok system+instructions+prompt
  in front-loaded). Investigate via `/props` for `cache_reuse`
  setting, slot state across turns, or whether some other request
  (proposal handshake? telemetry?) is hitting the slot mid-run
  and evicting. Not blocking ProgramBench — but if recoverable,
  could nearly 4x effective cache.

- [ ] **Single-turn budget escape.** A run was observed sending
  ~2.3× the configured budget cap in a single turn. Two candidate
  causes, exactly one true:
  1. **Token-counter divergence.** `countTokens(body) = length /
     RUMMY_TOKEN_DIVISOR` undercounts vs the upstream tokenizer
     for content that's binary/JSON/code-heavy. Budget enforcement
     thought it was capping at N; actual tokenization came in
     above.
  2. **Budget-enforcement escape path.** Content gets added to the
     assembled packet *after* the `turn.beforeDispatch` filter chain
     runs (system prompt assembly, post-enforcement plugin filters,
     `assembly.user` 175-priority inserts). Enforce caps at N;
     downstream insertion blows past it.

  Triage: replay the turn, compare `countTokens` to provider's
  reported count for the loaded body. Whichever diverges identifies
  the bug.

## Scope Discipline

- No legacy protocol accommodation. 2.0 is 2.0.
- External plugins are rewritten or cut. No side-maintenance tracks.
- Everything the contract names has a concrete realization in code.
  Everything the contract doesn't name, isn't there.

## Lessons (keep these pinned; don't let future sessions forget)

- **`log://` body is immutable to the model.** A model that learned
  the demote pattern from instructions-user.md
  (`<set path="X" visibility="summarized"/>`) will sometimes adapt it
  with a body line — destroying historical search results / sh output
  / etc. The `<set>` handler now rejects `<set path="log://..."` with
  non-empty body as `method_not_allowed` (terse 405 in the entry's
  outcome), surfacing a one-line nudge that points at the body-less
  shape. Visibility/metadata-only writes still flow through normally.
  Reasoning: log entries are time-indexed records of what happened —
  the model can re-rank them but not rewrite history. This is the
  one place where the engine polices the model's grammar; it earns
  its keep because the alternative is silent destruction of the
  reasoning trace.
- **System-prompt growth eats budget. Calibrate test ceilings when
  you grow it.** When instructions-system.md or `[%TOOLDOCS%]`
  expansion grows, every test that pins `contextLimit` near the
  rendered system size starts overflowing on turn 1 before the model
  has done any work. The `tight-context` story regressed exactly this
  way — system://1 hit ~3851 tok, leaving <1600 tok for everything
  else against a 5400 ceiling. Fix is to bump the test's
  `contextLimit` minimally (just over the natural turn-3 packet
  growth ~6065 tok → contextLimit 7000 → ceiling 6300). Bigger fix is
  "teach more with less" — but that's a separate pass.

- **The contract is lean.** The engine enforces three things via
  the strike system: budget overflow, repetition (cycle detection),
  and per-turn `<update>` inclusion. Plus the ask-mode shield (run
  permissions, separate from workflow). Everything else is the
  model's responsibility, taught via `instructions-system.md`,
  `instructions-user.md`, and tooldocs. Don't add engine-side
  enforcement to police model workflow — it gets re-imagined as
  fixed-shape choreography that the model misreads as exclusive
  permissions, and weak models bounce off it instead of doing work.
- **`source .xai.key` before any xAI-touching launch.** Claude's
  Bash subshells inherit a stale `XAI_API_KEY` from a pre-fix shell
  session; `.bashrc` fix doesn't propagate to existing subshells.
  Symptom: every turn dies at 500 with `400 Incorrect API key`.
  `.xai.key` is a one-line `export XAI_API_KEY="..."` the user
  maintains for this. Don't parse `.env` manually — quoted values
  get mangled.
- **Plugin extensibility is a promise.** Don't delete "unused"
  events from `Hooks.js` — they're the extension surface.
- **Instruction prose is a four-register grammar. Respect it.**
  Every line is paid every turn — treat as load-bearing.
  - **`YOU MUST` / `YOU MUST NOT`** — contract floor. Reserve for
    actual contracts; overuse devalues. Pair with `Example:`.
  - **`*` bullets** — affordances ("you can"). Insufficient for
    contracts.
  - **`Example: <tag/>`** — highest signal density. Models
    pattern-match examples over prose; if they conflict, the
    example wins. Bad examples poison.
  - **`{ ... }`** — placeholder semantics inside Example:.
    Description inside the braces does the work.

  Failure-mode signals: `YOU MUST` everywhere → ignored. Examples
  contradicting prose → example wins. Lazy taxonomies in examples
  (`known://temp_*`, `known://hydrology/*`) → model imitates
  literally; use hierarchical paths
  (`known://geography/indiana/orange_county/*`). Cross-doc
  repetition of the same rule is reinforcement; same rule restated
  in different words within one doc is dilution.

- **Configuration is the cascade.** `.env.example` declares every
  var with a sane default; `.env` and profile overlays
  (`.env.tbench.<profile>`) override; shell wins. npm scripts load
  via `--env-file-if-exists`. **Forbidden:** boot-time validators,
  per-module guards (`if (!process.env.X) throw`), fallback
  constants (`Number(X) || 4`, `?? "default"`). When a read
  produces undefined/NaN, the fix is `.env.example`, not the read
  site. **Exceptions:** provider API keys (`XAI_API_KEY`,
  `OPENAI_API_KEY`) and optional backend selectors stay as direct
  reads, throw at first use. Feature-flag bools use
  `process.env.X === "1"` exactly — never `=== "true"`.

- **Decide, don't dawdle.** When naming or scope questions arise,
  resolve them in-session or ask the user — don't defer to a
  "follow-up pass" that never happens.
- **OpenRouter cache state is unreliable.** Routing flips mid-
  session (`is_byok: false → true`); cache hit can drop 99→2%
  across the flip on bit-identical prefix. For latency/caching
  analysis route direct (`xai/grok-4-1-fast-reasoning`); reserve
  OpenRouter for leaderboard-comparison runs where matching the
  leaderboard's upstream matters.
- **Cost under BYOK.** OpenRouter `usage.cost` reads 0 when BYOK
  — real spend is in `usage.cost_details.upstream_inference_cost`.
  Telemetry uses that as fallback.
- **Model-facing messages state desired behavior, not enforcement
  mechanics.** Strike system / cycle detection / MAX_STRIKES are
  internal — the model figures out pressure from accumulating
  entries, not from narration. Reminders read as directives, not
  rulebooks. When the user dictates wording, transcribe verbatim.
- **Attribute semantics must not split on context.** `visibility=`
  on a state tag (`<known>`) vs an action tag (`<set>` in `<log>`)
  must mean the same thing — otherwise the model re-emits actions
  to "fix" phantom state.
- **Time-indexed vs topic-indexed paths.** Log entries are time-
  indexed (path encodes turn). State entries (knowns, files,
  unknowns) are topic-indexed (path encodes identity, turn is
  metadata). If identity is WHEN, turn goes in the path; if WHAT,
  turn is an attribute.
- **Malformed XML from the model = audit our examples first.**
  Models reproduce what they see. "Unclosed `<set>`" / "wrong
  attribute name" has often been a typo or unbalanced tag in our
  own instruction examples.
- **Unknown spamming is real.** Weak models emit 90+ visible
  unknowns up front on fact-heavy ingest, then grind. Front-loaded
  over-decomposition is a failure mode, not a baseline.
- **Prompt smell trumps "flaky model."** When a small model
  misbehaves, verify the prompt isn't asking it to violate a
  documented rule (e.g., "run `ls` via `<sh>`" against shDoc's
  "use `<env>` for read-only"). The "model is flaky" framing is
  usually a prompt audit failure.
- **Reasoning-runaway is a model pathology.** Small models spiral
  inside `reasoning_content` — same action planned forever, no
  emission. No instruction edit reaches the stuck state; the
  strike-streak watchdog handles it. Don't coach for the runaway
  state — analyze the turn *before* the spiral.
- **Stochastic agentic tests should accept the engine's terminal
  set, not just success.** Identical prompts on identical models
  can land 200 or 499 depending on the decision tree the model
  walks. A test asserting strict 200 on an agentic run is flaky by
  construction. Either widen the assertion to `[200, 499]` (or
  whichever set is legitimate for the test's intent) or move the
  test to `test/live/` where stricter outcome verification is the
  whole point. The engine guarantees terminal reachability, not
  deterministic success.
- **Output inside an input-shaped tag gets reproduced as input.**
  When a log entry's wrapper matches the model's tool-call tag
  (`<search>` etc.), the body must lead with a marker the model
  won't emit as a tool — markdown bullets work. Don't render
  search results as `URL — title` lines under `<search>`; render
  as `* URL — title`.
- **State transitions don't mint new entry ids.** `since:
  lastSeen` filters miss state changes (resolved → proposed
  rewrites the row in place). Any client tracking state via
  `since: id` needs full-scan + dedupe via resolved-set, not
  optimization-by-id-watermark.
- **Multi-stage view carve-outs must mirror at every stage.** A
  carve-out at the visibility CTE without one at the
  body-projection CTE preserves the row but zeros the body
  silently — strictly worse than no carve-out. Pin with
  integration tests at every layer.
- **Block ordering is a cache-vs-recency trade.** User message
  current order (sandwich): `<prompt>` (30, front, cacheable
  across turns of a run) → dynamic state `<summary>` /
  `<visible>` / `<log>` / `<unknowns>` (50–150) → `<instructions>`
  (165, late so rules sit at the action site) → `<budget>` (175,
  last). Front-loaded ordering (instructions+prompt at front)
  cached more (~61% vs ~15%) but lost discipline tests in e2e —
  the model forgot to emit terminal `<update>` when the rule was
  3K tokens upstream of the action. Don't reorder priorities
  without considering both effects.
- **Read the wire body, not the config.** Provider plugins once
  hardcoded `think: true` / `include_reasoning: true` while a
  config knob suggested otherwise. Symptom: "gemma
  reasoning-runaway." The harness bug hid behind a model-pathology
  story for weeks. When a model exhibits a documented pathology,
  read the actual outgoing request body before classifying.
- **Gemma emits `<think>` we never advertised.** Deep CoT
  training prior; emits `<think>...</think>` regardless of whether
  the harness advertises it. The think plugin absorbs it
  gracefully (scheme always registered, handler conditional on
  `RUMMY_THINK`, reasoning-merge filter folds bodies into
  reasoning_content). Mitigations are model-side
  (chat-template / sampler / stop-token / variant swap) — not
  harness-side.
- **`turns.reasoning_tokens=0` is not "no reasoning."** Llama-server
  bundles reasoning into `completion_tokens` rather than splitting.
  Verify reasoning capture via `reasoning://N` entry sizes, not
  the per-turn counter.
- **Parser warnings are soft, not strikes.** Recoverable XML
  pathology that the parser handled doesn't penalize. `error.log`
  takes a `soft` flag; soft entries land `resolved` and skip
  `turnErrors++`. Missing-update / no-actionable-tags / dispatch
  crashes / context-exceeded stay strike-eligible.
- **Verifier-mutation impulse is a real benchmark-integrity
  threat.** Models can emit `<set>` against test files documenting
  how to patch the verifier. Tbench harbor adapter excludes
  `test_*.py` / `*_test.py` / `tests/*` from project-files ingest;
  the verifier is run via `<sh>` but its source isn't an entry the
  model engages with. Mirror this carve-out for any benchmark
  where the agent has filesystem write access to test code.
- **Detached spawn + process-group signaling for runner-side child
  management.** Spawn without `detached: true` plus a parent kill
  leaves the child reparented to init, where it continues making
  LLM calls invisibly. Cost the user $24.70 on opus (60 expected
  turns + 59 phantom turns post-kill). Fix: spawn with
  `detached: true`, install SIGTERM/SIGINT propagators on the
  runner that signal `-child.pid` (process group), with 5s SIGKILL
  escalation. Apply this pattern anywhere a node script spawns
  long-running children that the user might Ctrl-C. The earlier
  watchdog only handled container-disappears; orphaned-child was
  the missing half. (`test/programbench/runner.js`, 2026-05-07.)

- **Frontier models including opus default to one-shot synthesis
  even with explicit `YOU MUST` instructions.** Capability does
  not equal result. The protocol's job is to prevent any model
  from outrunning its own working memory; frontier models think
  they don't need it; the data says they do. A 4B-active model
  obeying the rails out-executes opus on the same task at 1/240th
  the cost. This is why engine-side rails matter more than prompt
  strengthening — surface persona ("you are the rule-follower
  mayor of FollowsRulesville") doesn't override the synthesize-
  and-ship RLHF prior. Build forcing functions, don't write
  stronger prose.

- **Benchmark task containers are heterogeneous.** Tbench: tasks
  span Ubuntu Jammy (22.04) and Noble (24.04, t64-renamed libs).
  Apt package names diverge across the t64 transition. Use stable
  names + `pkg-t64 || pkg` fallback chains. Don't assume
  homogeneous base images across a benchmark dataset.

## Ongoing Development Conversation (ALERT: LLM APPEND CONVERSATIONAL FEEDBACK HERE)

*Append entries here only when there's an actually-ongoing
conversation worth tracking across sessions (an in-flight refactor
mid-stream, a deferred decision with a real follow-up, a debugging
thread that hasn't resolved). Landed work belongs in git history;
durable rules belong in the standing rules block above; durable
observations belong in the Lessons section. Don't chronicle what
the diff already records.*

### Instruction-side findings (gathering for a focused session)

Sacred prompts (`instructions-system.md`, `instructions-user.md`,
`*Doc.md`) get edited together in a single deliberate pass, never
piecemeal. Append issues here; when saturated, request explicit
go for a focused instruction-edit session.

- **CC-8a — Reasoning-vs-emission gap.** Model plans actions in
  `reasoning_content`, doesn't emit them. Cross-test pattern.
- **CC-12a — `sh`/`env` MUST-clause repetition.** 6 negatives for
  2 binary distinctions; tooldoc cleanup.
- **PF-2 — Persona_fork run start** doesn't recognize
  fork-inherited knowns; weak models confabulate new unknowns.
- **`<summary>` / `<visible>` packet split.** Tooldocs need to
  teach the working-memory model: summary lines live in
  `<summary>` (identity-keyed map); full bodies live in
  `<visible>` (current working set). Promote/demote moves entries
  between them.

