import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 180_000;
const WIZARD_DEFAULT = "My robe is purple\n";

async function resetWizard(projectPath) {
	await fs.writeFile(join(projectPath, "wizard.txt"), WIZARD_DEFAULT);
}

describe("E2E: Client Scenarios", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-scenarios-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "AGENTS.md"),
			"# AGENTS\n\nSome content here.\n",
		);
		await fs.writeFile(
			join(projectPath, "hello.js"),
			'function greet() { return "hello"; }\nmodule.exports = greet;\n',
		);
		await fs.writeFile(
			join(projectPath, "wizard.txt"),
			"My robe is purple\n",
		);
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
			projectName: "ScenariosTest",
			clientId: "c-scenarios",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	// Scenario 1: Simple Ask (No Edits)
	it("S1: simple ask with noContext completes with summary", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		const result = await client.call("ask", {
			model,
			prompt: "What is 2+2? Answer with just the number.",
			noContext: true,
		});

		await client.assertRun(result, "completed", "S1");

		assert.ok(states.length > 0, "Should receive run/state");
		const state = states.at(-1);
		assert.ok(state.summary, "Should have summary");
		assert.strictEqual(state.proposed.length, 0, "No proposed entries");
	});

	// Scenario 2: Act with Single Edit (Accept)
	it("S2: act with edit, accept resolution", {
		timeout: TIMEOUT,
	}, async () => {
		await resetWizard(projectPath);
		const states = [];
		client.on("run/state", (p) => states.push(p));

		const result = await client.call("act", {
			model,
			prompt: 'Change "purple" to "blue" in wizard.txt',
		});

		if (result.status === "proposed") {
			const state = states.at(-1);
			const editProposed = state.proposed.find((p) => p.type === "edit");

			if (editProposed) {
				assert.ok(editProposed.meta, "Edit has meta");

				// Apply edit to disk
				if (editProposed.meta?.blocks) {
					const filePath = join(projectPath, editProposed.meta.file);
					try {
						let content = await fs.readFile(filePath, "utf8");
						for (const block of editProposed.meta.blocks) {
							if (block.search && content.includes(block.search)) {
								content = content.replace(block.search, block.replace);
							} else if (block.search === null) {
								content = block.replace;
							}
						}
						await fs.writeFile(filePath, content);
					} catch {}
				}

				const resolveResult = await client.call("run/resolve", {
					run: result.run,
					resolution: { key: editProposed.key, action: "accept", output: "applied" },
				});

				await client.assertRun(
					resolveResult,
					["completed", "proposed", "running", "resolved"],
					"S2 after accept",
				);
			}
		} else {
			await client.assertRun(result, "completed", "S2");
		}
		await resetWizard(projectPath);
	});

	// Scenario 3: Act with Single Edit (Reject)
	it("S3: act with edit, reject resolution", {
		timeout: TIMEOUT,
	}, async () => {
		await resetWizard(projectPath);
		const result = await client.call("act", {
			model,
			prompt: 'Change "purple" to "green" in wizard.txt',
		});

		if (result.status === "proposed") {
			const proposed = result.proposed[0];
			const resolveResult = await client.call("run/resolve", {
				run: result.run,
				resolution: {
					key: proposed.key,
					action: "reject",
					output: "User rejected",
				},
			});

			await client.assertRun(
				resolveResult,
				["completed", "resolved", "proposed"],
				"S3 after reject",
			);
		} else {
			await client.assertRun(result, "completed", "S3");
		}
		await resetWizard(projectPath);
	});

	// Scenario 5: Null Patch (Server Edit Error)
	it("S5: edit with unfindable search block produces error", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		await resetWizard(projectPath);
		const result = await client.call("act", {
			model,
			prompt:
				'Edit wizard.txt and replace the line "THIS LINE DOES NOT EXIST" with "replaced"',
		});

		// The edit should either error (search not found) or the model adapts
		await client.assertRun(result, ["completed", "proposed"], "S5");

		// If proposed, check for error state on edit entries
		if (result.status === "proposed") {
			const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
			const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });
			const edits = all.filter((e) => e.key.startsWith("/:edit:"));

			for (const edit of edits) {
				const meta = edit.meta ? JSON.parse(edit.meta) : {};
				if (meta.error) {
					assert.ok(meta.error.length > 0, "Error message present");
				}
			}
		}
	});

	// Scenario 6: Environment Command (Accept)
	it("S6: env command proposed, accept with output", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "How much disk space do I have?",
			noContext: true,
		});

		if (result.status === "proposed") {
			const envProposed = result.proposed.find((p) =>
				p.key.startsWith("/:env:"),
			);

			if (envProposed) {
				const resolveResult = await client.call("run/resolve", {
					run: result.run,
					resolution: {
						key: envProposed.key,
						action: "accept",
						output:
							"Filesystem      Size  Used Avail Use%\n/dev/sda1       100G   50G   50G  50%",
					},
				});

				await client.assertRun(
					resolveResult,
					["completed", "proposed", "running"],
					"S6 after env accept",
				);
			}
		} else {
			await client.assertRun(result, "completed", "S6");
		}
	});

	// Scenario 7: Run Command (Reject)
	it("S7: run command proposed, reject", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt: 'Run the command "echo hello world" and tell me what happened',
		});

		if (result.status === "proposed") {
			const runProposed = result.proposed.find(
				(p) => p.key.startsWith("/:run:") || p.key.startsWith("/:env:"),
			);

			if (runProposed) {
				const resolveResult = await client.call("run/resolve", {
					run: result.run,
					resolution: {
						key: runProposed.key,
						action: "reject",
						output: "Command denied by user",
					},
				});

				await client.assertRun(
					resolveResult,
					["completed", "resolved", "proposed"],
					"S7 after reject",
				);
			}
		} else {
			await client.assertRun(result, "completed", "S7");
		}
	});

	// Scenario 8: User Prompt (ask_user)
	it("S8: model asks user a question, user responds", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("ask", {
			model,
			prompt:
				"What kind of poem should I write? Ask me to choose between haiku and limerick.",
			noContext: true,
		});

		if (result.status === "proposed") {
			const askUser = result.proposed.find((p) =>
				p.key.startsWith("/:ask_user:"),
			);

			if (askUser) {
				const meta =
					typeof askUser.meta === "string"
						? JSON.parse(askUser.meta)
						: askUser.meta;
				assert.ok(meta?.question, "Question present in meta");
				assert.ok(meta?.options?.length >= 2, "At least 2 options");

				const resolveResult = await client.call("run/resolve", {
					run: result.run,
					resolution: {
						key: askUser.key,
						action: "accept",
						output: meta.options[0],
					},
				});

				await client.assertRun(
					resolveResult,
					["completed", "proposed", "running"],
					"S8 after answer",
				);
			}
		} else {
			await client.assertRun(result, "completed", "S8");
		}
	});

	// Scenario 10: Multi-Turn Continuation
	it("S10: multi-turn continuation preserves context", {
		timeout: TIMEOUT,
	}, async () => {
		const run1 = await client.call("ask", {
			model,
			prompt: "What files are in this project?",
		});
		await client.assertRun(run1, ["completed", "proposed"], "S10 turn 1");

		// Resolve any proposed entries from first turn
		if (run1.status === "proposed") {
			for (const p of run1.proposed) {
				await client.call("run/resolve", {
					run: run1.run,
					resolution: { key: p.key, action: "accept", output: "" },
				});
			}
		}

		const run2 = await client.call("ask", {
			model,
			prompt: "Which one is the largest?",
			run: run1.run,
		});
		await client.assertRun(run2, ["completed", "proposed"], "S10 turn 2");
		assert.strictEqual(run2.run, run1.run, "Same run across both requests");

		// Verify multiple turns in the store
		const runRow = await tdb.db.get_run_by_alias.get({ alias: run1.run });
		const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });
		const prompts = all.filter((e) => e.key.startsWith("/:prompt:"));
		assert.ok(
			prompts.length >= 2,
			`Should have 2+ prompts, got ${prompts.length}`,
		);
	});

	// Scenario 12: Yolo Mode (Auto-Accept Everything)
	it("S12: yolo mode auto-accepts all proposed entries", {
		timeout: TIMEOUT,
	}, async () => {
		// Reset wizard.txt for this test
		await fs.writeFile(join(projectPath, "wizard.txt"), "My robe is purple\n");

		const result = await client.call("act", {
			model,
			prompt: 'Change "purple" to "blue" in wizard.txt',
		});

		// Simulate yolo: auto-accept every proposed entry
		let current = result;
		let iterations = 0;
		const runAlias = result.run;
		while (current.status === "proposed" && iterations < 10) {
			for (const p of current.proposed) {
				const type = p.key.match(/^\/:(\w+):/)?.[1];
				const meta = typeof p.meta === "string" ? JSON.parse(p.meta) : p.meta;
				let output = "ok";

				if (type === "edit" && meta?.patch) {
					// Apply the edit to disk so the model sees the change
					const filePath = join(projectPath, meta.file);
					try {
						const content = await fs.readFile(filePath, "utf8");
						// Apply search/replace from blocks
						let updated = content;
						for (const block of meta.blocks || []) {
							if (block.search && updated.includes(block.search)) {
								updated = updated.replace(block.search, block.replace);
							} else if (block.search === null) {
								updated = block.replace;
							}
						}
						await fs.writeFile(filePath, updated);
						output = "applied";
					} catch {
						output = "file not found";
					}
				} else if (type === "env" || type === "run") {
					output = `$ ${meta?.command || "unknown"}\nwizard.txt\nhello.js\n`;
				}

				try {
					current = await client.call("run/resolve", {
						run: runAlias,
						resolution: { key: p.key, action: "accept", output },
					});
				} catch (err) {
					await client.dumpRun(runAlias);
					throw err;
				}
			}
			iterations++;
		}

		await client.assertRun(
			current,
			["completed", "resolved", "running"],
			"S12 yolo",
		);
		await resetWizard(projectPath);
	});
});
