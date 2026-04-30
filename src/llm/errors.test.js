import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ContextExceededError,
	classifyTransient,
	isContextExceededMessage,
	parseRetryAfter,
} from "./errors.js";

describe("isContextExceededMessage", () => {
	const matches = [
		// llama.cpp / local models
		"request (52452 tokens) exceeds the available context size (32768 tokens)",
		'OpenAI-compatible API error: 400 - {"error":{"code":400,"message":"request exceeds context size"}}',
		// OpenAI
		"This model's maximum context length is 128000 tokens",
		"maximum context length exceeded",
		// Anthropic
		"prompt is too long: token count exceeds the limit",
		"token limit exceeded",
		// Generic patterns
		"context limit reached",
		"request too large for context",
		"input too long",
	];

	const noMatch = [
		// Transient errors should NOT match
		"503 Service Unavailable",
		"429 Too Many Requests",
		"timeout after 30000ms",
		"ECONNREFUSED",
		// Unrelated errors
		"invalid API key",
		"model not found",
		"rate limit exceeded",
		"internal server error",
	];

	for (const msg of matches) {
		it(`matches: "${msg.slice(0, 60)}"`, () => {
			assert.ok(isContextExceededMessage(msg), `should match: ${msg}`);
		});
	}

	for (const msg of noMatch) {
		it(`rejects: "${msg.slice(0, 60)}"`, () => {
			assert.ok(!isContextExceededMessage(msg), `should NOT match: ${msg}`);
		});
	}
});

describe("classifyTransient", () => {
	const cases = [
		// gateway: upstream unreachable
		{ message: "502 - <html>...</html>", body: "", expected: "gateway" },
		{ message: "504 Gateway Timeout", body: "", expected: "gateway" },
		{ message: "fetch failed", body: "", expected: "gateway" },
		{ message: "ECONNREFUSED 127.0.0.1:11435", body: "", expected: "gateway" },
		{ message: "ECONNRESET on socket", body: "", expected: "gateway" },
		{ message: "ENOTFOUND example.com", body: "", expected: "gateway" },
		{ message: "ETIMEDOUT", body: "", expected: "gateway" },
		// undici mid-stream socket close.
		{ message: "terminated", body: "", expected: "gateway" },
		// rate_limit
		{ message: "429 Too Many Requests", body: "", expected: "rate_limit" },
		// warmup: 503 + explicit "Loading model" body
		{
			message:
				'503 - {"error":{"message":"Loading model","type":"unavailable_error","code":503}}',
			body: '{"error":{"message":"Loading model","code":503}}',
			expected: "warmup",
		},
		{
			message: "503 Service Unavailable",
			body: "Loading model from disk...",
			expected: "warmup",
		},
		// server: 500 or generic 503
		{ message: "500 Internal Server Error", body: "", expected: "server" },
		{ message: "503 Service Unavailable", body: "", expected: "server" },
		// null: not retryable
		{ message: "401 Unauthorized", body: "", expected: null },
		{ message: "400 Bad Request", body: "", expected: null },
		{ message: "404 Not Found", body: "", expected: null },
		{ message: "This operation was aborted", body: "", expected: null },
		{
			message: "AbortError: The operation was aborted",
			body: "",
			expected: null,
		},
		{ message: "TimeoutError: timed out", body: "", expected: null },
		{ message: "model not found", body: "", expected: null },
	];

	for (const { message, body, expected } of cases) {
		it(`classifies "${message.slice(0, 50)}" as ${expected ?? "null"}`, () => {
			assert.strictEqual(classifyTransient({ message, body }), expected);
		});
	}

	it("handles non-Error inputs gracefully", () => {
		assert.strictEqual(classifyTransient(null), null);
		assert.strictEqual(classifyTransient(undefined), null);
		assert.strictEqual(classifyTransient({}), null);
	});

	it("does not require a body field", () => {
		assert.strictEqual(
			classifyTransient({ message: "502 Bad Gateway" }),
			"gateway",
		);
	});
});

describe("parseRetryAfter", () => {
	it("parses integer seconds", () => {
		assert.strictEqual(parseRetryAfter("120"), 120);
		assert.strictEqual(parseRetryAfter("0"), 0);
		assert.strictEqual(parseRetryAfter("3.5"), 3.5);
	});

	it("returns undefined for missing/null/empty", () => {
		assert.strictEqual(parseRetryAfter(null), undefined);
		assert.strictEqual(parseRetryAfter(undefined), undefined);
		assert.strictEqual(parseRetryAfter(""), undefined);
	});

	it("returns undefined for HTTP-date form (intentional)", () => {
		assert.strictEqual(
			parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"),
			undefined,
		);
	});

	it("returns undefined for malformed values", () => {
		assert.strictEqual(parseRetryAfter("not-a-number"), undefined);
		assert.strictEqual(parseRetryAfter("-1"), undefined);
	});
});

describe("ContextExceededError", () => {
	it("extends Error with named type", () => {
		const err = new ContextExceededError("too big");
		assert.ok(err instanceof Error);
		assert.ok(err instanceof ContextExceededError);
		assert.strictEqual(err.name, "ContextExceededError");
		assert.strictEqual(err.message, "too big");
	});

	it("preserves cause when provided", () => {
		const original = new Error("original");
		const wrapped = new ContextExceededError("wrapped", { cause: original });
		assert.strictEqual(wrapped.cause, original);
	});
});
