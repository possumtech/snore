import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import CtagsExtractor from "./CtagsExtractor.js";

describe("CtagsExtractor", () => {
	it("should return empty map if ctags is not installed (ENOENT)", () => {
		const mockSpawn = mock.fn(() => ({
			error: { code: "ENOENT" },
		}));
		const extractor = new CtagsExtractor("/root", mockSpawn);
		const results = extractor.extract(["test.js"]);

		deepStrictEqual(results, new Map([["test.js", []]]));
		strictEqual(mockSpawn.mock.callCount(), 1);
	});

	it("should return empty map if ctags fails (non-zero status)", () => {
		const mockSpawn = mock.fn(() => ({
			status: 1,
			stderr: "error",
		}));
		const extractor = new CtagsExtractor("/root", mockSpawn);
		const results = extractor.extract(["test.js"]);

		deepStrictEqual(results, new Map([["test.js", []]]));
		strictEqual(mockSpawn.mock.callCount(), 1);
	});

	it("should parse ctags JSON output correctly", () => {
		const mockOutput = [
			JSON.stringify({
				path: "test.js",
				name: "myFunc",
				kind: "f",
				line: 10,
				signature: "(a, b)",
			}),
			JSON.stringify({
				path: "other.js",
				name: "otherVar",
				kind: "v",
				line: 20,
			}),
		].join("\n");

		const mockSpawn = mock.fn(() => ({
			status: 0,
			stdout: mockOutput,
		}));

		const extractor = new CtagsExtractor("/root", mockSpawn);
		const results = extractor.extract(["test.js", "other.js"]);

		strictEqual(results.size, 2);
		deepStrictEqual(results.get("test.js"), [
			{
				name: "myFunc",
				type: "f",
				params: "(a, b)",
				line: 10,
				source: "standard",
			},
		]);
		deepStrictEqual(results.get("other.js"), [
			{
				name: "otherVar",
				type: "v",
				params: null,
				line: 20,
				source: "standard",
			},
		]);
	});

	it("should handle Lua signatures via regex hack", () => {
		const mockOutput = JSON.stringify({
			path: "test.lua",
			name: "myLuaFunc",
			kind: "f",
			line: 5,
			pattern: "/function myLuaFunc(x, y)/",
		});

		const mockSpawn = mock.fn(() => ({
			status: 0,
			stdout: mockOutput,
		}));

		const extractor = new CtagsExtractor("/root", mockSpawn);
		const results = extractor.extract(["test.lua"]);

		deepStrictEqual(results.get("test.lua"), [
			{
				name: "myLuaFunc",
				type: "f",
				params: "(x, y)",
				line: 5,
				source: "standard",
			},
		]);
	});
});
