# RUMMY: Architecture Specification

This document is the authoritative reference for Rummy's design. The system prompt
files (`system.ask.md`, `system.act.md`) define model-facing behavior. This document
defines everything else: data model, protocol, context management, and testing.

---

## 1. State Scopes

All persistent state belongs to exactly one of three scopes.

| Scope       | Lifetime                        | Contains                                          |
|-------------|----------------------------------|---------------------------------------------------|
| **Project** | Until deleted or re-indexed      | File index, symbols, references, git state, client promotions |
| **Run**     | Open-ended (one conversation)    | Agent promotions, turns, findings, attention decay |
| **Turn**    | Single LLM request/response      | Editor promotions (buffer sync)                   |

### 1.1 Project Scope

The project represents the codebase. Data here is expensive to compute (treesitter
parsing, ctags extraction, git status) and shared across all runs.

- `repo_map_files` — file metadata (path, hash, size, symbol_tokens)
- `repo_map_tags` — symbol definitions extracted by ctags
- `repo_map_references` — symbol cross-references for heat calculation
- `client_promotions` — client focus decisions, stored by path (no FK to file index)

Client promotions are project-scoped declarations of intent. They reference files
by path, not by file ID — a file does not need to be git-tracked or indexed to be
activated. When a user `activate`s a file, that file is read from disk at render
time and included in every run.

### 1.2 Run Scope

A run is a single conversation. Each run has its own independent agent promotion
state. A file `<read>` in one run is not visible in another.

- `file_promotions` where `source = 'agent'` — model focus, scoped to `run_id`
- `turns` — the conversation history
- `findings_diffs`, `findings_commands`, `findings_notifications` — proposed actions
- Attention tracking (`last_attention_turn` on agent promotion records)

### 1.3 Turn Scope

Editor promotions are transient. They represent which files are open in the IDE
right now and are cleared and re-synced every turn via `projectBufferFiles`.

- `file_promotions` where `source = 'editor'` — reset each turn

---

## 2. Visibility & Fidelity Model

Rummy controls what the model sees through two orthogonal axes: **promotion**
(who put this file in context?) and **fidelity** (what level of detail does the
model receive?). Promotion is stored. Fidelity is derived at render time.

### 2.1 Promotion

A promotion is a record that a file was placed into context by a specific source.
Two separate tables store promotions based on their nature:

- **`client_promotions`** — stored by project + path. No dependency on the file index.
  The client declares intent about a path; the file is read from disk at render time.
- **`file_promotions`** — stored by file_id (FK to `repo_map_files`). Used by
  agent and editor sources which reference indexed files.

| Source   | Table | Set by                   | Scope   | Lifecycle                              |
|----------|-------|--------------------------|---------|----------------------------------------|
| `client` | `client_promotions` | Client RPC (`activate`, `readOnly`, `ignore`) | Project | Persistent until client changes it |
| `agent`  | `file_promotions` | Model `<read>` tag       | Run     | Persistent within run, removed by decay or `<drop>` |
| `editor` | `file_promotions` | Buffer sync (`projectBufferFiles`) | Turn | Transient — cleared and re-synced each turn |

**Client promotions** carry a constraint that determines fidelity:

| Client constraint | Meaning |
|---|---|
| `full` | Full source, editable (`activate`) |
| `full:readonly` | Full source, not editable (`readOnly`) |
| `excluded` | Invisible to model (`ignore`) |

Client promotions work on any file path — the file does not need to be git-tracked
or pre-indexed. Untracked files are read from disk at render time.

**Agent promotions** carry no constraint. Fidelity is derived from context
(see §2.3). Agent promotions track `last_attention_turn` for decay.
Agent promotions are scoped to a `run_id` — they do not leak across runs.

**Editor promotions** carry no constraint. They always resolve to `full:readonly`.

**`drop` RPC** removes the client promotion from the project. The file reverts to
its baseline (agent/editor promotions may still apply).

### 2.2 Fidelity Levels

Fidelity is never stored. It is computed by `renderPerspective()` each turn.

| Level          | Content in context      | Model can edit? |
|----------------|-------------------------|-----------------|
| `full`         | Complete source         | Yes             |
| `full:readonly`| Complete source         | No              |
| `signatures`   | Symbols/signatures only | No              |
| `path`         | File path exists        | No              |
| `excluded`     | Invisible               | No              |

### 2.3 Fidelity Derivation Rules

At render time, all three scopes are merged. Evaluated top-to-bottom, first match wins.

1. **Client `excluded`** → `excluded`. Nothing overrides this.
2. **Client `full:readonly`** → `full:readonly`. Agent `<read>` cannot escalate
   past a client read-only constraint.
3. **Client `full`** → `full`. Immune to decay.
4. **Agent promotion (this run), within decay window** → `full`. The model `<read>`
   a file to work with it and is still actively referencing it. Editable unless
   rule 2 applies.
5. **Agent promotion (this run), outside decay window** → promotion is **removed**.
   The file reverts to its unpromoted state as if never `<read>`.
6. **Editor promotion** → `full:readonly`. IDE has the file open. Always full
   source, never editable.
7. **No promotion, symbols extracted** → `signatures`.
8. **No promotion, no symbols or budget exhausted** → `path`.

### 2.4 Attention Decay

Decay is the mechanism by which agent-promoted files lose their promotion when
the model stops referencing them.

- Each turn, the server scans the model's output (content, reasoning, known) for
  words matching file paths or symbol names.
- Any match updates `last_attention_turn` on the agent promotion record.
- When `current_turn - last_attention_turn > RUMMY_DECAY_THRESHOLD`, the agent
  promotion is deleted. The file reverts to its unpromoted baseline.
- `RUMMY_DECAY_THRESHOLD` is defined in `.env` (default: 12 turns).
- Decay only affects agent promotions. Client and editor promotions are immune.
- Decay is scoped to the run — it only touches agent promotions for the current run.

### 2.5 Model-Facing Language

The system prompts (`system.ask.md`, `system.act.md`) use the term **"Retained"**
to describe agent-promoted files. This is intentional — the model does not need to
know about the internal promotion/fidelity machinery. From the model's perspective:

- `<read file="path"/>` → "Marks file as Retained" (creates agent promotion)
- `<drop file="path"/>` → "Unmark file as Retained" (removes agent promotion)

Internal code and documentation use "agent promotion." Model-facing text uses
"Retained." These refer to the same mechanism.

### 2.6 Ranking

Files are ranked for inclusion in the context window by:

1. Promoted files first (any source), ordered by promotion recency.
2. Unpromoted files ordered by heat (symbol cross-references from promoted files).
3. Root-level files get a minor boost.
4. Alphabetical tiebreaker.

### 2.7 Schema

```sql
-- Client intent: stored by path, no FK to file index
CREATE TABLE client_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT
    , project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    , path TEXT NOT NULL
    , constraint_type TEXT NOT NULL CHECK (
        constraint_type IN ('full', 'full:readonly', 'excluded')
    )
    , UNIQUE (project_id, path)
);

-- Agent/editor state: references indexed files
CREATE TABLE file_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT
    , file_id INTEGER NOT NULL REFERENCES repo_map_files(id) ON DELETE CASCADE
    , source TEXT NOT NULL CHECK (source IN ('agent', 'editor'))
    , run_id TEXT REFERENCES runs(id) ON DELETE CASCADE
    , last_attention_turn INTEGER DEFAULT 0
);
```

- Client promotions: path-based, project-scoped. Works on untracked files.
- Agent promotions: `run_id` is set (run-scoped).
- Editor promotions: `run_id IS NULL` (transient, cleared each turn).

---

## 3. Context Budget

The context budget controls how many tokens `renderPerspective()` allocates to
the file map within each turn.

### 3.1 Computation

```
budget = RUMMY_MAP_TOKEN_BUDGET
```

- `RUMMY_MAP_TOKEN_BUDGET` is the token budget for the file map. Required.
- `RUMMY_MAP_MAX_PERCENT` is defined for future use when `contextSize` is
  fetched from provider metadata. Currently unused.
- If `RUMMY_MAP_TOKEN_BUDGET` is unset, `renderPerspective()` throws.

### 3.2 Per-Turn Evaluation

Budget is computed every `renderPerspective()` call (once per turn). The budget
and actual token usage are reported in the turn's `usage` object:

```json
{
  "usage": {
    "prompt_tokens": 4200,
    "completion_tokens": 800,
    "context_budget": 12800,
    "context_used": 9400
  }
}
```

### 3.3 Configuration

Defined in `.env`. No magic numbers in code.

```env
RUMMY_MAP_MAX_PERCENT=10        # Primary: percent of model context window
RUMMY_MAP_TOKEN_BUDGET=         # Optional: hard cap in tokens
RUMMY_DECAY_THRESHOLD=12        # Turns before agent promotion decays
```

---

## 4. RPC Protocol

Rummy communicates via JSON-RPC 2.0 over WebSockets. The `discover` RPC method
returns the canonical, machine-readable protocol reference at runtime.

### 4.1 Methods

#### Session Setup

| Method | Params | Description |
|---|---|---|
| `ping` | — | Liveness check. |
| `discover` | — | Returns full method & notification catalog. |
| `init` | `projectPath`, `projectName`, `clientId`, `projectBufferFiles?` | Initialize project and session. |

#### Model Discovery

| Method | Params | Description |
|---|---|---|
| `getModels` | — | List available model aliases. Returns `{ alias, actual, display, default }`. |

#### File Visibility (Project-Scoped)

| Method | Params | Description |
|---|---|---|
| `activate` | `pattern` | Add client promotion with `full` constraint. |
| `readOnly` | `pattern` | Add client promotion with `full:readonly` constraint. |
| `ignore` | `pattern` | Add client promotion with `excluded` constraint. |
| `drop` | `pattern` | Remove client promotion. File reverts to baseline. |
| `fileStatus` | `path` | Get file's current promotions and derived fidelity. |
| `getFiles` | — | Get full project tree with visibility. |

#### Run Execution

| Method | Params | Description |
|---|---|---|
| `startRun` | `model?`, `projectBufferFiles?` | Pre-create a run. Returns `runId`. Optional. |
| `ask` | `prompt`, `model?`, `runId?`, `projectBufferFiles?`, `temperature?`, `noContext?`, `fork?` | Non-mutating query. Auto-creates run if no `runId`. |
| `act` | `prompt`, `model?`, `runId?`, `projectBufferFiles?`, `temperature?`, `noContext?`, `fork?` | Mutating directive. Auto-creates run if no `runId`. |
| `run/resolve` | `runId`, `resolution` | Resolve a single finding (accept/reject). |
| `run/abort` | `runId` | Abandon run. Discard unresolved findings. |

#### Session Configuration

| Method | Params | Description |
|---|---|---|
| `systemPrompt` | `text` | Set system prompt override. |
| `persona` | `text` | Set agent persona. |
| `skill/add` | `name` | Enable a session skill. |
| `skill/remove` | `name` | Disable a session skill. |

### 4.2 Notifications (Server → Client)

| Notification | Payload | Description |
|---|---|---|
| `run/step/completed` | `runId`, `turn`, `files` | A turn finished. `turn` is the structured turn object. |
| `run/progress` | `runId`, `turn`, `status` | Turn progress: `thinking`, `processing`, `retrying`. |
| `editor/diff` | `runId`, `findingId`, `type`, `file`, `patch`, `warning?`, `error?` | Proposed file modification (unified diff). |
| `run/env` | `runId`, `findingId`, `command` | Proposed environment query (read-only, no side effects). |
| `run/run` | `runId`, `findingId`, `command` | Proposed shell command (may have side effects). |
| `ui/prompt` | `runId`, `findingId`, `question`, `options` | Model is asking the user a question. |
| `ui/render` | `text`, `append` | Streaming output fragment for display. |
| `ui/notify` | `text`, `level` | Toast/status notification. |

### 4.3 Run Lifecycle

A run is an open-ended container for turns sharing conversation history.
Runs do not close. The client can add turns indefinitely.

```
startRun (optional)
    │
    ├──→ ask / act  ──→  turns  ──→  findings
    │                                    │
    │                       run/resolve ─┘  (per finding: accept/reject)
    │                                    │
    │    ◄───────────────────────────────┘  (trigger unblocks, next prompt)
    │
    ├──→ ask / act  ──→  ...  (indefinitely, any mix of ask and act)
    │
    └──→ run/abort  (abandon: discard unresolved findings)
```

**Findings gate**: A SQLite trigger blocks new turn insertion while unresolved
findings exist on the run. The client must resolve all findings before the
agent can continue.

**Who applies diffs to disk?** The client. The server proposes diffs as findings.
The client resolves them (accept/reject) and writes accepted changes to its own
filesystem. The server never touches the working tree.

### 4.4 Client Intent Prefixes

The client controls run continuity through prefix conventions. All four modes
are implemented server-side.

| Prefix | Intent    | Server params                                           |
|--------|-----------|---------------------------------------------------------|
| `:`    | Continue  | `runId = <current>` — same run, same history            |
| `::`   | New       | `runId = nil` — new run, fresh agent promotions         |
| `:::`  | Lite      | `runId = nil, noContext = true` — new run, no file map  |
| `::::` | Fork      | `runId = <current>, fork = true` — new run, copies history from source |

- **Continue**: Default. Conversation continues with full history and decay tracking.
- **New**: Fresh conversation. Old run stays idle. Client promotions (project-scoped)
  carry over. Agent promotions do not.
- **Lite**: Fresh run with no file context. System prompt and protocol still apply.
  Useful for quick questions that don't need codebase awareness.
- **Fork**: Branch the conversation. New run reads turn history from `parent_run_id`
  up to the fork point — no data copying, just a pointer and sequence number.

---

## 5. Core Terminology

| Term        | Definition |
|-------------|------------|
| **Project** | A codebase. Owns file index, symbols, references, and client promotions (by path). |
| **Session** | A client connection to a project. Owns config (persona, system prompt, skills). |
| **Run**     | An open-ended conversation within a session. Owns agent promotions, turns, findings. |
| **Turn**    | A single LLM request/response cycle within a run. Owns editor promotions (transient). |
| **Finding** | A proposed action extracted from a turn: **diff** (edit/create/delete), **command** (run/env), or **notification** (summary/prompt_user). |
| **Promotion** | A record that a file was placed into context. Client promotions are stored by path in `client_promotions`. Agent/editor promotions are stored by file_id in `file_promotions`. |
| **Fidelity** | The level of detail the model receives for a file (full, full:readonly, signatures, path, excluded). Derived at render time, never stored. |
| **Decay** | The mechanism by which agent promotions are removed after the model stops referencing a file. Run-scoped. |
| **Retained** | Model-facing term for an agent-promoted file (used in system prompts). |
| **Rumsfeld Loop** | The turn cycle: the model must declare `<todo>`, `<known>`, `<unknown>` before acting. Forces discovery before modification. |

---

## 6. The Rumsfeld Loop

Every turn follows the same cognitive discipline, enforced by the state table.

### 6.1 Required Structure

The model must begin every response with three tags in order:

1. `<todo>` — The action plan. Each item uses the format `- [ ] tool: argument # description`.
   Checking an item `[x]` means the tool was performed. The todo list is the primary
   source of tool invocations — the server parses checked items as executed tools.
2. `<known>` — Facts, analysis, and plans gathered so far.
3. `<unknown>` — What the model still needs to find out. Empty (`<unknown></unknown>`)
   when nothing remains unknown.

### 6.2 Tool Execution Model

Tools are divided into two categories:

**Todo-driven tools** — the checked todo item IS the action. The server extracts
the tool name and argument from the todo line. No separate tag is emitted.

| Tool | Argument | Effect |
|---|---|---|
| `read` | file path | Creates agent promotion. File appears in context next turn. |
| `drop` | file path | Removes agent promotion. File reverts to baseline. |
| `env` | shell command | Read-only command. Proposed to client for execution. |
| `run` | shell command | Mutating command. Proposed to client for execution. |
| `delete` | file path | Proposed file deletion. Client resolves. |
| `prompt_user` | question + choices | Proposed question. Client presents to user. |
| `summary` | one-liner | Signals termination. |

**Tag-driven tools** — require structured content that cannot fit in a todo line.
The model checks the todo item AND emits a tag after the three core tags.

| Tool | Tag | Content |
|---|---|---|
| `edit` | `<edit file="path">SEARCH/REPLACE</edit>` | File modification or creation. |

An `<edit>` without SEARCH/REPLACE markers creates a new file or replaces all content.

### 6.3 State Table

The server evaluates each turn through a declarative state table.

**Phase 1 — Warnings** (always collected, always injected as feedback):

| Condition | Warning |
|---|---|
| `summary` checked but unknowns present | Resolve unknowns before terminating |
| `summary` checked but todos incomplete | Complete todos before terminating |
| Unknowns present, no tools checked | Use tools to resolve unknowns |
| Todos incomplete, no tools checked | Use tools to complete your plan |

**Phase 2 — Action** (first matching rule wins):

| # | Condition | Action |
|---|---|---|
| 1 | Findings persisted in DB | `proposed` — client resolves |
| 2 | Breaking tools checked, findings failed | `continue` — errors in feedback |
| 3 | `read` tools checked | `continue` — files appear next turn |
| 4 | Warnings present, retries remaining | `retry` — model sees warnings |
| 5 | `summary` checked | `completed` |
| 6 | No unknowns, no incomplete todos | `completed` |
| 7 | Fallback | `completed` |

### 6.4 Feedback Format

The model receives feedback as plain text lines in the user message:

```
info: AGENTS.md # file retained
info: src/old.js # file dropped
warn: config.js # edits rejected
error: utils.js # SEARCH block matched multiple locations
warn: <todo> has unchecked items but no tools were used
```

Format: `level: target # message` — same shape as the tool definitions.

### 6.5 Protocol Validation

- **Required tags**: `todo`, `known`, `unknown` must be present.
- **Allowed tools**: mode-dependent. ASK mode cannot use edit/delete/run.
- **Tool constraints** are delivered as `required_tools:` and `allowed_tools:`
  lines at the top of the user message.
- Violations trigger a retry (up to 5 attempts) with errors in feedback.

---

## 7. Testing

### 7.1 Test Tiers

| Tier | Location | Runner | LLM required? |
|---|---|---|---|
| Unit | `src/**/*.test.js` | `node --test` | No |
| Integration | `test/integration/**/*.test.js` | `node --test` | No |
| E2E | `test/e2e/**/*.test.js` | `node --test` | **Yes** |

### 7.2 Environment Cascade

Environment variables are loaded via `--env-file-if-exists` in package.json scripts.
Each layer overrides the previous:

1. `.env.example` — load-bearing defaults (OPENROUTER_BASE_URL, PORT, etc.)
2. `.env` — local overrides (API keys, model aliases, DB path)
3. `.env.test` / `.env.dev` — mode-specific overrides

Always use `npm run test:e2e`, `npm run test:unit`, etc. Never invoke node
directly with a single env file.

### 7.3 E2E Model Requirement

E2E tests execute real turns against a live LLM. This is intentional — the
Rumsfeld Loop's value is in how it constrains real model behavior, which cannot
be verified with mocks.

**Setup:**
1. Configure `.env.test` with `RUMMY_MODEL_DEFAULT` pointing to a capable model.
2. Ensure the model provider is available (Ollama running, or OpenRouter API key set).

There is no mock LLM fallback. If the model is unavailable, E2E tests fail.

### 7.4 Coverage Target

80% lines, 80% branches, 80% functions — enforced by `npm test`.

---

## 8. Database Hygiene

On every startup, the server runs three cleanup operations:

1. **`purge_old_runs`** — Delete completed/aborted runs older than 30 days.
   Cascades handle turns, turn_elements, findings, pending_context, and agent promotions.
2. **`purge_stale_sessions`** — Delete sessions with no runs.
3. **`purge_consumed_context`** — Delete pending_context entries already consumed by a turn.

The server logs the DB size on startup and warns if it exceeds 100MB.

---

## 9. Dependencies

Three runtime dependencies. Everything else is Node built-ins and ctags.

| Dependency | Purpose | Deps |
|---|---|---|
| `@possumtech/sqlrite` | SQLite ORM (author's own) | 0 |
| `@xmldom/xmldom` | XML DOM for turn building | 0 |
| `ws` | WebSocket server | 0 |

Symbol extraction uses `ctags` (universal-ctags CLI). Token counting uses `content.length / 4`.
Unified diff generation is inlined. Git operations shell out to `git` CLI.
