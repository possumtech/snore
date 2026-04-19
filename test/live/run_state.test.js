import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 180_000;

describe("E2E: run/state notification shape", () => {
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-state-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "index.js"), "export const x = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("rummy/hello", {
			name: "StateTest",
			projectRoot,
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("run/state has correct top-level shape", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", { model, prompt: "What is 2 + 2?" });

		assert.ok(states.length > 0, "Should receive run/state notification");
		const state = states.at(-1);

		assert.ok(state.run, "run alias");
		assert.ok(typeof state.turn === "number", "turn is number");
		assert.ok(
			[102, 202, 200].includes(state.status),
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
			assert.ok(entry.path, `entry has path: ${JSON.stringify(entry)}`);
			assert.ok(entry.status, `entry has status: ${JSON.stringify(entry)}`);
			assert.ok("tool" in entry, `entry has tool: ${JSON.stringify(entry)}`);
			assert.ok(
				"target" in entry,
				`entry has target: ${JSON.stringify(entry)}`,
			);
			assert.ok("body" in entry, `entry has body: ${JSON.stringify(entry)}`);
		}

		const summaries = state.history.filter((e) => e.status === "summary");
		assert.ok(summaries.length > 0, "history should contain summaries");
		assert.ok(summaries[0].body.length > 0, "summary should have text");
	});

	it("run/state.telemetry has model info", { timeout: TIMEOUT }, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await client.call("ask", { model, prompt: "Say hello." });

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

		if (result.status === 202) {
			const state = states.at(-1);
			assert.ok(state.proposed.length > 0, "should have proposed entries");
			for (const p of state.proposed) {
				assert.ok(p.path, "proposed has path");
				assert.ok(p.type, `proposed has type: ${JSON.stringify(p)}`);
				assert.ok(
					p.attributes,
					`proposed has attributes: ${JSON.stringify(p)}`,
				);
			}
		}
	});
});
