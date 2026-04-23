# openai {#openai_plugin}

OpenAI-compatible LLM provider. Handles any model whose alias doesn't
carry a provider prefix — the default fallback provider. Works with
OpenAI itself, llama.cpp, vLLM, and any other service that implements
the `/v1/chat/completions` and `/v1/models` shape.

## Env

- `OPENAI_BASE_URL` — base URL (e.g. `https://api.openai.com` or
  `http://localhost:8080`). Plugin is inert if unset.
- `OPENAI_API_KEY` — bearer token (optional for local servers).

## Context Size

Probes `/props` first (llama.cpp runtime) for `n_ctx`, falls back to
`/v1/models` for the training context length.
