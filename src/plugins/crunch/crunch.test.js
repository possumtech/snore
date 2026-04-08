import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchEntries, parseSummaries } from "./crunch.js";

describe("Crunch parseSummaries", () => {
	const entries = [
		{ path: "known://api_config", body: "REST API uses OAuth2" },
		{ path: "known://deploy", body: "Deploys to AWS ECS" },
	];

	it("parses valid multi-line response", () => {
		const response = [
			"known://api_config → OAuth2 PKCE, 30d refresh, 100 req/min",
			"known://deploy → AWS ECS us-west-2, GH Actions CI",
		].join("\n");

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].path, "known://api_config");
		assert.strictEqual(
			results[0].summary,
			"OAuth2 PKCE, 30d refresh, 100 req/min",
		);
		assert.strictEqual(results[1].path, "known://deploy");
	});

	it("skips lines without arrow separator", () => {
		const response = [
			"known://api_config → OAuth2 PKCE",
			"This line has no arrow",
			"known://deploy → AWS ECS",
		].join("\n");

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 2);
	});

	it("truncates summaries over 80 chars", () => {
		const long = "a".repeat(120);
		const response = `known://api_config → ${long}`;

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0].summary.length, 80);
	});

	it("skips paths not in entries", () => {
		const response = "known://unknown_path → some keywords";

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 0);
	});

	it("returns empty array for empty response", () => {
		assert.strictEqual(parseSummaries("", entries).length, 0);
		assert.strictEqual(parseSummaries(null, entries).length, 0);
	});

	it("skips lines with empty summary after arrow", () => {
		const response = "known://api_config → ";

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 0);
	});

	it("handles blank lines in response", () => {
		const response = [
			"",
			"known://api_config → OAuth2 config",
			"",
			"known://deploy → ECS deploy",
			"",
		].join("\n");

		const results = parseSummaries(response, entries);
		assert.strictEqual(results.length, 2);
	});
});

describe("Crunch batchEntries", () => {
	it("fits small entries in one batch", () => {
		const entries = [
			{ path: "known://a", body: "short" },
			{ path: "known://b", body: "also short" },
		];
		const batches = batchEntries(entries, 10_000);
		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0].length, 2);
	});

	it("splits large entries into multiple batches", () => {
		const entries = Array.from({ length: 20 }, (_, i) => ({
			path: `known://entry_${i}`,
			body: "x".repeat(400),
		}));
		const batches = batchEntries(entries, 2000);
		assert.ok(
			batches.length > 1,
			`expected multiple batches, got ${batches.length}`,
		);
		const total = batches.reduce((s, b) => s + b.length, 0);
		assert.strictEqual(total, 20);
	});

	it("handles single oversized entry", () => {
		const entries = [{ path: "known://big", body: "x".repeat(50_000) }];
		const batches = batchEntries(entries, 1000);
		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0].length, 1);
	});
});
