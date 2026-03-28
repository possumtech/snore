import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import CtagsExtractor from "../../src/extraction/CtagsExtractor.js";

const ce = new CtagsExtractor(process.cwd());

describe("CtagsExtractor integration — real project files", () => {
	it("should extract class names from JS files", () => {
		const result = ce.extract(["src/application/agent/AgentLoop.js"]);
		const symbols = result.get("src/application/agent/AgentLoop.js");

		ok(symbols.length > 0, "Expected non-empty symbols for AgentLoop.js");
		const classSymbol = symbols.find(
			(s) => s.name === "AgentLoop" && s.type === "class",
		);
		ok(classSymbol, 'Expected to find "AgentLoop" as a class');
		strictEqual(classSymbol.type, "class");
		ok(classSymbol.line > 0, "Expected positive line number");
	});

	it("should extract method signatures with parameters", () => {
		const result = ce.extract(["src/application/agent/AgentLoop.js"]);
		const symbols = result.get("src/application/agent/AgentLoop.js");

		const resolve = symbols.find(
			(s) => s.name === "resolve" && s.type === "method",
		);
		ok(resolve, 'Expected to find "resolve" method');
		ok(resolve.params, "Expected resolve to have params");
		ok(
			resolve.params.includes("runId"),
			'Expected resolve params to contain "runId"',
		);
		ok(
			resolve.params.includes("resolution"),
			'Expected resolve params to contain "resolution"',
		);

		const run = symbols.find((s) => s.name === "run" && s.type === "method");
		ok(run, 'Expected to find "run" method');
		ok(run.params, "Expected run to have params");
		ok(run.params.includes("type"), 'Expected run params to contain "type"');
		ok(
			run.params.includes("sessionId"),
			'Expected run params to contain "sessionId"',
		);
		ok(run.params.includes("model"), 'Expected run params to contain "model"');
	});

	it("should extract constructor parameters", () => {
		const result = ce.extract(["src/domain/turn/Turn.js"]);
		const symbols = result.get("src/domain/turn/Turn.js");

		const ctor = symbols.find(
			(s) => s.name === "constructor" && s.type === "method",
		);
		ok(ctor, "Expected to find constructor");
		ok(ctor.params, "Expected constructor to have params");
		ok(
			ctor.params.includes("db"),
			'Expected constructor params to contain "db"',
		);
		ok(
			ctor.params.includes("turnId"),
			'Expected constructor params to contain "turnId"',
		);
	});

	it("should extract static methods", () => {
		const result = ce.extract(["src/extraction/HeuristicMatcher.js"]);
		const symbols = result.get("src/extraction/HeuristicMatcher.js");

		const matchAndPatch = symbols.find((s) => s.name === "matchAndPatch");
		ok(matchAndPatch, 'Expected to find "matchAndPatch"');
		ok(matchAndPatch.params, "Expected matchAndPatch to have params");
		ok(
			matchAndPatch.params.includes("filePath"),
			'Expected params to contain "filePath"',
		);
		ok(
			matchAndPatch.params.includes("fileContent"),
			'Expected params to contain "fileContent"',
		);
		ok(
			matchAndPatch.params.includes("searchBlock"),
			'Expected params to contain "searchBlock"',
		);
		ok(
			matchAndPatch.params.includes("replaceBlock"),
			'Expected params to contain "replaceBlock"',
		);
	});

	it("should extract symbols from multiple files in one call", () => {
		const paths = [
			"src/application/agent/AgentLoop.js",
			"src/domain/turn/Turn.js",
			"src/extraction/HeuristicMatcher.js",
		];
		const result = ce.extract(paths);

		strictEqual(result.size, 3, "Expected map to have 3 entries");
		for (const path of paths) {
			ok(result.has(path), `Expected map to contain key "${path}"`);
			ok(
				result.get(path).length > 0,
				`Expected non-empty symbols for "${path}"`,
			);
		}
	});

	it("should handle files with private fields", () => {
		const result = ce.extract(["src/application/agent/AgentLoop.js"]);
		const symbols = result.get("src/application/agent/AgentLoop.js");

		// ctags strips the # prefix from private fields and reports them as kind "field"
		const fields = symbols.filter((s) => s.type === "field");
		ok(fields.length > 0, "Expected ctags to report private fields");

		const dbField = fields.find((s) => s.name === "db");
		ok(
			dbField,
			'Expected to find private field "db" (reported without # prefix)',
		);

		const hooksField = fields.find((s) => s.name === "hooks");
		ok(
			hooksField,
			'Expected to find private field "hooks" (reported without # prefix)',
		);
	});

	it("should skip Lua files gracefully when none exist", () => {
		// No .lua files exist in this project; verify extract handles an empty/missing file
		const result = ce.extract(["src/plugins/nvim/nonexistent.lua"]);
		const symbols = result.get("src/plugins/nvim/nonexistent.lua");

		// ctags will either return empty or warn — either way the map key should exist
		ok(Array.isArray(symbols), "Expected an array for nonexistent lua path");
	});

	it("should produce symbols that match what RepoMap would store", () => {
		const result = ce.extract(["src/domain/turn/Turn.js"]);
		const symbols = result.get("src/domain/turn/Turn.js");

		ok(symbols.length > 0, "Expected non-empty symbols");

		for (const symbol of symbols) {
			strictEqual(typeof symbol.name, "string", "Expected name to be a string");
			ok(symbol.name.length > 0, "Expected name to be non-empty");
			strictEqual(typeof symbol.type, "string", "Expected type to be a string");
			ok(Number.isInteger(symbol.line), "Expected line to be an integer");
			ok(symbol.line > 0, "Expected line to be positive");
		}

		// Methods and functions should have params (from --fields=+S)
		const methods = symbols.filter(
			(s) => s.type === "method" || s.type === "function",
		);
		for (const method of methods) {
			ok(
				method.params !== undefined,
				`Expected params to be defined for ${method.name}`,
			);
			if (method.params !== null) {
				strictEqual(
					typeof method.params,
					"string",
					`Expected params to be a string for ${method.name}`,
				);
			}
		}
	});
});
