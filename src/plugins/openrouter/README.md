# openrouter

OpenRouter LLM provider. Handles model aliases prefixed with
`openrouter/` (e.g. `openrouter/anthropic/claude-3-opus`). Strips the
provider segment and passes the rest (`publisher/model`) straight to
OpenRouter's API.

## Env

- `OPENROUTER_BASE_URL` — base URL (e.g. `https://openrouter.ai/api/v1`).
  Plugin is inert if `OPENROUTER_API_KEY` or base URL is unset.
- `OPENROUTER_API_KEY` — bearer token.
- `RUMMY_HTTP_REFERER` / `RUMMY_X_TITLE` — attribution headers
  OpenRouter uses for rankings.

## Reasoning Normalization

OpenRouter's response shape varies by underlying provider. The plugin
merges `reasoning_content` / `reasoning` / `thinking` /
`reasoning_details[].text` into a deduplicated `reasoning_content`
string on each choice's message.

## Context Size

Calls `/models` and reads `context_length` on the matching entry.
Cached per model for the plugin lifetime. If the endpoint fails or the
model is missing, the call throws — no hardcoded fallback.
