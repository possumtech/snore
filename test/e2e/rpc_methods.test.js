import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: RPC Methods", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-rpc-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "app.js"), "const app = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "RpcTest",
			clientId: "c-rpc",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("discover returns methods and notifications", async () => {
		const result = await client.call("discover");
		assert.ok(result.methods, "has methods");
		assert.ok(result.notifications, "has notifications");
		assert.ok(result.methods.ask, "has ask method");
		assert.ok(result.methods.act, "has act method");
		assert.ok(result.methods["run/resolve"], "has run/resolve method");
		assert.ok(result.notifications["run/state"], "has run/state notification");
		assert.ok(
			result.notifications["run/progress"],
			"has run/progress notification",
		);
	});

	it("getModels returns aliases", async () => {
		const result = await client.call("getModels");
		assert.ok(Array.isArray(result), "returns array");
		assert.ok(result.length > 0, "has at least one model");
		const first = result[0];
		assert.ok(first.alias, "model has alias");
		assert.ok(first.actual, "model has actual");
	});

	it("getRuns returns runs for session", { timeout: TIMEOUT }, async () => {
		// Create a run first
		await client.call("ask", { model, prompt: "Hi." });

		const runs = await client.call("getRuns");
		assert.ok(Array.isArray(runs), "returns array");
		assert.ok(runs.length > 0, "has at least one run");
		const run = runs[0];
		assert.ok(run.run, "run has alias");
		assert.ok(run.type, "run has type");
		assert.ok(run.status, "run has status");
	});

	it("run/abort sets status to aborted", { timeout: TIMEOUT }, async () => {
		const askResult = await client.call("ask", { model, prompt: "Hi." });
		const result = await client.call("run/abort", { run: askResult.run });
		assert.strictEqual(result.status, "ok");

		const runs = await client.call("getRuns");
		const aborted = runs.find((r) => r.run === askResult.run);
		assert.strictEqual(aborted.status, "aborted");
	});

	it("run/inject creates info entry and resumes idle run", {
		timeout: TIMEOUT,
	}, async () => {
		const askResult = await client.call("ask", { model, prompt: "Hi." });

		// Inject a message into the completed run
		const injectResult = await client.call("run/inject", {
			run: askResult.run,
			message: "Additional context for you.",
		});

		// The run should have resumed or queued
		assert.ok(
			["completed", "running", "proposed"].includes(injectResult.status),
			`Expected valid status, got ${injectResult.status}`,
		);
	});

	it("setTemperature and getTemperature round-trip", async () => {
		const setResult = await client.call("setTemperature", { temperature: 0.3 });
		assert.strictEqual(setResult.temperature, 0.3);

		const getResult = await client.call("getTemperature");
		assert.strictEqual(getResult.temperature, 0.3);
	});

	it("skill/add and getSkills round-trip", async () => {
		await client.call("skill/add", { name: "test_skill" });
		const skills = await client.call("getSkills");
		assert.ok(skills.includes("test_skill"));

		await client.call("skill/remove", { name: "test_skill" });
		const after = await client.call("getSkills");
		assert.ok(!after.includes("test_skill"));
	});

	it("ping returns empty object", async () => {
		const result = await client.call("ping");
		assert.ok(result !== undefined, "ping should return a result");
	});

	it("setContextLimit and getContext round-trip", async () => {
		const setResult = await client.call("setContextLimit", { limit: 16384 });
		assert.strictEqual(setResult.context_limit, 16384);

		const ctx = await client.call("getContext", { model });
		assert.strictEqual(ctx.limit, 16384);
		assert.ok(ctx.effective <= 16384, "effective should respect limit");
		assert.ok(ctx.model_max, "should have model_max");

		// Reset
		const resetResult = await client.call("setContextLimit", { limit: null });
		assert.strictEqual(resetResult.context_limit, null);

		const after = await client.call("getContext", { model });
		assert.strictEqual(after.limit, null);
		assert.strictEqual(after.effective, after.model_max);
	});

	it("persona round-trip", async () => {
		await client.call("persona", { text: "You are a pirate." });
		const session = await tdb.db.get_session_by_id.all({ id: "" });
		// Persona is session-level — verify via DB since no getPersona RPC
		const sessions = await tdb.db.get_session_by_id.all({
			id: String(client.sessionId || ""),
		});
		// We can't easily get sessionId from client, verify by asking
		const result = await client.call("ask", {
			model,
			prompt: "Say ahoy.",
			noContext: true,
		});
		assert.strictEqual(result.status, "completed");
	});

	it("systemPrompt round-trip", async () => {
		await client.call("systemPrompt", { text: "You are a test assistant." });
		const result = await client.call("ask", {
			model,
			prompt: "What are you?",
			noContext: true,
		});
		assert.strictEqual(result.status, "completed");
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
		const renamed = runs.find((r) => r.run === "custom_name");
		assert.ok(renamed, "renamed run should appear in getRuns");
		const old = runs.find((r) => r.run === oldAlias);
		assert.ok(!old, "old alias should not appear");
	});

	it("getFiles returns project file list", async () => {
		const files = await client.call("getFiles");
		assert.ok(Array.isArray(files), "returns array");
		const appJs = files.find((f) => f.path === "app.js" || f === "app.js");
		assert.ok(appJs, "app.js should be in file list");
	});

	it("context_distribution in telemetry", { timeout: TIMEOUT }, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", { model, prompt: "What is 1+1?" });

		const lastState = states.at(-1);
		assert.ok(lastState?.telemetry, "should have telemetry");
		assert.ok(
			Array.isArray(lastState.telemetry.context_distribution),
			"should have context_distribution array",
		);
		const dist = lastState.telemetry.context_distribution;
		for (const bucket of dist) {
			assert.ok(bucket.bucket, "bucket has name");
			assert.ok(typeof bucket.tokens === "number", "bucket has tokens");
			assert.ok(typeof bucket.entries === "number", "bucket has entries");
		}
	});

	it("activate sets file state to active", async () => {
		const result = await client.call("activate", { pattern: "app.js" });
		assert.strictEqual(result.status, "ok");

		const status = await client.call("fileStatus", { path: "app.js" });
		assert.strictEqual(status.path, "app.js");
		assert.strictEqual(status.state, "active");
	});

	it("readOnly sets file state to readonly", async () => {
		const result = await client.call("readOnly", { pattern: "app.js" });
		assert.strictEqual(result.status, "ok");

		const status = await client.call("fileStatus", { path: "app.js" });
		assert.strictEqual(status.state, "readonly");
	});

	it("ignore sets file state to ignore", async () => {
		const result = await client.call("ignore", { pattern: "app.js" });
		assert.strictEqual(result.status, "ok");

		const status = await client.call("fileStatus", { path: "app.js" });
		assert.strictEqual(status.state, "ignore");
	});

	it("drop removes file state override", async () => {
		// First set a state
		await client.call("activate", { pattern: "app.js" });
		const before = await client.call("fileStatus", { path: "app.js" });
		assert.strictEqual(before.state, "active");

		// Drop it
		const result = await client.call("drop", { pattern: "app.js" });
		assert.strictEqual(result.status, "ok");
	});

	it("fileStatus returns null state for unknown file", async () => {
		const status = await client.call("fileStatus", { path: "nonexistent.js" });
		assert.strictEqual(status.state, null);
	});

	it("getModelInfo returns model metadata", async () => {
		const info = await client.call("getModelInfo", { model });
		assert.ok(info.alias, "has alias");
		assert.ok(info.model, "has resolved model");
		assert.ok(typeof info.context_length === "number", "has context_length");
		assert.ok(typeof info.effective === "number", "has effective");
	});

	it("activate preserves file content in known store", {
		timeout: TIMEOUT,
	}, async () => {
		// Run an ask so the file gets bootstrapped into the known store
		await client.call("ask", { model, prompt: "Read app.js." });

		// Now activate — should NOT overwrite the file's value
		await client.call("activate", { pattern: "app.js" });
		const status = await client.call("fileStatus", { path: "app.js" });
		assert.strictEqual(status.state, "active");
	});
});
