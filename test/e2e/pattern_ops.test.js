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

describe("E2E: Pattern Operations", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-pattern-${Date.now()}`);

	before(async () => {
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(
			join(projectPath, "src/app.js"),
			"const app = express();\n// TODO: add error handling\n",
		);
		await fs.writeFile(
			join(projectPath, "src/config.js"),
			"const port = 3000;\nconst host = 'localhost';\n",
		);
		await fs.writeFile(
			join(projectPath, "src/utils.js"),
			"export function greet() { return 'hello'; }\n",
		);
		await fs.writeFile(join(projectPath, "readme.md"), "# Test Project\n");
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
			projectName: "PatternTest",
			clientId: "c-pattern",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("bulk read with glob pattern", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: 'Read all JS files in src/ using a glob: <read path="src/*.js"/>',
		});

		await client.assertRun(result, "completed", "bulk read glob");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const files = entries.filter((e) => e.scheme === null && e.turn > 0);
		assert.ok(
			files.length >= 2,
			`Should promote multiple files, got ${files.length}`,
		);
	});

	it("model uses path attribute (not legacy key)", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "Read src/config.js and tell me the port number.",
		});

		await client.assertRun(result, "completed", "path attribute");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const summaries = entries.filter((e) => e.path.startsWith("summary://"));
		assert.ok(summaries.length > 0, "Should have summaries");
	});

	it("model writes known entries with path attribute", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("ask", {
			model,
			prompt:
				"What port does src/config.js use? Save the answer as a known entry.",
		});

		await client.assertRun(result, "completed", "known with path");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const known = entries.filter(
			(e) => e.scheme === "known" && e.path.startsWith("known://"),
		);
		assert.ok(known.length > 0, "Should have known entries");
	});

	it("search returns results", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt:
				'Search the web for "SQLite WAL mode": <search path="SQLite WAL mode"/>',
		});

		await client.assertRun(result, "completed", "search returns results");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const searchEntries = entries.filter((e) => e.scheme === "search");
		assert.ok(
			searchEntries.length >= 1,
			`Should have at least one search result entry, got ${searchEntries.length}`,
		);
	});

	it("edit with search/replace attributes", { timeout: TIMEOUT }, async () => {
		const result = await client.call("act", {
			model,
			prompt:
				'Use search/replace to change "localhost" to "0.0.0.0" in src/config.js: <edit path="src/config.js" search="localhost" replace="0.0.0.0"/>',
		});

		await client.assertRun(
			result,
			["completed", "proposed"],
			"search/replace edit",
		);

		if (result.status === "proposed") {
			const edit = result.proposed.find((p) => p.path.startsWith("edit://"));
			assert.ok(edit, "Should have edit proposed");
			const meta =
				typeof edit.meta === "string" ? JSON.parse(edit.meta) : edit.meta;
			assert.ok(
				meta.patch?.includes("0.0.0.0"),
				"Patch should contain replacement",
			);
		}
	});
});
