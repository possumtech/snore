# AGENTS: Planning & Progress

> "Is there a rummy way to do this?" Every `<tag>` the model sees is a
> plugin. Every scheme is registered by its owner. Every piece of data
> exists as an entry or a column. No exceptions without documentation.

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

## Deferred

- Community debut post (Latent Space) — after benchmark validation
- Non-git file scanner fallback
