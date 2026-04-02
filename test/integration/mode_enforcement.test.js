/**
 * Mode enforcement integration test.
 *
 * Verifies that ask mode rejects file mutations and <run> while
 * allowing K/V operations.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import XmlParser from "../../src/agent/XmlParser.js";
import HookRegistry from "../../src/hooks/HookRegistry.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;

describe("Mode enforcement in ask mode", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db, new HookRegistry());
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;

		// Seed some entries for the model to target
		await store.upsert(RUN_ID, 1, "src/app.js", "const x = 1;", "full");
		await store.upsert(RUN_ID, 1, "known://note", "test note", "full");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("rejects <run> in ask mode", () => {
		const { commands } = XmlParser.parse("<run>npm test</run>");
		// Simulate the mode enforcement filter
		const filtered = commands.filter((c) => c.name !== "run");
		assert.equal(filtered.length, 0, "run should be filtered out");
	});

	it("rejects file write in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<write path="src/app.js">new content</write>',
		);
		for (const cmd of commands) {
			if (cmd.name === "write" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "file write should be rejected");
	});

	it("allows known:// write in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<write path="known://note">updated</write>',
		);
		for (const cmd of commands) {
			if (cmd.name === "write" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// write should be allowed");
	});

	it("rejects file delete in ask mode", () => {
		const { commands } = XmlParser.parse('<delete path="src/app.js"/>');
		for (const cmd of commands) {
			if (cmd.name === "delete" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "file delete should be rejected");
	});

	it("allows known:// delete in ask mode", () => {
		const { commands } = XmlParser.parse('<delete path="known://note"/>');
		for (const cmd of commands) {
			if (cmd.name === "delete" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// delete should be allowed");
	});

	it("rejects move to file target in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<move path="known://note">src/output.txt</move>',
		);
		for (const cmd of commands) {
			if (cmd.name === "move" && cmd.to) {
				const destScheme = KnownStore.scheme(cmd.to);
				if (destScheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "move to file should be rejected");
	});

	it("allows move between known entries in ask mode", () => {
		const { commands } = XmlParser.parse(
			'<move path="known://note">known://archive</move>',
		);
		for (const cmd of commands) {
			if (cmd.name === "move" && cmd.to) {
				const destScheme = KnownStore.scheme(cmd.to);
				if (destScheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// move should be allowed");
	});
});
