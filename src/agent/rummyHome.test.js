import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import resolveRummyHome from "./rummyHome.js";

describe("resolveRummyHome", () => {
	let original;

	beforeEach(() => {
		original = process.env.RUMMY_HOME;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.RUMMY_HOME;
		else process.env.RUMMY_HOME = original;
	});

	it("returns RUMMY_HOME env var when set (absolute)", () => {
		process.env.RUMMY_HOME = "/srv/rummy";
		assert.equal(resolveRummyHome(), "/srv/rummy");
	});

	it("returns RUMMY_HOME env var verbatim when set (relative — no normalization)", () => {
		process.env.RUMMY_HOME = "./rel/path";
		assert.equal(resolveRummyHome(), "./rel/path");
	});

	it("falls back to ~/.rummy when RUMMY_HOME unset", () => {
		delete process.env.RUMMY_HOME;
		assert.equal(resolveRummyHome(), join(homedir(), ".rummy"));
	});

	it("treats empty-string RUMMY_HOME as unset (truthy check)", () => {
		process.env.RUMMY_HOME = "";
		assert.equal(resolveRummyHome(), join(homedir(), ".rummy"));
	});
});
