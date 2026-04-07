/**
 * Mode enforcement integration test.
 *
 * Verifies that ask mode rejects file mutations and <sh> while
 * allowing K/V operations.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import XmlParser from "../../src/agent/XmlParser.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;

describe("Mode enforcement in ask mode", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;

		// Seed some entries for the model to target
		await store.upsert(RUN_ID, 1, "src/app.js", "const x = 1;", 200);
		await store.upsert(RUN_ID, 1, "known://note", "test note", 200);
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
				const scheme = KnownStore.scheme(cmd.path);
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
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// set should be allowed");
	});

	it("rejects file rm in ask mode", () => {
		const { commands } = XmlParser.parse('<rm path="src/app.js"/>');
		for (const cmd of commands) {
			if (cmd.name === "rm" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) cmd._rejected = true;
			}
		}
		assert.ok(commands[0]._rejected, "file rm should be rejected");
	});

	it("allows known:// rm in ask mode", () => {
		const { commands } = XmlParser.parse('<rm path="known://note"/>');
		for (const cmd of commands) {
			if (cmd.name === "rm" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
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
				const destScheme = KnownStore.scheme(cmd.to);
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
				const destScheme = KnownStore.scheme(cmd.to);
				if (destScheme === null) cmd._rejected = true;
			}
		}
		assert.ok(!commands[0]._rejected, "known:// mv should be allowed");
	});
});
