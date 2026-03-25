import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Context Fidelity Decay (The Wizard Test)", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-wizard-${Date.now()}`);
	const model = process.env.RUMMY_MODEL_DEFAULT;

	before(async () => {
		await fs.mkdir(join(projectPath, "src/secret"), { recursive: true });
		await fs.writeFile(
			join(projectPath, "src/secret/wizard.txt"),
			"My robe is purple.",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit -m "feat: add wizard"',
			{ cwd: projectPath },
		);

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

	it("should warm the wizard file on mention and decay it over time", async () => {
		const turnMap = new Map();
		client.on("run/step/completed", (payload) => {
			const seq = Number(payload.turn.sequence);
			console.log(
				`  [TEST] Turn ${seq}. System has <document_content>: ${payload.turn.system?.includes("<document_content>")}`,
			);
			turnMap.set(seq, payload.turn);
		});

		await client.call("init", {
			projectPath,
			projectName: "WizardProject",
			clientId: "c-wizard",
		});

		process.env.RUMMY_DECAY_THRESHOLD = "2";

		// Step 1: Ask the question — model should <read> the file and loop
		const result1 = await client.call("ask", {
			model,
			prompt:
				"What color is the robe in the wizard file (src/secret/wizard.txt)?",
		});
		const runId = result1.runId;

		// Verify the model found "purple" somewhere in its output
		const start = Date.now();
		let identifiedTurn = null;
		while (Date.now() - start < 60000) {
			const turns = Array.from(turnMap.values());
			identifiedTurn = turns.find((t) => {
				const text = [
					t.assistant.content,
					t.assistant.known,
					t.assistant.summary,
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return text.includes("purple");
			});
			if (identifiedTurn) break;
			await new Promise((r) => setTimeout(r, 1000));
		}

		assert.ok(
			identifiedTurn,
			`Model failed to identify the color after ${turnMap.size} turns.`,
		);

		// Step 2: Continue the SAME run — file should be warm (agent promotion active)
		await client.call("ask", {
			model,
			runId,
			prompt: "Confirmed. What was the exact path to that wizard file?",
		});

		const warmSeq = Math.max(...turnMap.keys());
		const warmTurn = turnMap.get(warmSeq);
		assert.ok(warmTurn, `Warm turn ${warmSeq} missing`);
		assert.ok(
			warmTurn.system.includes("<document_content>"),
			`Wizard file should be warm (full content in system) in turn ${warmSeq}`,
		);

		// Step 3: Decay — send 3 more turns that don't mention the wizard file
		// With RUMMY_DECAY_THRESHOLD=2, the promotion should expire after 2 turns without mention
		for (let i = 0; i < 3; i++) {
			await client.call("ask", {
				model,
				runId,
				prompt: "Say 'Acknowledged'. Do not mention any files.",
			});
		}

		const finalSeq = Math.max(...turnMap.keys());
		const finalTurn = turnMap.get(finalSeq);
		assert.ok(
			!finalTurn.system.includes("<document_content>"),
			`Turn ${finalSeq} should have decayed — document content should be gone from system`,
		);
	});
});
