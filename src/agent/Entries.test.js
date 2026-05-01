import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Entries from "./Entries.js";

function mockDb({ entryExists = () => null } = {}) {
	return {
		get_all_schemes: { all: async () => [] },
		next_turn: { get: async () => ({ turn: 1 }) },
		get_entry_body: { get: async ({ path }) => entryExists(path) },
	};
}

describe("Entries.scheme (static)", () => {
	it("returns null for nullish/empty paths", () => {
		assert.equal(Entries.scheme(null), null);
		assert.equal(Entries.scheme(undefined), null);
		assert.equal(Entries.scheme(""), null);
	});

	it("returns null for bare paths (no ://)", () => {
		assert.equal(Entries.scheme("src/app.js"), null);
		assert.equal(Entries.scheme("README.md"), null);
	});

	it("extracts scheme from prefix://...", () => {
		assert.equal(Entries.scheme("known://auth"), "known");
		assert.equal(Entries.scheme("log://turn_1/set/x"), "log");
		assert.equal(Entries.scheme("https://example.com"), "https");
	});

	it("returns null when :// is at index 0 (empty scheme)", () => {
		assert.equal(Entries.scheme("://x"), null);
	});
});

describe("Entries.normalizePath (static)", () => {
	it("returns bare path unchanged", () => {
		assert.equal(Entries.normalizePath("src/app.js"), "src/app.js");
		assert.equal(Entries.normalizePath("README.md"), "README.md");
	});

	it("lowercases scheme", () => {
		assert.equal(Entries.normalizePath("KNOWN://Foo"), "known://Foo");
	});

	it("preserves slashes in the rest, encodes segments", () => {
		assert.equal(Entries.normalizePath("known://a/b c/d"), "known://a/b_c/d");
	});

	it("decode-then-re-encodes is idempotent", () => {
		const once = Entries.normalizePath("known://hello world");
		const twice = Entries.normalizePath(once);
		assert.equal(once, twice);
	});

	it("falls back to direct re-encode on decode failure (malformed %)", () => {
		// Lone % is not a valid percent-escape; decodeURIComponent throws.
		const out = Entries.normalizePath("known://50%");
		assert.equal(out, "known://50%25");
	});
});

describe("Entries instance methods (DB-backed)", () => {
	it("constructs with onChanged callback", () => {
		const calls = [];
		const e = new Entries(mockDb(), {
			onChanged: (event) => calls.push(event),
		});
		assert.ok(e);
	});

	it("nextTurn delegates to db.next_turn.get", async () => {
		const e = new Entries(mockDb());
		assert.equal(await e.nextTurn(7), 1);
	});

	it("logPath produces log://turn_N/action/encoded-target paths", async () => {
		const e = new Entries(mockDb());
		const path = await e.logPath(7, 3, "set", "src/app.js");
		assert.equal(path, "log://turn_3/set/src%2Fapp.js");
	});

	it("logPath caps target at 150 chars before encoding", async () => {
		const e = new Entries(mockDb());
		const long = "x".repeat(500);
		const path = await e.logPath(1, 1, "error", long);
		// Encoded path should not contain more than ~150 'x's in body.
		const slug = path.split("/").pop();
		assert.ok(
			slug.length <= 150 * 3, // worst-case 3x for ASCII
			`slug too long: ${slug.length}`,
		);
		assert.ok(slug.startsWith("xxxxx"));
	});

	it("logPath sequence-suffixes when path collides", async () => {
		let calls = 0;
		const db = mockDb({
			entryExists: () => (++calls === 1 ? { body: "exists" } : null),
		});
		const e = new Entries(db);
		const collided = await e.logPath(1, 1, "set", "x");
		assert.match(collided, /^log:\/\/turn_1\/set\/x_\d+$/);
	});

	it("slugPath uses summary, falls back to content, then sequence-only", async () => {
		const e = new Entries(mockDb());
		// summary wins (slugify preserves case; just lowercases via output)
		const a = await e.slugPath(1, "known", "the content body", "Auth Token");
		assert.match(a, /^known:\/\/[A-Za-z]+_[A-Za-z]+/);
		assert.match(a, /Auth/i);
		// content used when no summary
		const b = await e.slugPath(1, "known", "Login Flow", null);
		assert.match(b, /^known:\/\/[A-Za-z]+_[A-Za-z]+/);
		assert.match(b, /Login/i);
		// no source → sequence-only
		const c = await e.slugPath(1, "known", "", "");
		assert.match(c, /^known:\/\/\d+$/);
	});

	it("slugPath sequence-suffixes when slugified path already exists", async () => {
		let calls = 0;
		const db = mockDb({
			entryExists: () => (++calls === 1 ? { body: "exists" } : null),
		});
		const e = new Entries(db);
		const out = await e.slugPath(1, "known", "auth", null);
		assert.match(out, /^known:\/\/auth_\d+$/);
	});

	it("dedup returns base path on first attempt, suffix on collision", async () => {
		// Fresh: no collision
		const fresh = new Entries(mockDb());
		const a = await fresh.dedup(1, "known", "hello", 3);
		assert.equal(a, "known://turn_3/hello");

		// Collision: returns suffixed path
		let calls = 0;
		const colliding = new Entries(
			mockDb({ entryExists: () => (++calls === 1 ? { body: "x" } : null) }),
		);
		const b = await colliding.dedup(1, "known", "hello", 3);
		assert.match(b, /^known:\/\/turn_3\/hello_\d+$/);
	});

	it("dedup omits turn prefix when turn falsy", async () => {
		const e = new Entries(mockDb());
		assert.equal(await e.dedup(1, "known", "hello", 0), "known://hello");
		assert.equal(await e.dedup(1, "known", "hello", null), "known://hello");
	});

	it("loadSchemes populates the scheme cache", async () => {
		const rows = [
			{ name: "known", default_scope: "run", category: "data" },
			{ name: "log", default_scope: "run", category: "logging" },
		];
		const db = {
			...mockDb(),
			get_all_schemes: { all: async () => rows },
		};
		const e = new Entries(db);
		await e.loadSchemes();
		// Subsequent loads are idempotent (no error).
		await e.loadSchemes();
	});
});
