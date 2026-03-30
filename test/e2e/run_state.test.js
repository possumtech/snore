import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: run/state notification shape", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-state-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "index.js"), "export const x = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "StateTest",
			clientId: "c-state",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("run/state has correct top-level shape", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", {
			model,
			prompt: "What is 2 + 2?",
		});

		assert.ok(states.length > 0, "Should receive run/state notification");
		const state = states.at(-1);

		assert.ok(state.run, "run alias");
		assert.ok(typeof state.turn === "number", "turn is number");
		assert.ok(
			["running", "proposed", "completed"].includes(state.status),
			`valid status: ${state.status}`,
		);
		assert.ok(typeof state.summary === "string", "summary is string");
		assert.ok(Array.isArray(state.history), "history is array");
		assert.ok(Array.isArray(state.unknowns), "unknowns is array");
		assert.ok(Array.isArray(state.proposed), "proposed is array");
		assert.ok(state.telemetry, "telemetry exists");
	});

	it("run/state.history entries have correct shape", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", {
			model,
			prompt: "Read index.js and tell me what it exports.",
		});

		const state = states.at(-1);
		assert.ok(state.history.length > 0, "history should have entries");

		for (const entry of state.history) {
			assert.ok(entry.key, `history entry has key: ${JSON.stringify(entry)}`);
			assert.ok(
				entry.status,
				`history entry has status: ${JSON.stringify(entry)}`,
			);
			assert.ok(
				"tool" in entry,
				`history entry has tool: ${JSON.stringify(entry)}`,
			);
			assert.ok(
				"target" in entry,
				`history entry has target: ${JSON.stringify(entry)}`,
			);
			assert.ok(
				"value" in entry,
				`history entry has value: ${JSON.stringify(entry)}`,
			);
		}

		// Should have at least one summary
		const summaries = state.history.filter((e) => e.status === "summary");
		assert.ok(summaries.length > 0, "history should contain summaries");
		assert.ok(summaries[0].value.length > 0, "summary should have text");
	});

	it("run/state.telemetry has model info", { timeout: TIMEOUT }, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", {
			model,
			prompt: "Say hello.",
		});

		const t = states.at(-1).telemetry;
		assert.ok(t.modelAlias, "modelAlias");
		assert.ok(t.model, "model");
		assert.ok(typeof t.temperature === "number", "temperature is number");
		assert.ok(typeof t.context_size === "number", "context_size is number");
		assert.ok(typeof t.prompt_tokens === "number", "prompt_tokens is number");
		assert.ok(
			typeof t.completion_tokens === "number",
			"completion_tokens is number",
		);
		assert.ok(typeof t.total_tokens === "number", "total_tokens is number");
		assert.ok(typeof t.cost === "number", "cost is number");
	});

	it("run/state.proposed entries include type", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		const result = await client.call("act", {
			model,
			prompt: "Run the command: echo hello",
		});

		// If the model proposed a command, check the shape
		if (result.status === "proposed") {
			const state = states.at(-1);
			assert.ok(state.proposed.length > 0, "should have proposed entries");
			for (const p of state.proposed) {
				assert.ok(p.key, "proposed has key");
				assert.ok(p.type, `proposed has type: ${JSON.stringify(p)}`);
				assert.ok(p.meta, `proposed has meta: ${JSON.stringify(p)}`);
			}
		}
	});
});
