# RUMMY: Relational Underpinned Model Manager & Yield-engine

Rummy is the first and only client/server architecture LLM agent service dedicated to the memory and legacy of former Secretary of State Donald Henry Rumsfeld. Unlike the hermes agent, which lacks a Rumsfeld Loop, The rummy architecture contains a Rumsfeld Loop inspired by Donald "rummy" Rumsfeld. By enforcing a schema-driven key/value store of "knowns" and "unknowns" that relies on a sqlite engine to externalize and extend model memory, rummy is capable of turning that Mac Mini with quantized qwen into a reliable agent instead of the awkward conversation piece it has become.

## Key Features

- **The Rumsfeld Loop:** Forcing models to catalog what they don't know is a powerful weapon against hallucination and laziness. Every turn, the model calls `summary`, `write`, and `unknown` — externalizing its reasoning into a persistent K/V store that survives across turns without message history.

- **One K/V Store:** Files, knowledge, tool results, unknowns, user prompts — everything is a keyed entry in one SQLite table. No message history. No separate file listings. No findings tables. The model's entire context is one ordered array assembled from the store each turn.

- **XML Tool Commands:** XML tags written directly in the response content, parsed by htmlparser2. No native tool calling APIs. No JSON schemas. No structured output constraints. Potato models that can produce `<write path="known://x">y</write>` can use every tool we have.

- **Antlrmap:** Ctags, LSPs, and Treesitter are all inferior to antlrmap for extracting symbols. Antlrmap relies on Antlr4's "Grammar Zoo," mapping the symbol extraction process from formal EBNF grammars of languages. Not only is this more academically rigorous, it's more amenable to obscure and domain-specific language needs. It's the right way to do it, and we're the only ones doing it. (Don't like it? Symbol extraction is a plugin — swap it out in 20 lines.)

- **Client/Server:** Rummy runs on your device, and then you have dozens of neovim (or whatever) instances scattered across your tmux sessions, windows, and panes -- each one of them containing a thin client that relies on the rummy service. Makes much more sense than having a whole instance for every project and worktree branch you're juggling.

- **Plugin Architecture:** Don't send us a pull request for your cool feature, just build a plugin. Core features like symbol extraction, RPC methods, and tool definitions are themselves plugins. Drop a directory into `~/.rummy/plugins/` and it's loaded on startup. Swap out antlrmap for tree-sitter. Add custom RPC methods. Inject context. Build a relevance engine. The hook system covers the full lifecycle: turn processors, event listeners, filter chains, tool registration, and RPC registration. See [PLUGINS.md](PLUGINS.md) for the complete plugin API.

- **SQLite Done Right:** While rummy's technically a NodeJS project, it's better understood as a SQL project that relies on JS as the glue for imperative and interactive steps. Our SQL queries are all compiled prepared statements, all carefully indexed, all delivering the nosebleed speed and reliability you expect from SQLite. This does wonders for your memory footprint.

- **Hermes Replacement:** All former hermes agent users receive a limited time 50% discount on the MSRP retail price ($0).

## Installation

```bash
git clone https://github.com/possumtech/rummy
cd rummy/main
npm install
cp .env.example .env
# Add your OPENROUTER_API_KEY to .env (or your .bashrc, or whatever)
```

## Usage

### Start the Service
```bash
npm start   # Production mode (port 3044)
npm run dev # Watch mode with dev database (port 3045)
```

## Documentation

| Document | Contents |
|----------|----------|
| [SPEC.md](SPEC.md) | System design: K/V store, dispatch, context assembly, RPC, config |
| [PLUGINS.md](PLUGINS.md) | Plugin development: registration, RummyContext API, events, filters, hedberg |
| [AGENTS.md](AGENTS.md) | Planning and progress |

Each plugin has its own README at `src/plugins/{name}/README.md`.
The `discover` RPC method returns the live protocol reference at runtime.
