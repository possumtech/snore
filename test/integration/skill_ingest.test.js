/**
 * Skill plugin integration: <skill path="..."/> tag dispatched through
 * the real plugin pipeline. Covers single-file, folder, index.md
 * collapsing, archived/summarized visibility, and re-emit overwrite.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import createHooks from "../../src/hooks/Hooks.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import { registerPlugins } from "../../src/plugins/index.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let PROJECT_ID;

function rummyFor(hooks, db, store, sequence) {
	const root = {
		tag: "turn",
		attrs: {},
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
		],
	};
	return new RummyContext(root, {
		hooks,
		db,
		store,
		project: { id: PROJECT_ID },
		projectId: PROJECT_ID,
		type: "act",
		sequence,
		runId: RUN_ID,
		turnId: 1,
	});
}

describe("Skill ingest", () => {
	let tdb, store, hooks, projectRoot;

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "skill-intg-"));
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "skill_1", projectRoot });
		RUN_ID = seed.runId;
		PROJECT_ID = seed.projectId;

		hooks = createHooks();
		const { dirname, join: joinp } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const pluginsDir = joinp(
			dirname(fileURLToPath(import.meta.url)),
			"../../src/plugins",
		);
		await registerPlugins([pluginsDir], hooks);
	});

	after(async () => {
		await tdb.cleanup();
		await rm(projectRoot, { recursive: true, force: true });
	});

	beforeEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
		await mkdir(projectRoot, { recursive: true });
	});

	async function dispatch(path, sequence = 1) {
		const rummy = rummyFor(hooks, tdb.db, store, sequence);
		const resultPath = `log://turn_${sequence}/skill/_`;
		await hooks.tools.dispatch(
			"skill",
			{
				scheme: "skill",
				path: resultPath,
				body: "",
				attributes: { path },
				state: "resolved",
				resultPath,
			},
			rummy,
		);
		return resultPath;
	}

	it("single .md → skill://<name> summarized", async () => {
		await writeFile(join(projectRoot, "playbook.md"), "playbook root body");
		const resultPath = await dispatch("playbook.md");

		const entry = await store.getEntriesByPattern(
			RUN_ID,
			"skill://playbook",
			null,
		);
		assert.equal(entry.length, 1);
		assert.equal(entry[0].body, "playbook root body");
		const state = await store.getState(RUN_ID, "skill://playbook");
		assert.equal(state.visibility, "summarized");

		const log = await store.getBody(RUN_ID, resultPath);
		assert.match(log, /skill 'playbook' added/);
	});

	it("folder → index summarized, others archived; foo/index.md collapses to skill://<name>/foo", async () => {
		const root = join(projectRoot, "playbook");
		await mkdir(join(root, "foo"), { recursive: true });
		await writeFile(join(root, "index.md"), "ROOT");
		await writeFile(join(root, "intro.md"), "INTRO");
		await writeFile(join(root, "foo", "index.md"), "FOO_ROOT");
		await writeFile(join(root, "foo", "bar.md"), "FOO_BAR");

		await dispatch("playbook");

		const root_state = await store.getState(RUN_ID, "skill://playbook");
		assert.equal(root_state.visibility, "summarized");
		assert.equal(await store.getBody(RUN_ID, "skill://playbook"), "ROOT");

		const intro_state = await store.getState(RUN_ID, "skill://playbook/intro");
		assert.equal(intro_state.visibility, "archived");
		assert.equal(
			await store.getBody(RUN_ID, "skill://playbook/intro"),
			"INTRO",
		);

		assert.equal(
			await store.getBody(RUN_ID, "skill://playbook/foo"),
			"FOO_ROOT",
		);
		assert.equal(
			await store.getBody(RUN_ID, "skill://playbook/foo/bar"),
			"FOO_BAR",
		);
	});

	it("re-emission overwrites prior body", async () => {
		await writeFile(join(projectRoot, "p.md"), "v1");
		await dispatch("p.md", 1);
		assert.equal(await store.getBody(RUN_ID, "skill://p"), "v1");

		await writeFile(join(projectRoot, "p.md"), "v2");
		await dispatch("p.md", 2);
		assert.equal(await store.getBody(RUN_ID, "skill://p"), "v2");
	});

	it("not_found when source missing", async () => {
		const resultPath = await dispatch("nope.md");
		const log = await store.getState(RUN_ID, resultPath);
		assert.equal(log.state, "failed");
		assert.equal(log.outcome, "not_found");
	});

	it("URL → fetch single .md as skill://<basename>", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response("# url skill body", {
				status: 200,
				headers: { "content-type": "text/markdown" },
			});
		try {
			await dispatch("https://example.com/team-skill.md", 50);
		} finally {
			globalThis.fetch = originalFetch;
		}
		assert.equal(
			await store.getBody(RUN_ID, "skill://team-skill"),
			"# url skill body",
		);
		const state = await store.getState(RUN_ID, "skill://team-skill");
		assert.equal(state.visibility, "summarized");
	});

	it("validation when path attr missing", async () => {
		const rummy = rummyFor(hooks, tdb.db, store, 99);
		const resultPath = "log://turn_99/skill/_";
		await hooks.tools.dispatch(
			"skill",
			{
				scheme: "skill",
				path: resultPath,
				body: "",
				attributes: {},
				state: "resolved",
				resultPath,
			},
			rummy,
		);
		const log = await store.getState(RUN_ID, resultPath);
		assert.equal(log.state, "failed");
		assert.equal(log.outcome, "validation");
	});
});
