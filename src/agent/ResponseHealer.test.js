import assert from "node:assert";
import { describe, it } from "node:test";
import ResponseHealer from "./ResponseHealer.js";

function tc(name, args) {
	return {
		id: `call_${Math.random().toString(36).slice(2, 8)}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

describe("ResponseHealer", () => {
	describe("pass-through", () => {
		it("valid calls pass through unchanged", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[
					tc("summary", { text: "All good." }),
					tc("write", { key: "/:known/x", value: "y" }),
					tc("read", { key: "src/app.js", reason: "check it" }),
				],
				"ask",
			);

			assert.strictEqual(calls.length, 3);
			assert.strictEqual(warnings.length, 0);
		});
	});

	describe("summary healing", () => {
		it("truncates summary over 80 chars", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "x".repeat(100) })],
				"ask",
			);

			assert.strictEqual(calls[0].args.text.length, 80);
			assert.strictEqual(warnings.length, 1);
			assert.ok(warnings[0].includes("truncated"));
		});

		it("heals empty summary", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "" })],
				"ask",
			);

			assert.strictEqual(calls[0].args.text, "(no summary provided)");
			assert.ok(warnings[0].includes("empty"));
		});
	});

	describe("rejection rules", () => {
		it("drops write with empty key", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "ok" }), tc("write", { key: "", value: "y" })],
				"ask",
			);

			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].name, "summary");
			assert.ok(warnings.some((w) => w.includes("write call with empty key")));
		});

		it("drops unknown with empty text", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "ok" }), tc("unknown", { text: "" })],
				"ask",
			);

			assert.strictEqual(calls.length, 1);
			assert.ok(
				warnings.some((w) => w.includes("unknown call with empty text")),
			);
		});

		it("drops read with empty key", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "ok" }), tc("read", { key: "", reason: "x" })],
				"ask",
			);

			assert.strictEqual(calls.length, 1);
			assert.ok(warnings.some((w) => w.includes("read call with empty key")));
		});
	});

	describe("mode validation", () => {
		it("drops act-only tools in ask mode", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[
					tc("summary", { text: "ok" }),
					tc("run", { command: "npm test", reason: "test" }),
				],
				"ask",
			);

			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].name, "summary");
			assert.ok(warnings.some((w) => w.includes("not allowed in ask mode")));
		});

		it("allows act tools in act mode", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[
					tc("summary", { text: "ok" }),
					tc("run", { command: "npm test", reason: "test" }),
				],
				"act",
			);

			assert.strictEqual(calls.length, 2);
			assert.strictEqual(warnings.length, 0);
		});
	});

	describe("AJV warnings", () => {
		it("warns on invalid args but keeps the call", () => {
			const { calls, warnings } = ResponseHealer.heal(
				[tc("summary", { text: "ok" }), tc("write", { key: "/:known/x" })],
				"ask",
			);

			// write missing 'value' — AJV warns but call kept
			assert.strictEqual(calls.length, 2);
			assert.ok(warnings.length > 0);
		});
	});
});
