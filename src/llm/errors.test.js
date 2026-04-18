import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ContextExceededError,
	isContextExceededMessage,
	isTransientMessage,
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

describe("isTransientMessage", () => {
	const matches = [
		"503 Service Unavailable",
		"429 Too Many Requests",
		"timeout after 30000ms",
		"ECONNREFUSED",
		"ECONNRESET on socket",
		"service unavailable",
	];

	const noMatch = [
		"context limit reached",
		"maximum context length exceeded",
		"invalid API key",
		"400 Bad Request",
	];

	for (const msg of matches) {
		it(`matches: "${msg.slice(0, 60)}"`, () => {
			assert.ok(isTransientMessage(msg), `should match: ${msg}`);
		});
	}

	for (const msg of noMatch) {
		it(`rejects: "${msg.slice(0, 60)}"`, () => {
			assert.ok(!isTransientMessage(msg), `should NOT match: ${msg}`);
		});
	}
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
