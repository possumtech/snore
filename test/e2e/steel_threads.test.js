import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("Steel Thread E2E", () => {
	let tdb, tserver, client;
	const projectPath = join(process.cwd(), "test_steel_thread");

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "source.txt"),
			"SECRET_KEY=GOLDEN-TICKET",
		);

		// Initialize git so RepoMap finds the files
		const { execSync } = await import("node:child_process");
		execSync("git init && git config user.email \"test@test.com\" && git config user.name \"Test\" && git add .", { cwd: projectPath });

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("ACT Steel Thread: Read source and create result file", async () => {
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			let content = "";
			if (callCount === 1) {
				// Turn 0: Model decides to read the file
				content =
					'<unknown>source.txt</unknown><tasks>- [ ] Read source</tasks><read file="source.txt"/>';
			} else if (callCount === 2) {
				// Turn 1: Model sees content and creates result
				content =
					'<known>Found GOLDEN-TICKET</known><tasks>- [x] Read source - [ ] Create result</tasks><create file="result.txt">The key is GOLDEN-TICKET</create>';
			} else {
				// Turn 2: Finality
				content =
					"<tasks>- [x] Create result</tasks><response>Task complete.</response><short>Done</short>";
			}

			return new Response(
				JSON.stringify({
					model: "mock-model",
					choices: [{ message: { role: "assistant", content } }],
					usage: { total_tokens: 10 },
				}),
			);
		};

		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params.turn));

		await client.call("init", {
			projectPath,
			projectName: "SteelThread",
			clientId: "c1",
		});

		// Run the sequence
		const result = await client.call("act", {
			model: "mock-model",
			prompt: "Read source.txt and write the key to result.txt",
		});

		// Verify Turn 0 context (RepoMap)
		const turn0 = turns[0];
		assert.ok(turn0, "Turn 0 should be recorded");
		const contextXml = turn0.context;
		assert.ok(typeof contextXml === "string", "Context should be a string of XML");
		assert.ok(contextXml.includes('<file path="source.txt"'), "source.txt must be in context XML");
		assert.ok(contextXml.includes('size="24"'), "source.txt must have size attribute in XML");
		assert.ok(contextXml.includes('tokens="14"'), "source.txt must have tokens attribute in XML");
		
		assert.strictEqual(result.status, "proposed");
		assert.strictEqual(result.turn, 1); // 0 (read) then 1 (propose create)

		// Find the finding in DB
		const findings = await tdb.db.get_findings_by_run_id.all({
			run_id: result.runId,
		});
		const diff = findings.find((f) => f.type === "create");
		assert.ok(diff);

		// Resolve via run/resolve
		const resolved = await client.call("run/resolve", {
			runId: result.runId,
			resolution: { category: "diff", id: diff.id, action: "accepted" },
		});

		assert.strictEqual(resolved.status, "completed");
		assert.strictEqual(resolved.turn, 2);

		// PHYSICAL VERIFICATION: Did the agent actually write the file?
		const createdContent = await fs.readFile(
			join(projectPath, "result.txt"),
			"utf8",
		);
		assert.strictEqual(createdContent, "The key is GOLDEN-TICKET");
	});
});
