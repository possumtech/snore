import assert from "node:assert";
import { describe, it } from "node:test";
import ResponseHealer from "./ResponseHealer.js";

// Helpers to build entry-shaped objects matching what TurnExecutor produces.
function get(path) {
	return { scheme: "get", path, attributes: { path } };
}
function sh(command) {
	return { scheme: "sh", path: null, attributes: { command } };
}
function search(query) {
	return { scheme: "search", path: null, attributes: { query } };
}

function calls(...entries) {
	return { actionCalls: entries, writeCalls: [] };
}

describe("ResponseHealer", () => {
	describe("healStatus", () => {
		it("plain text with no commands becomes summary", () => {
			const result = ResponseHealer.healStatus("I did the thing.", []);
			assert.strictEqual(result.summaryText, "I did the thing.");
			assert.strictEqual(result.updateText, null);
		});

		it("truncates long plain text summary to 500 chars", () => {
			const long = "x".repeat(600);
			const result = ResponseHealer.healStatus(long, []);
			assert.strictEqual(result.summaryText.length, 500);
			assert.strictEqual(result.updateText, null);
		});

		it("commands with no status tag becomes update placeholder", () => {
			const result = ResponseHealer.healStatus("", [{ name: "get" }]);
			assert.strictEqual(result.summaryText, null);
			assert.strictEqual(result.updateText, "...");
		});

		it("empty content with no commands becomes update placeholder", () => {
			const result = ResponseHealer.healStatus("", []);
			assert.strictEqual(result.summaryText, null);
			assert.strictEqual(result.updateText, "...");
		});

		it("whitespace-only content becomes update placeholder", () => {
			const result = ResponseHealer.healStatus("   \n  ", []);
			assert.strictEqual(result.summaryText, null);
			assert.strictEqual(result.updateText, "...");
		});

		it("malformed native tool call is glitch, not summary", () => {
			const malformed = '<|tool_call>call:set path="X">body</set><tool_call|>';
			const result = ResponseHealer.healStatus(malformed, []);
			// Must NOT be treated as summary — that would terminate the run
			// after a single turn instead of letting the 3-strikes stall path
			// give the model a chance to recover.
			assert.strictEqual(result.summaryText, null);
			assert.strictEqual(result.updateText, "...");
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
		it("no commands does not contribute to cycle history", () => {
			const healer = new ResponseHealer();
			const result = healer.assessRepetition({
				actionCalls: [],
				writeCalls: [],
			});
			assert.strictEqual(result.continue, true);
		});

		it("AAAA — same turn repeated 3x force-completes (period 1)", () => {
			const healer = new ResponseHealer();
			const turn = calls(get("src/app.js"));
			healer.assessRepetition(turn);
			healer.assessRepetition(turn);
			const result = healer.assessRepetition(turn);
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("period 1"));
		});

		it("ABABAB — alternating pattern force-completes after 3 cycles (period 2)", () => {
			const healer = new ResponseHealer();
			const A = calls(get("src/app.js"));
			const B = calls(sh("grep TODO src/app.js"));
			// First 5 turns (incomplete — only 2 full cycles of AB at most)
			for (let i = 0; i < 5; i++) {
				const r = healer.assessRepetition(i % 2 === 0 ? A : B);
				assert.strictEqual(r.continue, true, `should continue at turn ${i}`);
			}
			// 6th turn completes ABABAB — 3 full cycles
			const result = healer.assessRepetition(B);
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("period 2"));
		});

		it("ABCABCABC — 3-period cycle force-completes after 3 cycles", () => {
			const healer = new ResponseHealer();
			const A = calls(get("src/app.js"));
			const B = calls(sh("grep TODO src/app.js"));
			const C = calls(search("error handler"));
			const pattern = [A, B, C];
			// 8 turns (2 full cycles + 2 — not yet 3 full cycles)
			for (let i = 0; i < 8; i++) {
				const r = healer.assessRepetition(pattern[i % 3]);
				assert.strictEqual(r.continue, true, `should continue at turn ${i}`);
			}
			// 9th turn completes the 3rd ABC cycle
			const result = healer.assessRepetition(C);
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("period 3"));
		});

		it("varied commands with no repeating cycle continue indefinitely", () => {
			const healer = new ResponseHealer();
			const turns = [
				calls(get("a.js")),
				calls(get("b.js")),
				calls(get("a.js")),
				calls(search("query")),
				calls(get("a.js")),
				calls(get("c.js")),
			];
			for (const turn of turns) {
				const r = healer.assessRepetition(turn);
				assert.strictEqual(r.continue, true);
			}
		});

		it("order of commands within a turn does not matter", () => {
			const healer = new ResponseHealer();
			const fwd = { actionCalls: [get("a.js"), get("b.js")], writeCalls: [] };
			const rev = { actionCalls: [get("b.js"), get("a.js")], writeCalls: [] };
			healer.assessRepetition(fwd);
			healer.assessRepetition(rev);
			const result = healer.assessRepetition(fwd);
			// [fwd, rev, fwd] = [A, A, A] since order-normalized — period 1, 3 reps
			assert.strictEqual(result.continue, false);
		});

		it("fidelity attribute differentiates otherwise identical operations", () => {
			const healer = new ResponseHealer();
			const full = calls({
				scheme: "get",
				path: "src/app.js",
				attributes: { path: "src/app.js", fidelity: "promoted" },
			});
			const summary = calls({
				scheme: "get",
				path: "src/app.js",
				attributes: { path: "src/app.js", fidelity: "demoted" },
			});
			// ABABAB — different fingerprints due to fidelity, should be period 2
			for (let i = 0; i < 5; i++) {
				healer.assessRepetition(i % 2 === 0 ? full : summary);
			}
			const result = healer.assessRepetition(summary);
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("period 2"));
		});

		it("reset clears cycle history", () => {
			const healer = new ResponseHealer();
			const turn = calls(get("src/app.js"));
			healer.assessRepetition(turn);
			healer.assessRepetition(turn);
			healer.reset();
			// After reset, history is empty — needs 3 more to trigger
			healer.assessRepetition(turn);
			healer.assessRepetition(turn);
			const result = healer.assessRepetition(turn);
			assert.strictEqual(result.continue, false);
		});

		it("path stagnation: same path touched in 5 consecutive turns force-completes", () => {
			const healer = new ResponseHealer();
			// Each turn touches the same path but with varying commands so
			// fingerprints differ and the exact-cycle detector doesn't fire.
			const P = "known://project_review/plan";
			const setCmd = {
				scheme: "set",
				path: P,
				attributes: { path: P, summary: "plan,a" },
			};
			const getCmd = {
				scheme: "get",
				path: P,
				attributes: { path: P },
			};
			// 4 varied turns — no fingerprint cycle, no stagnation yet.
			for (const fp of ["a", "b", "c", "d"]) {
				const r = healer.assessRepetition({
					actionCalls: [getCmd],
					writeCalls: [
						{ ...setCmd, attributes: { ...setCmd.attributes, summary: fp } },
					],
				});
				assert.strictEqual(r.continue, true);
			}
			// 5th turn — path has been touched 5 consecutive turns, flag.
			const result = healer.assessRepetition({
				actionCalls: [getCmd],
				writeCalls: [setCmd],
			});
			assert.strictEqual(result.continue, false);
			assert.ok(result.reason.includes("Path stagnation"));
			assert.ok(result.reason.includes(P));
		});

		it("path stagnation does not flag when paths change", () => {
			const healer = new ResponseHealer();
			// Each turn touches a different path — no stagnation.
			for (const p of [
				"src/a.js",
				"src/b.js",
				"src/c.js",
				"src/d.js",
				"src/e.js",
				"src/f.js",
			]) {
				const r = healer.assessRepetition({
					actionCalls: [{ scheme: "get", path: p, attributes: { path: p } }],
					writeCalls: [],
				});
				assert.strictEqual(r.continue, true);
			}
		});
	});
});
