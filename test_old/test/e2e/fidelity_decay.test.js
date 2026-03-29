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
				`  [TEST] Turn ${seq}. System has file content: ${payload.turn.system?.includes("My robe is purple")}`,
			);
			turnMap.set(seq, payload.turn);
		});

		await client.call("init", {
			projectPath,
			projectName: "WizardProject",
			clientId: "c-wizard",
		});

		// Decay threshold of 4 tolerates internal multi-turn loops within a single ask call.
		// Each ask may consume 2-3 sequence numbers internally (read → continue → summary).
		process.env.RUMMY_DECAY_THRESHOLD = "4";

		// Step 1: Ask the question — model should <read> the file and loop
		const result1 = await client.call("ask", {
			model,
			prompt:
				"What color is the robe in the wizard file (src/secret/wizard.txt)?",
		});
		const run = result1.run;

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

		// Step 2: Continue the SAME run — mention the path to refresh attention
		await client.call("ask", {
			model,
			run,
			prompt:
				"Confirmed. Repeat the full path src/secret/wizard.txt back to me.",
		});

		// Find the latest turn that has wizard content warm
		const warmSeq = Math.max(...turnMap.keys());
		const warmTurn = turnMap.get(warmSeq);
		assert.ok(warmTurn, `Warm turn ${warmSeq} missing`);
		assert.ok(
			warmTurn.system.includes("My robe is purple"),
			`Wizard file should be warm (full content in system) in turn ${warmSeq}`,
		);

		// Record the sequence where attention was last refreshed
		const lastWarmSeq = warmSeq;

		// Step 3: Decay — send turns that don't mention the wizard file.
		// With threshold=4, need 5+ sequence numbers to pass without mention.
		for (let i = 0; i < 6; i++) {
			await client.call("ask", {
				model,
				run,
				prompt: "Say 'Acknowledged'. Do not mention any files.",
			});
		}

		const finalSeq = Math.max(...turnMap.keys());
		const finalTurn = turnMap.get(finalSeq);

		// The gap between lastWarmSeq and finalSeq should exceed threshold
		console.log(
			`  [TEST] Last warm: ${lastWarmSeq}, Final: ${finalSeq}, Gap: ${finalSeq - lastWarmSeq}`,
		);
		assert.ok(
			!finalTurn.system.includes("My robe is purple"),
			`Turn ${finalSeq} should have decayed — file content should be gone from system (gap: ${finalSeq - lastWarmSeq}, threshold: 4)`,
		);
	});
});
