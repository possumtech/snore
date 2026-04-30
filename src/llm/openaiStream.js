/**
 * Shared streaming client for OpenAI-compatible /chat/completions endpoints.
 *
 * Provider plugins (openai, openrouter, ollama) construct the request body
 * and headers; this module handles the SSE parsing, accumulates deltas into
 * a non-streaming-shape response, and surfaces errors with the same ergonomics
 * as the previous fetch-then-json pattern.
 *
 * Streaming is preferred over non-streaming for two reasons:
 *
 *   1. Long-running completions through CDN proxies (e.g. Cloudflare's 100s
 *      origin-timeout) can't survive a non-streaming hold; streaming keeps
 *      the connection alive byte-by-byte.
 *   2. Future UI surfaces ("thinking" displays) want the deltas live; a
 *      streaming-first plugin layer gives them a hook.
 *
 * The xAI Responses API (`/v1/responses`) uses a different streaming format
 * and is out of scope for this client.
 */

/**
 * @param {Object} args
 * @param {string} args.url            Full POST URL (e.g. `${baseUrl}/v1/chat/completions`).
 * @param {Object} args.headers        Plugin-specific headers (Authorization, etc.).
 * @param {Object} args.body           Request body (without `stream` — added here).
 * @param {AbortSignal} [args.signal]  Cancellation signal.
 * @returns {Promise<Object>}          Non-streaming-shape response: `{ choices, usage, model }`.
 *                                     Throws on non-2xx with `err.status` and `err.body` populated.
 */
export async function chatCompletionStream({ url, headers, body, signal }) {
	const requestBody = {
		...body,
		stream: true,
		// Tells OpenAI / OpenAI-compatible servers to emit a final usage chunk.
		stream_options: { include_usage: true },
	};

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(requestBody),
		signal,
	});

	if (!response.ok) {
		const errorBody = await response.text();
		const err = new Error(`${response.status} - ${errorBody}`);
		err.status = response.status;
		err.body = errorBody;
		throw err;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let content = "";
	let reasoningContent = "";
	let usage = null;
	let model = null;
	let finishReason = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		// SSE frames are separated by blank lines; within a frame, a `data:`
		// line carries the JSON payload. Process complete lines and keep any
		// trailing partial-line in the buffer for the next read.
		const lines = buffer.split("\n");
		buffer = lines.pop();

		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trimStart();
			if (payload === "[DONE]" || payload === "") continue;

			let chunk;
			try {
				chunk = JSON.parse(payload);
			} catch {
				continue;
			}

			if (chunk.model) model = chunk.model;
			if (chunk.usage) usage = chunk.usage;

			const choice = chunk.choices?.[0];
			if (!choice) continue;
			if (choice.finish_reason) finishReason = choice.finish_reason;

			const delta = choice.delta;
			if (!delta) continue;
			if (typeof delta.content === "string") content += delta.content;
			// Different providers surface reasoning under different field names.
			// Concatenate any that show up.
			if (typeof delta.reasoning_content === "string")
				reasoningContent += delta.reasoning_content;
			if (typeof delta.reasoning === "string")
				reasoningContent += delta.reasoning;
			if (typeof delta.thinking === "string")
				reasoningContent += delta.thinking;
		}
	}

	return {
		model,
		choices: [
			{
				message: {
					role: "assistant",
					content,
					reasoning_content: reasoningContent,
				},
				finish_reason: finishReason,
			},
		],
		usage,
	};
}
