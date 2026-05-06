import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Skill from "./skill.js";

function makeCore() {
	const views = new Map();
	const schemes = [];
	let handler = null;
	const toolDocFilters = [];
	return {
		registerScheme: (opts) => schemes.push(opts),
		hooks: {
			tools: {
				onView: (scheme, fn, vis) => {
					if (!views.has(scheme)) views.set(scheme, new Map());
					views.get(scheme).set(vis, fn);
				},
			},
		},
		on: (event, fn) => {
			if (event === "handler") handler = fn;
		},
		filter: (name, fn) => {
			if (name === "instructions.toolDocs") toolDocFilters.push(fn);
		},
		_view: (scheme, vis) => views.get(scheme)?.get(vis),
		_schemes: schemes,
		_handler: () => handler,
		_toolDocs: async () => {
			const map = {};
			for (const f of toolDocFilters) await f(map);
			return map;
		},
	};
}

function makeStore() {
	const writes = [];
	return {
		writes,
		set: async (params) => {
			writes.push(params);
		},
	};
}

function rummyCtxFor(store, projectRoot) {
	return {
		entries: store,
		sequence: 0,
		runId: "r1",
		loopId: null,
		projectId: "p1",
		db: {
			get_project_by_id: {
				get: async () => ({ project_root: projectRoot }),
			},
		},
	};
}

describe("Skill plugin", () => {
	let tmp;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "skill-test-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("registers skill scheme + visible/summarized views + handler + tooldoc", async () => {
		const core = makeCore();
		new Skill(core);
		assert.deepEqual(core._schemes, [{ name: "skill", category: "data" }]);
		assert.equal(core._view("skill", "visible")({ body: "hi" }), "hi");
		assert.equal(core._view("skill", "summarized")(), "");
		assert.equal(typeof core._handler(), "function");
		const docs = await core._toolDocs();
		assert.match(docs.skill, /<skill path/);
	});

	it("emits validation failure when path missing", async () => {
		const core = makeCore();
		new Skill(core);
		const store = makeStore();
		await core._handler()(
			{ attributes: {}, resultPath: "log://turn_0/skill/_" },
			rummyCtxFor(store, tmp),
		);
		const fail = store.writes.find((w) => w.state === "failed");
		assert.ok(fail);
		assert.equal(fail.outcome, "validation");
	});

	it("ingests single .md file as skill://<basename> (summarized)", async () => {
		await writeFile(join(tmp, "playbook.md"), "# playbook root");
		const core = makeCore();
		new Skill(core);
		const store = makeStore();
		await core._handler()(
			{
				attributes: { path: "playbook.md" },
				resultPath: "log://turn_0/skill/_",
			},
			rummyCtxFor(store, tmp),
		);
		const entry = store.writes.find((w) => w.path === "skill://playbook");
		assert.ok(entry);
		assert.equal(entry.body, "# playbook root");
		assert.equal(entry.visibility, "summarized");
		const result = store.writes.find((w) => w.path === "log://turn_0/skill/_");
		assert.equal(result.state, "resolved");
	});

	it("ingests folder: index.md → root summarized, others archived; foo/index.md collapses", async () => {
		const root = join(tmp, "playbook");
		await mkdir(join(root, "foo"), { recursive: true });
		await writeFile(join(root, "index.md"), "root");
		await writeFile(join(root, "intro.md"), "intro page");
		await writeFile(join(root, "foo", "index.md"), "foo root");
		await writeFile(join(root, "foo", "bar.md"), "foo bar");

		const core = makeCore();
		new Skill(core);
		const store = makeStore();
		await core._handler()(
			{
				attributes: { path: "playbook" },
				resultPath: "log://turn_0/skill/_",
			},
			rummyCtxFor(store, tmp),
		);

		const byPath = Object.fromEntries(
			store.writes
				.filter((w) => w.path?.startsWith("skill://"))
				.map((w) => [w.path, w]),
		);
		assert.ok(byPath["skill://playbook"]);
		assert.equal(byPath["skill://playbook"].visibility, "summarized");
		assert.equal(byPath["skill://playbook/intro"].visibility, "archived");
		assert.equal(byPath["skill://playbook/foo"].body, "foo root");
		assert.equal(byPath["skill://playbook/foo"].visibility, "archived");
		assert.equal(byPath["skill://playbook/foo/bar"].body, "foo bar");
	});

	it("emits not_found when relative path doesn't resolve", async () => {
		const core = makeCore();
		new Skill(core);
		const store = makeStore();
		await core._handler()(
			{
				attributes: { path: "nope.md" },
				resultPath: "log://turn_0/skill/_",
			},
			rummyCtxFor(store, tmp),
		);
		const fail = store.writes.find((w) => w.state === "failed");
		assert.ok(fail);
		assert.equal(fail.outcome, "not_found");
	});
});
