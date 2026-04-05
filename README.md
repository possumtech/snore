# RUMMY: Relational Unknowns Memory Management Yoke

Rummy is the only LLM agent service inspired by and dedicated to the memory of former Secretary of State Donald "Rummy" Rumsfeld. Our unique fusion of apophatic and hedbergian engineering strategies yields more accurate and efficient results than any other agent. Our client/server and plugin architecture integrates it into more workflows than any other agent. It's also more flexible and lean than any other agent. Our dynamic cache management, model hot-swapping, and flexible router interface make it more affordable than any other agent.

## Key Features

- **The Rumsfeld Loop:** Forcing models to catalog what they don't know is a powerful weapon against hallucination and laziness. Every turn, the model calls `<known>`, `<unknown>`, and `<update>` — externalizing its reasoning into a persistent K/V store that survives across turns without message history.

- **One K/V Store:** Files, knowledge, tool results, unknowns, user prompts — everything is a keyed entry in one SQLite table. No message history. No separate file listings. The model's entire context is assembled from the store each turn.

- **Hedberg:** The interpretation boundary between stochastic model output and deterministic system operations. Models speak in whatever syntax they were trained on — sed regex, SEARCH/REPLACE blocks, escaped characters. Hedberg normalizes all of it. Available to all plugins via `core.hooks.hedberg`.

- **Plugin Architecture:** Every `<tag>` the model sees is a plugin. Every scheme is registered by its owner. The prompt itself is assembled from plugins. Drop a directory into `~/.rummy/plugins/` or install via npm. See [PLUGINS.md](PLUGINS.md) for the complete plugin API.

- **Symbols Done Right:** Designed with universal language support in mind. Powered by [@possumtech/antlrmap](https://github.com/possumtech/antlrmap).

- **SQLite Done Right:** Async, compiled WAL-mode SQL engine in worker threads. Powered by [@possumtech/sqlrite](https://github.com/possumtech/sqlrite).

## Installation

```bash
npm i -g @possumtech/rummy
cd ~/.rummy
cp .env.example .env
vim .env # set up at least one model alias
npm start
```

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
