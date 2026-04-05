import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 120_000;

describe("E2E: RPC Methods", () => {
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-rpc-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "app.js"), "const app = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
			name: "RpcTest",
			projectRoot,
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("discover returns methods and notifications", async () => {
		const result = await client.call("discover");
		assert.ok(result.methods, "has methods");
		assert.ok(result.notifications, "has notifications");
		assert.ok(result.methods.ask, "has ask method");
		assert.ok(result.methods.act, "has act method");
		assert.ok(result.methods["run/resolve"], "has run/resolve method");
		assert.ok(result.methods.read, "has read method");
		assert.ok(result.methods.store, "has store method");
		assert.ok(result.methods.getEntries, "has getEntries method");
		assert.ok(result.methods.addModel, "has addModel method");
		assert.ok(result.notifications["run/state"], "has run/state notification");
	});

	it("getModels returns model list from DB", async () => {
		const result = await client.call("getModels");
		assert.ok(Array.isArray(result), "returns array");
		assert.ok(result.length > 0, "has at least one model");
		const first = result[0];
		assert.ok(first.alias, "model has alias");
		assert.ok(first.actual, "model has actual");
	});

	it("addModel and removeModel round-trip", async () => {
		const added = await client.call("addModel", {
			alias: "potato",
			actual: "openai/potato-3000",
			contextLength: 16000,
		});
		assert.ok(added.id, "returns model id");
		assert.strictEqual(added.alias, "potato");

		const models = await client.call("getModels");
		const potato = models.find((m) => m.alias === "potato");
		assert.ok(potato, "potato in model list");
		assert.strictEqual(potato.actual, "openai/potato-3000");
		assert.strictEqual(potato.context_length, 16000);

		await client.call("removeModel", { alias: "potato" });
		const after = await client.call("getModels");
		assert.ok(!after.find((m) => m.alias === "potato"), "potato removed");
	});

	it("getRuns returns runs for project", { timeout: TIMEOUT }, async () => {
		await client.call("ask", { model, prompt: "Hi." });

		const runs = await client.call("getRuns");
		assert.ok(Array.isArray(runs), "returns array");
		assert.ok(runs.length > 0, "has at least one run");
		const run = runs[0];
		assert.ok(run.run, "run has alias");
		assert.ok(run.status, "run has status");
	});

	it("run/abort sets status to aborted", { timeout: TIMEOUT }, async () => {
		// Start a long-running ask without awaiting completion
		const askPromise = client.call("ask", {
			model,
			prompt:
				"Carefully analyze every file in this project. Write a 500-word essay about each one.",
		});
		// Give it time to start, then abort
		await new Promise((r) => setTimeout(r, 1000));
		const runs = await client.call("getRuns");
		const active = runs.find((r) => r.status === "running");
		if (active) {
			const result = await client.call("run/abort", { run: active.run });
			assert.strictEqual(result.status, "ok");
			const after = await client.call("getRuns");
			const aborted = after.find((r) => r.run === active.run);
			assert.strictEqual(aborted.status, "aborted");
		}
		await askPromise.catch(() => {});
	});

	it("run/inject resumes idle run", { timeout: TIMEOUT }, async () => {
		const askResult = await client.call("ask", { model, prompt: "Hi." });

		const injectResult = await client.call("run/inject", {
			run: askResult.run,
			message: "Additional context.",
		});

		assert.ok(
			["completed", "running", "proposed"].includes(injectResult.status),
			`Expected valid status, got ${injectResult.status}`,
		);
	});

	it("run/config updates run settings", { timeout: TIMEOUT }, async () => {
		const askResult = await client.call("ask", { model, prompt: "Hi." });

		await client.call("run/config", {
			run: askResult.run,
			temperature: 0.3,
			persona: "You are a pirate.",
		});

		const runDetail = await client.call("getRun", { run: askResult.run });
		assert.strictEqual(runDetail.temperature, 0.3);
		assert.strictEqual(runDetail.persona, "You are a pirate.");
	});

	it("ping returns empty object", async () => {
		const result = await client.call("ping");
		assert.ok(result !== undefined, "ping returns result");
	});

	it("run/rename changes run alias", { timeout: TIMEOUT }, async () => {
		const askResult = await client.call("ask", { model, prompt: "Hi." });
		const oldAlias = askResult.run;

		const renameResult = await client.call("run/rename", {
			run: oldAlias,
			name: "custom_name",
		});
		assert.strictEqual(renameResult.run, "custom_name");

		const runs = await client.call("getRuns");
		assert.ok(
			runs.find((r) => r.run === "custom_name"),
			"renamed run in getRuns",
		);
		assert.ok(!runs.find((r) => r.run === oldAlias), "old alias gone");
	});

	it("read with persist activates file", async () => {
		const result = await client.call("read", {
			path: "app.js",
			persist: true,
		});
		assert.strictEqual(result.status, "ok");
	});

	it("read with persist + readonly sets readonly", async () => {
		const result = await client.call("read", {
			path: "app.js",
			persist: true,
			readonly: true,
		});
		assert.strictEqual(result.status, "ok");
	});

	it("store with persist + ignore excludes file", async () => {
		const result = await client.call("store", {
			path: "app.js",
			persist: true,
			ignore: true,
		});
		assert.strictEqual(result.status, "ok");
	});

	it("store with persist + clear removes constraint", async () => {
		await client.call("read", { path: "app.js", persist: true });
		const result = await client.call("store", {
			path: "app.js",
			persist: true,
			clear: true,
		});
		assert.strictEqual(result.status, "ok");
	});

	it("getEntries returns file entries", { timeout: TIMEOUT }, async () => {
		const r = await client.call("ask", { model, prompt: "Say hi." });

		const entries = await client.call("getEntries", {
			run: r.run,
		});
		assert.ok(Array.isArray(entries), "returns array");
		assert.ok(entries.length > 0, "has entries");
		// Should have at least file entries from the scan
		const fileEntries = entries.filter((e) => e.scheme === null);
		assert.ok(fileEntries.length > 0, "has file entries from scan");
	});

	it("context_distribution in telemetry", { timeout: TIMEOUT }, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", { model, prompt: "What is 1+1?" });

		const lastState = states.at(-1);
		assert.ok(lastState?.telemetry, "has telemetry");
		assert.ok(
			Array.isArray(lastState.telemetry.context_distribution),
			"has context_distribution array",
		);
		const dist = lastState.telemetry.context_distribution;
		for (const bucket of dist) {
			assert.ok(bucket.bucket, "bucket has name");
			assert.ok(typeof bucket.tokens === "number", "bucket has tokens");
			assert.ok(typeof bucket.entries === "number", "bucket has entries");
		}
	});

	it("ask requires model param", async () => {
		await assert.rejects(
			() => client.call("ask", { prompt: "Hi." }),
			/model is required/,
		);
	});
});
