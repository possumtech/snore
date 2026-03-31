import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("State lock: proposed entries block execution", () => {
	let tdb, store;
	const RUN_ID = "run-lock-1";

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);

		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/test",
			name: "Test",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: RUN_ID,
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
			alias: "lock_1",
		});
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("getUnresolved returns nothing when no proposed entries", async () => {
		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});

	it("getUnresolved returns proposed entries", async () => {
		await store.upsert(RUN_ID, 1, "edit://1", "diff content", "proposed", {
			meta: { file: "app.js" },
		});

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "edit://1");
	});

	it("multiple proposed entries all returned", async () => {
		await store.upsert(RUN_ID, 1, "run://1", "echo hi", "proposed");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 2);
	});

	it("resolving an entry removes it from unresolved", async () => {
		await store.resolve(RUN_ID, "edit://1", "pass", "applied");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 1);
		assert.strictEqual(unresolved[0].path, "run://1");
	});

	it("resolving all entries clears the lock", async () => {
		await store.resolve(RUN_ID, "run://1", "warn", "rejected");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});

	it("non-proposed result entries do not block", async () => {
		await store.upsert(RUN_ID, 1, "env://2", "contents", "pass");
		await store.upsert(RUN_ID, 1, "summary://2", "summary text", "summary");

		const unresolved = await store.getUnresolved(RUN_ID);
		assert.strictEqual(unresolved.length, 0);
	});
});
