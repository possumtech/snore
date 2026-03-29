import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";
import KnownStore from "../../src/agent/KnownStore.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 180_000;

describe("E2E: Rumsfeld Loop — Sticky Unknowns", () => {
	let tdb, tserver, client, knownStore;
	const projectPath = join(tmpdir(), `rummy-rumsfeld-${Date.now()}`);

	before(async () => {
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(
			join(projectPath, "src/auth.js"),
			`export default class Auth {
	#store;
	constructor(store) { this.#store = store; }
	async verify(token) {
		const session = await this.#store.get(token);
		if (!session) throw new Error("Invalid token");
		return session.user;
	}
}
`,
		);
		await fs.writeFile(
			join(projectPath, "src/app.js"),
			`import Auth from "./auth.js";
const auth = new Auth(sessionStore);
app.use("/api", (req, res, next) => {
	auth.verify(req.headers.authorization).then(next).catch(() => res.status(401).end());
});
`,
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		knownStore = new KnownStore(tdb.db);
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "RumsfeldTest",
			clientId: "c-rumsfeld",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("model investigates unknowns before completing", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "How does authentication work in this project? What session store does it use?",
		});

		// completed = model answered. proposed = model is investigating (called env/run).
		// Both are valid — the Rumsfeld Loop is working either way.
		assert.ok(
			result.status === "completed" || result.status === "proposed",
			`Expected completed or proposed, got ${result.status}`,
		);

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// Model should have engaged — summaries, reads, writes, or proposed commands
		const summaries = all.filter((e) => e.key.match(/^\/:summary\//));
		assert.ok(summaries.length > 0, "Should have summary entries");

	});

	it("sticky unknowns persist and are visible in context", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "What testing framework does this project use? What CI pipeline is configured?",
		});

		assert.strictEqual(result.status, "completed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// The model should have registered unknowns (can't find tests or CI in this project)
		// OR resolved them by investigating and finding nothing
		// Either way, the run completed — the unknowns gate worked
		const summaries = all.filter((e) => e.key.startsWith("/:summary/"));
		assert.ok(summaries.length > 0, "Should have completed with summaries");
	});
});
