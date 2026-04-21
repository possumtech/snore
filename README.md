# RUMMY: Relational Unknowns Memory Management Yoke

Rummy is the only LLM agent service inspired by and dedicated to the memory of former Secretary of Defense Donald "Rummy" Rumsfeld. Our unique fusion of apophatic and hedbergian engineering strategies yields more accurate and efficient results than any other agent. Our client/server and plugin architecture integrates it into more workflows than any other agent. It's also more flexible and lean than any other agent. Our dynamic cache management, model hot-swapping, and flexible router interface make it more affordable than any other agent.

## Key Features

- **The Rumsfeld Loop:** Forcing models to catalog what they don't know is a powerful weapon against hallucination and laziness. Every turn, the model registers gaps via `<set path="unknown://...">`, records findings via `<set path="known://...">`, and signals continuation or completion via `<update status="...">` — externalizing its reasoning into a persistent K/V store that survives across turns without message history.

- **One K/V Store:** Files, knowledge, tool results, unknowns, user prompts — everything is a keyed entry. Content lives in `entries` (scope-owned), per-run fidelity / status / turn in `run_views`. No message history. No separate file listings. The model's entire context is assembled from the store each turn.

- **Hedberg:** The interpretation boundary between stochastic model output and deterministic system operations. Models speak in whatever syntax they were trained on — sed regex, SEARCH/REPLACE blocks, escaped characters. Hedberg normalizes all of it. Available to all plugins via `core.hooks.hedberg`.

- **Folksonomic Memory:** The model organizes its own knowledge into navigable path hierarchies with searchable summary tags. Not RAG — the model builds and curates its own taxonomy using `<set path="known://project/architecture" summary="keywords,go,here">...</set>`.

- **Fidelity System:** Every per-run view of an entry has a fidelity level: `promoted` (body visible), `demoted` (path + summary only), `archived` (invisible, retrievable via pattern search). The model manages its own context by promoting what it needs and demoting what it doesn't. Budget enforcement catches overflow post-dispatch — tools run uninterrupted, demotion happens after.

- **Plugin Architecture:** Every `<tag>` the model sees is a plugin. Every scheme is registered by its owner. The prompt itself is assembled from plugins. Drop a directory into `~/.rummy/plugins/` or install via npm. See [PLUGINS.md](PLUGINS.md) for the complete plugin API.

- **Symbols Done Right:** Designed with universal language support in mind. Powered by [@possumtech/antlrmap](https://github.com/possumtech/antlrmap).

- **SQLite Done Right:** Async, compiled WAL-mode SQL engine in worker threads. Powered by [@possumtech/sqlrite](https://github.com/possumtech/sqlrite).

## Installation

Rummy loads configuration from exactly **one** directory per
invocation:

1. The directory you run `rummy` from, if it contains `.env.example`.
2. Otherwise, `${RUMMY_HOME}` (default `~/.rummy`).

`npm i -g @possumtech/rummy` runs a postinstall that seeds
`${RUMMY_HOME}/.env.example` from the package defaults, so the
out-of-the-box path works:

```bash
# In your shell rc:
export RUMMY_HOME=~/.rummy

npm i -g @possumtech/rummy
$EDITOR ~/.rummy/.env.example   # set a model alias, tweak defaults
rummy
```

Within the chosen directory, `.env.example` is the baseline and `.env`
(if present) overrides. Shell env beats both. The package's own
`.env.example` is **never** loaded at runtime — if neither the cwd nor
`${RUMMY_HOME}` has an `.env.example`, rummy crashes at startup. No
silent defaults.

## Usage

Rummy is just the service. You'll need to get (or vibe) yourself a client interface. We're partial the our Neovim plugin: [@possumtech/rummy.nvim](https://github.com/possumtech/rummy.nvim)

## Documentation

| Document | Contents |
|----------|----------|
| [SPEC.md](SPEC.md) | System design: K/V store, dispatch, packet structure, RPC |
| [PLUGINS.md](PLUGINS.md) | Plugin development: registration, events, filters, hedberg |
| [AGENTS.md](AGENTS.md) | Planning and progress |

Each plugin has its own README at `src/plugins/{name}/README.md`.
The `discover` RPC method returns the live protocol reference at runtime.
