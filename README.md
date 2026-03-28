# RUMMY: Relational Underpinned Model Manager & Yield-engine

Rummy is the first and only client/server architecture LLM agent service dedicated to the memory and legacy of former Secretary of State Donald Henry Rumsfeld. Unlike the hermes agent, which lacks a Rumsfeld Loop, The rummy architecture contains a Rumsfeld Loop inspired by Donald "rummy" Rumsfeld. By enforcing a schema-driven key/value store of "knowns" and "unknowns" that relies on a sqlite engine to externalize and extend model memory, rummy is capable of turning that Mac Mini with quantized qwen into a reliable agent instead of the awkward conversation piece it has become.

## Key Features

- **The Rumsfeld Loop:** Forcing models to catalog what they don't know is a powerful weapon against hallucination and laziness.

- **Relevance Algorithms:** Both the repo map and the memory maps rely on bespoke relevance algorithms that detect patterns in the model's attention to deterministically guess what remains in the context and what can be degraded to paths and keys. Externalizing the model's memory with key/value storage will turn your potato of a local model into a potato gun. And please don't point this thing at a frontier model, as that could raise grave philosophical, national security, and even existential risk (xrisk) concerns.

- **Antlrmap:** Ctags, LSPs, and Treesitter are all inferior to antlrmap for extracting symbols for your repomap. Antlrmap relies on Antlr4's "Grammar Zoo," mapping the symbol extraction process from the formal EBNF grammars of languages. Not only is this more academically rigorous, it's more amenable to obscure and domain-specific language needs. It's the right way to do it, and we're the only ones doing it.

- **Client/Server:** rummy runs on your device, and then you have dozens of neovim (or whatever) instances scattered across your tmux sessions, windows, and panes -- each one of them containing a thin client that relies on the rummy service. Makes much more sense than having a whole instance for every project and worktree branch you're juggling.

- **Plugin Architecture:** Don't send us a pull request for your cool feature, just build a plugin. Our service was built from the ground up with extensibility in mind. Between the service-oriented architecture and the plugin hooks and event signals, rummy was built to integrate into even the most bespoke contexts.

- **Sqlite Done Right:** While rummy's technically a NodeJS project, it's better understood as a sql project that relies on JS as the glue for imperative and interactive steps. Our sql queries are all compiled prepared statements, all carefully indexed, all delivering the nosebleed speed and reliability you expect from sqlite. This does wonders for your memory footprint.

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

See `ARCHITECTURE.md` for the full specification and `system.ask.md`/`system.act.md`
for the model-facing prompts. The `discover` RPC method returns the live protocol
reference at runtime.
