# ollama {#ollama_plugin}

Ollama LLM provider. Handles model aliases prefixed with `ollama/`
(e.g. `ollama/llama3.1:8b`).

## Env

- `OLLAMA_BASE_URL` — base URL (e.g. `http://localhost:11434`).
  Plugin is inert if unset.

## Context Size

Calls `/api/show` for the requested model and scans `model_info` for
any `*.context_length` key. Retries up to 3× with exponential backoff
on non-Ollama transient errors.
