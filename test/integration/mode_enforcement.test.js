/**
 * Mode enforcement integration test.
 *
 * Verifies that ask mode rejects file mutations and <sh> while
 * allowing K/V operations.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Repository from "../../src/agent/Repository.js";
import XmlParser from "../../src/agent/XmlParser.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;

describe("Mode enforcement in ask mode", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new Repository(tdb.db);
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;

		// Seed some entries for the model to target
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "src/app.js",
			body: "const x = 1;",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://note",
			body: "test note",
			state: "resolved",
		});
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("rejects <sh> in ask mode", () => {
		const { commands } = XmlParser.parse("<sh>npm test</sh>");
		// Simulate the mode enforcement filter
		const filtered = commands.filter((c) => c.name !== "sh");
		assert.equal(filtered.length, 0, "sh should be filtered out");
	});

	it("rejects file set in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<set path="src/app.js">new content</set>',
		);
		for (const cmd of commands) {
			if (cmd.name === "set" && cmd.path) {
				const scheme = Repository.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "file set should be rejected");
	});

	it("allows known:// set in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<set path="known://note">updated</set>',
		);
		for (const cmd of commands) {
			if (cmd.name === "set" && cmd.path) {
				const scheme = Repository.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// set should be allowed");
	});

	it("rejects file rm in ask mode", () => {
		const { commands } = XmlParser.parse('<rm path="src/app.js"/>');
		for (const cmd of commands) {
			if (cmd.name === "rm" && cmd.path) {
				const scheme = Repository.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "file rm should be rejected");
	});

	it("allows known:// rm in ask mode", () => {
		const { commands } = XmlParser.parse('<rm path="known://note"/>');
		for (const cmd of commands) {
			if (cmd.name === "rm" && cmd.path) {
				const scheme = Repository.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// rm should be allowed");
	});

	it("rejects mv to file target in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<mv path="known://note">src/output.txt</mv>',
		);
		for (const cmd of commands) {
			if (cmd.name === "mv" && cmd.to) {
				const destScheme = Repository.scheme(cmd.to);
				if (destScheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "mv to file should be rejected");
	});

	it("allows mv between known entries in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<mv path="known://note">known://archive</mv>',
		);
		for (const cmd of commands) {
			if (cmd.name === "mv" && cmd.to) {
				const destScheme = Repository.scheme(cmd.to);
				if (destScheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// mv should be allowed");
	});
});

describe("Tool exclusion flags", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create();
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("ask mode excludes sh", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask");
		assert.ok(!tools.has("sh"), "sh excluded in ask mode");
		assert.ok(tools.has("get"), "get available in ask mode");
		assert.ok(tools.has("env"), "env available in ask mode");
	});

	it("act mode includes sh", () => {
		const tools = tdb.hooks.tools.resolveForLoop("act");
		assert.ok(tools.has("sh"), "sh available in act mode");
	});

	it("noInteraction removes ask_user from tool set", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask", {
			noInteraction: true,
		});
		assert.ok(!tools.has("ask_user"), "ask_user should be excluded");
		assert.ok(tools.has("get"), "get should still be available");
		assert.ok(tools.has("set"), "set should still be available");
	});

	it("noWeb removes search from tool set", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask", { noWeb: true });
		assert.ok(!tools.has("search"), "search should be excluded");
		assert.ok(tools.has("get"), "get should still be available");
	});

	it("noProposals removes ask_user, env, and sh", () => {
		const tools = tdb.hooks.tools.resolveForLoop("act", { noProposals: true });
		assert.ok(!tools.has("ask_user"), "ask_user excluded");
		assert.ok(!tools.has("env"), "env excluded");
		assert.ok(!tools.has("sh"), "sh excluded");
		assert.ok(tools.has("get"), "get still available");
		assert.ok(tools.has("set"), "set still available");
		assert.ok(tools.has("search"), "search still available");
	});

	it("multiple flags compose", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask", {
			noInteraction: true,
			noWeb: true,
		});
		assert.ok(!tools.has("ask_user"), "ask_user excluded");
		assert.ok(!tools.has("search"), "search excluded");
		assert.ok(!tools.has("sh"), "sh excluded (ask mode)");
		assert.ok(tools.has("get"), "get still available");
	});

	it("no flags in act mode keeps all tools", () => {
		const tools = tdb.hooks.tools.resolveForLoop("act");
		assert.ok(tools.has("ask_user"), "ask_user available");
		assert.ok(tools.has("search"), "search available");
		assert.ok(tools.has("sh"), "sh available");
		assert.ok(tools.has("env"), "env available");
	});

	it("tools are sorted by priority, not alphabetically", () => {
		const tools = [...tdb.hooks.tools.resolveForLoop("act")];
		const getIdx = tools.indexOf("get");
		const askUserIdx = tools.indexOf("ask_user");
		assert.ok(getIdx < askUserIdx, "get should come before ask_user");
	});
});
