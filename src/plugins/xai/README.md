# xai {#xai_plugin}

xAI (Grok) LLM provider. Handles model aliases prefixed with `xai/`
(e.g. `xai/grok-2`).

## Env

- `XAI_BASE_URL` — full responses endpoint (e.g.
  `https://api.x.ai/v1/responses`). Plugin is inert if unset.
- `XAI_API_KEY` — bearer token.

## Response Normalization

xAI's response shape differs from OpenAI's. The plugin walks
`data.output[]`, collecting text from items of type `message` as
`content` and items of type `reasoning` as `reasoning_content`, then
emits the common OpenAI-shaped envelope.

## Context Size

Tries `/models` first for a `context_length` field, then the
`/language-models/<id>` endpoint as a fallback. Results are cached
per model for the plugin lifetime.
