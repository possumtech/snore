import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("State lock: proposed entries block execution", () => {
	let tdb, store, RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
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
		await store.upsert(RUN_ID, 1, "set://1", "diff content", 202, {
			attributes: { file: "app.js" },
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "set://1");
	});

	it("multiple proposed entries all returned", async () => {
		await store.upsert(RUN_ID, 1, "sh://1", "echo hi", 202);

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 2);
	});

	it("resolving an entry removes it from unresolved", async () => {
		await store.resolve(RUN_ID, "set://1", 200, "applied");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "sh://1");
	});

	it("resolving all entries clears the lock", async () => {
		await store.resolve(RUN_ID, "sh://1", 403, "rejected");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});

	it("non-proposed result entries do not block", async () => {
		await store.upsert(RUN_ID, 1, "env://2", "contents", 200);
		await store.upsert(RUN_ID, 1, "summarize://2", "summary text", 200, {
			fidelity: "demoted",
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});
});
