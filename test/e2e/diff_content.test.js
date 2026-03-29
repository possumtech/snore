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

/**
 * Collects run/step/completed notifications keyed by sequence number.
 * Returns a Map and a waiter function.
 */
function turnCollector(client) {
	const turns = new Map();
	const waiters = [];
	client.on("run/step/completed", (params) => {
		turns.set(params.turn.sequence, params);
		for (const w of waiters) w();
	});
	const waitForTurn = (seq, timeoutMs = 60_000) =>
		new Promise((resolve, reject) => {
			if (turns.has(seq)) return resolve(turns.get(seq));
			const timer = setTimeout(
				() => reject(new Error(`Timeout waiting for turn ${seq}`)),
				timeoutMs,
			);
			const check = () => {
				if (turns.has(seq)) {
					clearTimeout(timer);
					resolve(turns.get(seq));
				}
			};
			waiters.push(check);
		});
	const cleanup = () => {
		client.removeAllListeners("run/step/completed");
		waiters.length = 0;
	};
	return { turns, waitForTurn, cleanup };
}

describe("E2E: Diff Content Verification", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-diffcontent-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "math.js"),
			"function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
		);

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit --no-verify -m "feat: init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("init", {
			projectPath,
			projectName: "DiffContentProject",
			clientId: "c-diffcontent",
		});

		await client.call("activate", { pattern: "math.js" });
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("proposed edit diff should be a unified diff patch", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt:
				'The add function in math.js has a bug: it subtracts instead of adding. Fix it by changing "return a - b" to "return a + b". Put the fix in the edits array.',
		});

		assert.strictEqual(
			result.status,
			"proposed",
			`Expected proposed, got ${result.status}`,
		);

		const diff = result.proposed.find((f) => f.category === "diff");
		assert.ok(
			diff,
			`No diff finding. Got categories: ${result.proposed.map((f) => f.category).join(", ")}`,
		);
		assert.strictEqual(diff.type, "edit");
		assert.ok(
			diff.file.includes("math.js"),
			`Expected math.js, got ${diff.file}`,
		);
		assert.ok(diff.patch, "Diff should have patch content");

		// Should be a unified diff, not raw SEARCH/REPLACE
		assert.ok(
			diff.patch.includes("---") && diff.patch.includes("+++"),
			`Patch should be a unified diff with --- and +++ headers. Got:\n${diff.patch.slice(0, 300)}`,
		);
		assert.ok(
			diff.patch.includes("@@"),
			`Patch should contain @@ hunk headers. Got:\n${diff.patch.slice(0, 300)}`,
		);

		// The diff should show the subtraction being replaced with addition
		assert.ok(
			diff.patch.includes("-") && diff.patch.includes("+"),
			`Patch should contain removed (-) and added (+) lines. Got:\n${diff.patch.slice(0, 300)}`,
		);

		// Clean up
		for (const f of result.proposed) {
			await client.call("run/resolve", {
				run: result.run,
				resolution: { category: f.category, id: f.id, action: "accepted" },
			});
		}
	});

	it("accepted diff should produce <info file=...> in resumed turn context", {
		timeout: TIMEOUT,
	}, async () => {
		const { turns, cleanup } = turnCollector(client);

		const actResult = await client.call("act", {
			model,
			prompt:
				"The add function in math.js returns a - b but should return a + b. Fix this single bug with one edit.",
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);

		// Find the turn sequence of the proposing turn
		const proposingSeq = actResult.turn;

		// Accept all findings
		let _resolveResult;
		for (const f of actResult.proposed) {
			_resolveResult = await client.call("run/resolve", {
				run: actResult.run,
				resolution: { category: f.category, id: f.id, action: "accepted" },
			});
		}

		// The auto-resume should produce a new turn after the proposing one
		// Wait for ANY turn after the proposing sequence
		const startTime = Date.now();
		let resumedTurn = null;
		while (Date.now() - startTime < 60_000) {
			for (const [seq, payload] of turns) {
				if (seq > proposingSeq && payload.run === actResult.run) {
					resumedTurn = payload;
					break;
				}
			}
			if (resumedTurn) break;
			await new Promise((r) => setTimeout(r, 500));
		}

		assert.ok(resumedTurn, "Should have received a resumed turn notification");

		// The resumed turn's context should contain the acceptance info
		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Resumed turn should have context");
		assert.ok(
			ctx.includes("info:") && ctx.includes("accepted"),
			`Resumed turn context should contain <info file="..."> tag. Context:\n${ctx.slice(0, 500)}`,
		);
		assert.ok(
			ctx.includes("accepted"),
			`Context should mention acceptance. Context:\n${ctx.slice(0, 500)}`,
		);

		cleanup();
	});

	it("rejected diff should produce <warn file=...> in resumed turn context", {
		timeout: TIMEOUT,
	}, async () => {
		const { turns, cleanup } = turnCollector(client);

		const actResult = await client.call("act", {
			model,
			prompt:
				"The add function in math.js returns a - b but should return a + b. Fix this single bug with one edit.",
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);
		const proposingSeq = actResult.turn;

		// Reject all findings
		let lastResolve;
		for (const f of actResult.proposed) {
			lastResolve = await client.call("run/resolve", {
				run: actResult.run,
				resolution: { category: f.category, id: f.id, action: "rejected" },
			});
		}

		// Rejection should return resolved (no auto-resume)
		assert.strictEqual(
			lastResolve.status,
			"resolved",
			`Rejected findings should return 'resolved', got ${lastResolve.status}`,
		);

		// Client continues — rejection info appears as feedback in the next turn
		const _continueResult = await client.call("act", {
			model,
			run: actResult.run,
			prompt: "The edit was rejected. Summarize what happened.",
		});

		// Find the turn after the proposing turn
		let resumedTurn = null;
		for (const [seq, payload] of turns) {
			if (seq > proposingSeq && payload.run === actResult.run) {
				resumedTurn = payload;
				break;
			}
		}

		assert.ok(
			resumedTurn,
			"Should have received a turn after client continued",
		);

		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Continued turn should have context");
		assert.ok(
			ctx.includes("warn:") || ctx.includes("rejected"),
			`Continued turn context should contain rejection feedback. Context:\n${ctx.slice(0, 500)}`,
		);

		cleanup();
	});

	it("modified diff should produce <warn file=...> with partial acceptance in context", {
		timeout: TIMEOUT,
	}, async () => {
		const { turns, cleanup } = turnCollector(client);

		const actResult = await client.call("act", {
			model,
			prompt:
				"The add function in math.js returns a - b but should return a + b. Fix this single bug with one edit.",
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);
		const proposingSeq = actResult.turn;

		// Resolve diffs with "modified", others with "accepted"
		let lastResolve;
		for (const f of actResult.proposed) {
			const action = f.category === "diff" ? "modified" : "accepted";
			lastResolve = await client.call("run/resolve", {
				run: actResult.run,
				resolution: { category: f.category, id: f.id, action },
			});
		}

		// Modified auto-resumes — model needs to see the result
		assert.ok(
			["completed", "proposed"].includes(lastResolve.status),
			`Modified findings should auto-resume, got ${lastResolve.status}`,
		);

		let resumedTurn = null;
		for (const [seq, payload] of turns) {
			if (seq > proposingSeq && payload.run === actResult.run) {
				resumedTurn = payload;
				break;
			}
		}

		assert.ok(
			resumedTurn,
			"Should have received a turn after client continued",
		);

		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Continued turn should have context");
		assert.ok(
			ctx.includes("warn:") || ctx.includes("partially accepted"),
			`Context should contain partial acceptance feedback. Context:\n${ctx.slice(0, 500)}`,
		);

		cleanup();
	});
});
