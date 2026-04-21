import assert from "node:assert";
import { describe, it } from "node:test";
import ResponseHealer from "./ResponseHealer.js";

function get(path) {
	return { scheme: "get", path, attributes: { path } };
}
function sh(command) {
	return { scheme: "sh", path: null, attributes: { command } };
}
function search(query) {
	return { scheme: "search", path: null, attributes: { query } };
}
function update(body) {
	return { scheme: "update", path: null, attributes: { status: 102 }, body };
}

describe("ResponseHealer", () => {
	describe("healStatus", () => {
		it("returns contract reminder with no synthesis", () => {
			const r = ResponseHealer.healStatus();
			assert.strictEqual(r.summaryText, null);
			assert.strictEqual(r.updateText, null);
			assert.ok(r.warning.includes("update"));
			assert.ok(r.warning.includes("200"));
			assert.ok(r.warning.includes("1xx"));
		});
	});

	describe("assessTurn — terminal", () => {
		it("terminal summary with no strike + no errors → 200", () => {
			const h = new ResponseHealer();
			const r = h.assessTurn({
				summaryText: "all done",
				recorded: [update("all done")],
			});
			assert.strictEqual(r.continue, false);
			assert.strictEqual(r.status, 200);
		});

		it("summary + strike (missing status) → not terminal", () => {
			const h = new ResponseHealer();
			const r = h.assessTurn({
				summaryText: "all done",
				strike: true,
				recorded: [update("all done")],
			});
			assert.strictEqual(r.continue, true);
		});

		it("summary + hasErrors → not terminal", () => {
			const h = new ResponseHealer();
			const r = h.assessTurn({
				summaryText: "all done",
				hasErrors: true,
				recorded: [update("all done")],
			});
			assert.strictEqual(r.continue, true);
		});
	});

	describe("assessTurn — three strikes", () => {
		it("three consecutive strikes → 499", () => {
			const h = new ResponseHealer();
			h.assessTurn({ strike: true, recorded: [get("a")] });
			h.assessTurn({ strike: true, recorded: [get("b")] });
			const r = h.assessTurn({ strike: true, recorded: [get("c")] });
			assert.strictEqual(r.continue, false);
			assert.strictEqual(r.status, 499);
			assert.ok(r.reason);
		});

		it("clean turn resets streak", () => {
			const h = new ResponseHealer();
			h.assessTurn({ strike: true, recorded: [get("a")] });
			h.assessTurn({ strike: true, recorded: [get("b")] });
			h.assessTurn({
				updateText: "working",
				recorded: [update("working"), get("c")],
			});
			const r = h.assessTurn({ strike: true, recorded: [get("d")] });
			assert.strictEqual(r.continue, true);
		});

		it("hasErrors alone counts as a strike", () => {
			const h = new ResponseHealer();
			h.assessTurn({ hasErrors: true, recorded: [get("a")] });
			h.assessTurn({ hasErrors: true, recorded: [get("b")] });
			const r = h.assessTurn({ hasErrors: true, recorded: [get("c")] });
			assert.strictEqual(r.continue, false);
			assert.strictEqual(r.status, 499);
		});

		it("mixed strike sources all accrue to the same counter", () => {
			const h = new ResponseHealer();
			h.assessTurn({ strike: true, recorded: [get("a")] });
			h.assessTurn({ hasErrors: true, recorded: [get("b")] });
			const r = h.assessTurn({ strike: true, recorded: [get("c")] });
			assert.strictEqual(r.continue, false);
			assert.strictEqual(r.status, 499);
		});

		it("contract reminder returned on each non-terminal strike below threshold", () => {
			const h = new ResponseHealer();
			const r = h.assessTurn({ strike: true, recorded: [get("a")] });
			assert.strictEqual(r.continue, true);
			assert.ok(r.reason.includes("update"));
			assert.ok(r.reason.includes("200"));
		});
	});

	describe("assessTurn — repetition strike", () => {
		it("AAA period-1 cycle → strike", () => {
			const h = new ResponseHealer();
			h.assessTurn({ updateText: "x", recorded: [get("src/app.js")] });
			h.assessTurn({ updateText: "x", recorded: [get("src/app.js")] });
			const r = h.assessTurn({
				updateText: "x",
				recorded: [get("src/app.js")],
			});
			assert.ok(r.reason?.includes("period 1"));
		});

		it("ABABAB period-2 cycle → strike on 6th turn", () => {
			const h = new ResponseHealer();
			const A = [get("src/app.js")];
			const B = [sh("grep TODO src/app.js")];
			for (let i = 0; i < 5; i++) {
				const r = h.assessTurn({
					updateText: "x",
					recorded: i % 2 === 0 ? A : B,
				});
				assert.strictEqual(r.continue, true);
			}
			const r = h.assessTurn({ updateText: "x", recorded: B });
			assert.ok(r.reason?.includes("period 2"));
		});

		it("three cycle strikes in a row → 499", () => {
			const h = new ResponseHealer();
			const turn = [get("src/app.js")];
			h.assessTurn({ updateText: "x", recorded: turn });
			h.assessTurn({ updateText: "x", recorded: turn });
			// 3rd hit: first strike via cycle detection.
			h.assessTurn({ updateText: "x", recorded: turn });
			h.assessTurn({ updateText: "x", recorded: turn });
			const r = h.assessTurn({ updateText: "x", recorded: turn });
			assert.strictEqual(r.continue, false);
			assert.strictEqual(r.status, 499);
		});

		it("empty recorded does not contribute to cycle history", () => {
			const h = new ResponseHealer();
			h.assessTurn({ updateText: "x", recorded: [] });
			h.assessTurn({ updateText: "x", recorded: [] });
			const r = h.assessTurn({ updateText: "x", recorded: [] });
			assert.strictEqual(r.continue, true);
		});

		it("varied commands continue indefinitely", () => {
			const h = new ResponseHealer();
			const turns = [
				[get("a.js")],
				[get("b.js")],
				[get("a.js")],
				[search("q")],
				[get("a.js")],
				[get("c.js")],
			];
			for (const t of turns) {
				const r = h.assessTurn({ updateText: "x", recorded: t });
				assert.strictEqual(r.continue, true);
			}
		});
	});

	describe("reset", () => {
		it("clears streak and history", () => {
			const h = new ResponseHealer();
			h.assessTurn({ strike: true, recorded: [get("a")] });
			h.assessTurn({ strike: true, recorded: [get("a")] });
			h.reset();
			const r = h.assessTurn({ strike: true, recorded: [get("a")] });
			assert.strictEqual(r.continue, true);
		});
	});
});
