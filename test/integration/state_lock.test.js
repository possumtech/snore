import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Repository from "../../src/agent/Repository.js";
import TestDb from "../helpers/TestDb.js";

describe("State lock: proposed entries block execution", () => {
	let tdb, store, RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new Repository(tdb.db);
		const seed = await tdb.seedRun({ alias: "lock_1" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("getUnresolved returns nothing when no proposed entries", async () => {
		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});

	it("getUnresolved returns proposed entries", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "set://1",
			body: "diff content",
			state: "proposed",
			attributes: { path: "app.js" },
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "set://1");
	});

	it("multiple proposed entries all returned", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "sh://1",
			body: "echo hi",
			state: "proposed",
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 2);
	});

	it("resolving an entry removes it from unresolved", async () => {
		await store.set({
			runId: RUN_ID,
			path: "set://1",
			state: "resolved",
			body: "applied",
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "sh://1");
	});

	it("resolving all entries clears the lock", async () => {
		await store.set({
			runId: RUN_ID,
			path: "sh://1",
			state: "failed",
			body: "rejected",
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});

	it("non-proposed result entries do not block", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "env://2",
			body: "contents",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "update://2",
			body: "summary text",
			state: "resolved",
			fidelity: "demoted",
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});
});
