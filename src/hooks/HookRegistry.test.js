import assert from "node:assert/strict";
import { describe, it } from "node:test";
import HookRegistry from "./HookRegistry.js";

describe("HookRegistry", () => {
	describe("processors", () => {
		it("processTurn invokes processors in priority order (low → high)", async () => {
			const reg = new HookRegistry();
			const order = [];
			reg.onTurn(async () => order.push("c"), 30);
			reg.onTurn(async () => order.push("a"), 10);
			reg.onTurn(async () => order.push("b"), 20);
			await reg.processTurn({});
			assert.deepEqual(order, ["a", "b", "c"]);
		});

		it("processTurn passes the rummy arg to each processor", async () => {
			const reg = new HookRegistry();
			const seen = [];
			reg.onTurn(async (r) => seen.push(r));
			const rummy = { id: 1 };
			await reg.processTurn(rummy);
			assert.deepEqual(seen, [rummy]);
		});

		it("debug=true emits per-processor timing log", async () => {
			const reg = new HookRegistry(true);
			const original = console.log;
			const captured = [];
			console.log = (...args) => captured.push(args.join(" "));
			try {
				reg.onTurn(async function named() {});
				await reg.processTurn({});
				assert.ok(captured.some((line) => /Processor named took/.test(line)));
			} finally {
				console.log = original;
			}
		});

		it("debug=true falls back to 'anonymous' for unnamed callbacks", async () => {
			const reg = new HookRegistry(true);
			const original = console.log;
			const captured = [];
			console.log = (...args) => captured.push(args.join(" "));
			try {
				const fn = async () => {};
				Object.defineProperty(fn, "name", { value: "" });
				reg.onTurn(fn);
				await reg.processTurn({});
				assert.ok(
					captured.some((line) => /Processor anonymous took/.test(line)),
				);
			} finally {
				console.log = original;
			}
		});
	});

	describe("filters", () => {
		it("applyFilters returns the original value when tag has no hooks", async () => {
			const reg = new HookRegistry();
			const out = await reg.applyFilters("missing", "v");
			assert.equal(out, "v");
		});

		it("applyFilters chains hooks in priority order", async () => {
			const reg = new HookRegistry();
			reg.addFilter("t", async (v) => `${v}-c`, 30);
			reg.addFilter("t", async (v) => `${v}-a`, 10);
			reg.addFilter("t", async (v) => `${v}-b`, 20);
			const out = await reg.applyFilters("t", "x");
			assert.equal(out, "x-a-b-c");
		});

		it("applyFilters forwards extra args to each filter", async () => {
			const reg = new HookRegistry();
			let captured;
			reg.addFilter("t", async (v, a, b) => {
				captured = [a, b];
				return v;
			});
			await reg.applyFilters("t", "x", 1, 2);
			assert.deepEqual(captured, [1, 2]);
		});
	});

	describe("events", () => {
		it("emitEvent invokes listeners in priority order", async () => {
			const reg = new HookRegistry();
			const order = [];
			reg.addEvent("e", async () => order.push("c"), 30);
			reg.addEvent("e", async () => order.push("a"), 10);
			reg.addEvent("e", async () => order.push("b"), 20);
			await reg.emitEvent("e");
			assert.deepEqual(order, ["a", "b", "c"]);
		});

		it("emitEvent forwards args to all listeners", async () => {
			const reg = new HookRegistry();
			const seen = [];
			reg.addEvent("e", async (...args) => seen.push(args));
			reg.addEvent("e", async (...args) => seen.push(args));
			await reg.emitEvent("e", 1, 2);
			assert.deepEqual(seen, [
				[1, 2],
				[1, 2],
			]);
		});

		it("emitEvent on unknown tag is a no-op", async () => {
			const reg = new HookRegistry();
			await reg.emitEvent("missing"); // should not throw
		});

		it("removeEvent removes a previously-registered callback", async () => {
			const reg = new HookRegistry();
			let called = 0;
			const cb = async () => {
				called += 1;
			};
			reg.addEvent("e", cb);
			reg.removeEvent("e", cb);
			await reg.emitEvent("e");
			assert.equal(called, 0);
		});

		it("removeEvent on unknown tag is a no-op (no throw)", () => {
			const reg = new HookRegistry();
			reg.removeEvent("missing", () => {});
		});

		it("removeEvent on registered tag with non-matching callback leaves listeners intact", async () => {
			const reg = new HookRegistry();
			let called = 0;
			reg.addEvent("e", async () => {
				called += 1;
			});
			reg.removeEvent("e", () => {});
			await reg.emitEvent("e");
			assert.equal(called, 1);
		});
	});
});
