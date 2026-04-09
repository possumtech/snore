import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import BudgetGuard, { BudgetExceeded } from "../../src/agent/BudgetGuard.js";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Budget enforcement at KnownStore layer", () => {
	let tdb;
	let store;

	before(async () => {
		tdb = await TestDb.create("budget_enforce");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("upsert throws BudgetExceeded when over budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_1" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		store.budgetGuard = new BudgetGuard(100, 90);

		await assert.rejects(
			() => store.upsert(runId, 1, "known://big", "x".repeat(5000), 200),
			(err) => {
				assert.ok(err instanceof BudgetExceeded);
				assert.strictEqual(err.status, 413);
				return true;
			},
		);

		store.budgetGuard = null;
	});

	it("upsert succeeds when under budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_2" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		store.budgetGuard = new BudgetGuard(100000, 0);

		await store.upsert(runId, 1, "known://small", "hello", 200);
		const body = await store.getBody(runId, "known://small");
		assert.strictEqual(body, "hello");

		store.budgetGuard = null;
	});

	it("model_visible=0 entries bypass budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_3" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		store.budgetGuard = new BudgetGuard(100, 100);

		// Guard has 0 remaining, but system:// is model_visible=0
		await store.upsert(runId, 1, "system://1", "x".repeat(5000), 200);
		const body = await store.getBody(runId, "system://1");
		assert.ok(body.length > 0, "audit entry written despite zero budget");

		store.budgetGuard = null;
	});

	it("status >= 400 entries bypass budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_4" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		const guard = new BudgetGuard(100, 100);
		guard.trip("test");
		store.budgetGuard = guard;

		// Guard is tripped, but 413 error entries must write
		await store.upsert(runId, 1, "set://error", "Budget exceeded", 413);
		const body = await store.getBody(runId, "set://error");
		assert.strictEqual(body, "Budget exceeded");

		store.budgetGuard = null;
	});

	it("fidelity=stored entries bypass budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_5" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		store.budgetGuard = new BudgetGuard(100, 100);

		await store.upsert(runId, 1, "known://archived", "big content", 200, {
			fidelity: "stored",
		});
		const body = await store.getBody(runId, "known://archived");
		assert.strictEqual(body, "big content");

		store.budgetGuard = null;
	});

	it("trip cascades — all subsequent writes fail", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_6" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		const guard = new BudgetGuard(100000, 0);
		guard.trip("first://fail");
		store.budgetGuard = guard;

		await assert.rejects(
			() => store.upsert(runId, 1, "known://after", "tiny", 200),
			(err) => err instanceof BudgetExceeded,
		);

		store.budgetGuard = null;
	});

	it("delta calculation — update charges only the difference", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_7" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);

		// First write without guard
		await store.upsert(runId, 1, "known://delta", "original content", 200);

		// Now set a tight guard — only room for the delta
		const guard = new BudgetGuard(100000, 99990);
		store.budgetGuard = guard;

		// Slightly larger update — delta is small, should fit
		await store.upsert(runId, 1, "known://delta", "original content!", 200);
		assert.ok(guard.spent > 0, "guard charged the delta");
		assert.ok(guard.spent < 100, "delta is small, not full entry cost");

		store.budgetGuard = null;
	});

	it("guard cleared after use — writes succeed freely", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_8" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);

		const guard = new BudgetGuard(100, 100);
		guard.trip("blocker");
		store.budgetGuard = guard;

		await assert.rejects(
			() => store.upsert(runId, 1, "known://blocked", "data", 200),
			(err) => err instanceof BudgetExceeded,
		);

		store.budgetGuard = null;

		await store.upsert(runId, 1, "known://free", "data", 200);
		const body = await store.getBody(runId, "known://free");
		assert.strictEqual(body, "data");
	});

	it("promoteByPattern throws when promotion exceeds budget", async () => {
		const { runId } = await tdb.seedRun({ alias: "be_9" });
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);

		// Create a stored entry with substantial content
		await store.upsert(runId, 1, "src/big.js", "x".repeat(5000), 200, {
			fidelity: "stored",
		});

		// Set tight budget
		store.budgetGuard = new BudgetGuard(100, 90);

		await assert.rejects(
			() => store.promoteByPattern(runId, "src/big.js", null, 2),
			(err) => err instanceof BudgetExceeded,
		);

		store.budgetGuard = null;
	});
});
