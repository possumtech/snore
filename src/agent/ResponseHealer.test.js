import assert from "node:assert";
import { describe, it } from "node:test";
import ResponseHealer from "./ResponseHealer.js";

describe("ResponseHealer", () => {
	describe("healUpdate", () => {
		it("uses plain text as update when no commands", () => {
			const result = ResponseHealer.healUpdate("I did the thing.", []);
			assert.strictEqual(result, "I did the thing.");
		});

		it("truncates long plain text to 500 chars", () => {
			const long = "x".repeat(600);
			const result = ResponseHealer.healUpdate(long, []);
			assert.strictEqual(result.length, 500);
		});

		it("injects placeholder when commands exist but no status tag", () => {
			const result = ResponseHealer.healUpdate("", [{ name: "read" }]);
			assert.strictEqual(result, "...");
		});

		it("injects placeholder for empty content with no commands", () => {
			const result = ResponseHealer.healUpdate("", []);
			assert.strictEqual(result, "...");
		});

		it("injects placeholder for whitespace-only content", () => {
			const result = ResponseHealer.healUpdate("   \n  ", []);
			assert.strictEqual(result, "...");
		});
	});

	describe("assessProgress", () => {
		it("summary terminates the run", () => {
			const healer = new ResponseHealer();
			const result = healer.assessProgress({
				summaryText: "all done",
				updateText: null,
			});
			assert.strictEqual(result.continue, false);
		});

		it("update continues the run", () => {
			const healer = new ResponseHealer();
			const result = healer.assessProgress({
				summaryText: null,
				updateText: "reading files",
			});
			assert.strictEqual(result.continue, true);
		});

		it("neither increments stall counter and continues", () => {
			const healer = new ResponseHealer();
			const result = healer.assessProgress({
				summaryText: null,
				updateText: null,
			});
			assert.strictEqual(result.continue, true);
		});

		it("stalls force-complete after MAX_STALLS", () => {
			const healer = new ResponseHealer();
			for (let i = 0; i < 2; i++) {
				healer.assessProgress({ summaryText: null, updateText: null });
			}
			const result = healer.assessProgress({
				summaryText: null,
				updateText: null,
			});
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason);
		});

		it("update resets stall counter", () => {
			const healer = new ResponseHealer();
			healer.assessProgress({ summaryText: null, updateText: null });
			healer.assessProgress({ summaryText: null, updateText: null });
			// One more would stall — but update resets
			healer.assessProgress({ summaryText: null, updateText: "working" });
			healer.assessProgress({ summaryText: null, updateText: null });
			healer.assessProgress({ summaryText: null, updateText: null });
			const result = healer.assessProgress({
				summaryText: null,
				updateText: null,
			});
			assert.strictEqual(result.continue, false);
		});

		it("summary resets stall counter", () => {
			const healer = new ResponseHealer();
			healer.assessProgress({ summaryText: null, updateText: null });
			healer.assessProgress({ summaryText: null, updateText: null });
			const result = healer.assessProgress({
				summaryText: "done",
				updateText: null,
			});
			assert.strictEqual(result.continue, false);
			assert.ok(!result.reason);
		});

		it("reset clears state", () => {
			const healer = new ResponseHealer();
			healer.assessProgress({ summaryText: null, updateText: null });
			healer.assessProgress({ summaryText: null, updateText: null });
			healer.reset();
			// After reset, counter is 0 — needs 3 more to stall
			const result = healer.assessProgress({
				summaryText: null,
				updateText: null,
			});
			assert.strictEqual(result.continue, true);
		});

		it("healed update increments stall counter", () => {
			const healer = new ResponseHealer();
			for (let i = 0; i < 3; i++) {
				healer.assessProgress({
					summaryText: null,
					updateText: "...",
					statusHealed: true,
				});
			}
			const result = healer.assessProgress({
				summaryText: null,
				updateText: "...",
				statusHealed: true,
			});
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason);
		});

		it("genuine update resets stall counter from healed stalls", () => {
			const healer = new ResponseHealer();
			healer.assessProgress({
				summaryText: null,
				updateText: "...",
				statusHealed: true,
			});
			healer.assessProgress({
				summaryText: null,
				updateText: "...",
				statusHealed: true,
			});
			healer.assessProgress({ summaryText: null, updateText: "working" });
			assert.strictEqual(
				healer.assessProgress({
					summaryText: null,
					updateText: "...",
					statusHealed: true,
				}).continue,
				true,
			);
		});
	});

	describe("assessRepetition", () => {
		it("no commands does not increment", () => {
			const healer = new ResponseHealer();
			const result = healer.assessRepetition({ actionCalls: [], writeCalls: [] });
			assert.strictEqual(result.continue, true);
		});

		it("same commands repeated 3x force-completes", () => {
			const healer = new ResponseHealer();
			const calls = { actionCalls: [{ name: "search", path: "Tom Petty" }], writeCalls: [] };
			healer.assessRepetition(calls);
			healer.assessRepetition(calls);
			const result = healer.assessRepetition(calls);
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("repeated"));
		});

		it("different commands reset the counter", () => {
			const healer = new ResponseHealer();
			const search1 = { actionCalls: [{ name: "search", path: "Tom Petty" }], writeCalls: [] };
			const search2 = { actionCalls: [{ name: "search", path: "Beatles" }], writeCalls: [] };
			healer.assessRepetition(search1);
			healer.assessRepetition(search1);
			// Different command resets
			healer.assessRepetition(search2);
			// Back to original — counter restarts at 1
			healer.assessRepetition(search1);
			const result = healer.assessRepetition(search1);
			// Only 2 repetitions of search1 after reset, not 3
			assert.strictEqual(result.continue, true);
		});

		it("order of commands does not matter", () => {
			const healer = new ResponseHealer();
			const calls1 = { actionCalls: [{ name: "read", path: "a.js" }, { name: "read", path: "b.js" }], writeCalls: [] };
			const calls2 = { actionCalls: [{ name: "read", path: "b.js" }, { name: "read", path: "a.js" }], writeCalls: [] };
			healer.assessRepetition(calls1);
			healer.assessRepetition(calls2);
			const result = healer.assessRepetition(calls1);
			assert.strictEqual(result.continue, false);
		});

		it("reset clears repetition state", () => {
			const healer = new ResponseHealer();
			const calls = { actionCalls: [{ name: "search", path: "query" }], writeCalls: [] };
			healer.assessRepetition(calls);
			healer.assessRepetition(calls);
			healer.reset();
			healer.assessRepetition(calls);
			healer.assessRepetition(calls);
			const result = healer.assessRepetition(calls);
			assert.strictEqual(result.continue, false);
		});
	});
});
