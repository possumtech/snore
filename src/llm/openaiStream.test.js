import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chatCompletionStream } from "./openaiStream.js";

// Helper: turn an array of SSE lines into a ReadableStream the client can read.
function sseStream(lines) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		},
	});
}

function sseFrame(payload) {
	const json = typeof payload === "string" ? payload : JSON.stringify(payload);
	return `data: ${json}\n\n`;
}

describe("chatCompletionStream", () => {
	let originalFetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("accumulates content deltas across SSE frames", async () => {
		globalThis.fetch = async () => ({
			ok: true,
			body: sseStream([
				sseFrame({
					model: "test-model",
					choices: [{ delta: { content: "Hello" }, finish_reason: null }],
				}),
				sseFrame({
					choices: [{ delta: { content: ", " }, finish_reason: null }],
				}),
				sseFrame({
					choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
				}),
				sseFrame({
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
				}),
				"data: [DONE]\n\n",
			]),
		});

		const result = await chatCompletionStream({
			url: "https://example.com/v1/chat/completions",
			headers: {},
			body: { model: "test-model", messages: [] },
		});

		assert.equal(result.model, "test-model");
		assert.equal(result.choices[0].message.content, "Hello, world");
		assert.equal(result.choices[0].finish_reason, "stop");
		assert.deepEqual(result.usage, {
			prompt_tokens: 10,
			completion_tokens: 3,
			total_tokens: 13,
		});
	});

	it("captures reasoning_content / reasoning / thinking deltas", async () => {
		globalThis.fetch = async () => ({
			ok: true,
			body: sseStream([
				sseFrame({
					choices: [{ delta: { reasoning_content: "step 1 " } }],
				}),
				sseFrame({ choices: [{ delta: { reasoning: "step 2 " } }] }),
				sseFrame({ choices: [{ delta: { thinking: "step 3" } }] }),
				sseFrame({ choices: [{ delta: { content: "ok" } }] }),
				"data: [DONE]\n\n",
			]),
		});

		const result = await chatCompletionStream({
			url: "x",
			headers: {},
			body: {},
		});

		assert.equal(
			result.choices[0].message.reasoning_content,
			"step 1 step 2 step 3",
		);
		assert.equal(result.choices[0].message.content, "ok");
	});

	it("throws on non-2xx with status, body, retryAfter populated", async () => {
		globalThis.fetch = async () => ({
			ok: false,
			status: 429,
			text: async () => "rate limited",
			headers: { get: (k) => (k === "retry-after" ? "30" : null) },
		});

		await assert.rejects(
			chatCompletionStream({ url: "x", headers: {}, body: {} }),
			(err) => {
				assert.equal(err.status, 429);
				assert.equal(err.body, "rate limited");
				assert.equal(err.retryAfter, 30);
				assert.match(err.message, /429 - rate limited/);
				return true;
			},
		);
	});

	it("ignores [DONE] sentinel and empty payloads", async () => {
		globalThis.fetch = async () => ({
			ok: true,
			body: sseStream([
				"data:\n\n",
				"data: [DONE]\n\n",
				sseFrame({ choices: [{ delta: { content: "x" } }] }),
				"data: [DONE]\n\n",
			]),
		});

		const result = await chatCompletionStream({
			url: "x",
			headers: {},
			body: {},
		});
		assert.equal(result.choices[0].message.content, "x");
	});

	it("skips lines that aren't `data:` and tolerates non-JSON `data:` payloads", async () => {
		globalThis.fetch = async () => ({
			ok: true,
			body: sseStream([
				": comment heartbeat\n\n",
				"event: ping\n\n",
				"data: not-json-at-all\n\n",
				sseFrame({ choices: [{ delta: { content: "ok" } }] }),
				"data: [DONE]\n\n",
			]),
		});

		const result = await chatCompletionStream({
			url: "x",
			headers: {},
			body: {},
		});
		assert.equal(result.choices[0].message.content, "ok");
	});

	it("sets stream:true and stream_options:include_usage on the request body", async () => {
		let capturedBody;
		globalThis.fetch = async (_url, init) => {
			capturedBody = JSON.parse(init.body);
			return {
				ok: true,
				body: sseStream(["data: [DONE]\n\n"]),
			};
		};

		await chatCompletionStream({
			url: "x",
			headers: { Authorization: "Bearer abc" },
			body: { model: "m", messages: [] },
		});

		assert.equal(capturedBody.stream, true);
		assert.deepEqual(capturedBody.stream_options, { include_usage: true });
		assert.equal(capturedBody.model, "m");
	});

	it("merges plugin headers with Content-Type", async () => {
		let capturedHeaders;
		globalThis.fetch = async (_url, init) => {
			capturedHeaders = init.headers;
			return { ok: true, body: sseStream(["data: [DONE]\n\n"]) };
		};

		await chatCompletionStream({
			url: "x",
			headers: { Authorization: "Bearer abc", "X-Title": "rummy" },
			body: {},
		});

		assert.equal(capturedHeaders["Content-Type"], "application/json");
		assert.equal(capturedHeaders.Authorization, "Bearer abc");
		assert.equal(capturedHeaders["X-Title"], "rummy");
	});
});
