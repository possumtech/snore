import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionError } from "./errors.js";

describe("PermissionError", () => {
	it("formats the 403 message with scheme, writer, and allowed list", () => {
		const err = new PermissionError("log", "client", [
			"system",
			"plugin",
			"model",
		]);
		assert.equal(err.name, "PermissionError");
		assert.equal(
			err.message,
			'403: writer "client" not permitted for scheme "log" (allowed: system, plugin, model)',
		);
	});

	it("preserves scheme, writer, allowed as instance fields", () => {
		const allowed = ["system", "plugin"];
		const err = new PermissionError("known", "client", allowed);
		assert.equal(err.scheme, "known");
		assert.equal(err.writer, "client");
		assert.deepEqual(err.allowed, ["system", "plugin"]);
	});

	it("copies allowed (mutating instance.allowed does not mutate caller)", () => {
		const allowed = ["system"];
		const err = new PermissionError("log", "client", allowed);
		err.allowed.push("plugin");
		assert.deepEqual(allowed, ["system"]);
	});

	it("renders null scheme as (none) — no scheme called 'file' is invented", () => {
		const err = new PermissionError(null, "model", ["system", "plugin"]);
		assert.equal(err.scheme, null);
		assert.match(err.message, /scheme "\(none\)"/);
		assert.doesNotMatch(err.message, /scheme "file"/);
	});

	it("is an Error and a PermissionError under instanceof", () => {
		const err = new PermissionError("log", "client", []);
		assert.ok(err instanceof Error);
		assert.ok(err instanceof PermissionError);
	});

	it("works with empty allowed list (no allowed writers)", () => {
		const err = new PermissionError("log", "client", []);
		assert.equal(
			err.message,
			'403: writer "client" not permitted for scheme "log" (allowed: )',
		);
	});
});
