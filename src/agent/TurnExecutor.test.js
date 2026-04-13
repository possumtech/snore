/**
 * TurnExecutor unit tests.
 *
 * Covers:
 * - isContextExceeded pattern matching for LLM 400→413 conversion
 */
import assert from "node:assert";
import { describe, it } from "node:test";

// The regex from TurnExecutor.execute() — extracted for testability.
const IS_CONTEXT_EXCEEDED =
	/\b(context.*(size|length|limit)|token.*(limit|exceed)|too.*(long|large))\b/i;

describe("isContextExceeded pattern", () => {
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
			assert.ok(IS_CONTEXT_EXCEEDED.test(msg), `should match: ${msg}`);
		});
	}

	for (const msg of noMatch) {
		it(`rejects: "${msg.slice(0, 60)}"`, () => {
			assert.ok(!IS_CONTEXT_EXCEEDED.test(msg), `should NOT match: ${msg}`);
		});
	}
});
