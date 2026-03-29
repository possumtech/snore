import { describe, it } from "node:test";
import assert from "node:assert";
import ToolSchema from "./ToolSchema.js";

describe("ToolSchema", () => {
	describe("tool definitions", () => {
		it("ask mode has 7 tools", () => {
			assert.strictEqual(ToolSchema.ask.length, 7);
		});

		it("act mode has 10 tools", () => {
			assert.strictEqual(ToolSchema.act.length, 10);
		});

		it("act mode includes all ask tools", () => {
			const askNames = ToolSchema.ask.map((t) => t.function.name);
			const actNames = ToolSchema.act.map((t) => t.function.name);
			for (const name of askNames) {
				assert.ok(actNames.includes(name), `act mode missing ask tool: ${name}`);
			}
		});

		it("act-only tools are run, delete, edit", () => {
			const askNames = new Set(ToolSchema.ask.map((t) => t.function.name));
			const actOnly = ToolSchema.act
				.map((t) => t.function.name)
				.filter((n) => !askNames.has(n))
				.sort();
			assert.deepStrictEqual(actOnly, ["delete", "edit", "run"]);
		});

		it("every tool has strict: true", () => {
			for (const tool of ToolSchema.act) {
				assert.strictEqual(tool.function.strict, true, `${tool.function.name} missing strict: true`);
			}
		});

		it("every tool has additionalProperties: false on parameters", () => {
			for (const tool of ToolSchema.act) {
				assert.strictEqual(
					tool.function.parameters.additionalProperties,
					false,
					`${tool.function.name} missing additionalProperties: false`,
				);
			}
		});

		it("every tool has all properties in required", () => {
			for (const tool of ToolSchema.act) {
				const props = Object.keys(tool.function.parameters.properties);
				const required = tool.function.parameters.required;
				assert.deepStrictEqual(
					props.sort(),
					[...required].sort(),
					`${tool.function.name}: properties and required mismatch`,
				);
			}
		});

		it("high-frequency tools have flat string parameters", () => {
			const flat = ["write", "summary", "unknown", "read", "drop", "env", "run", "delete"];
			for (const tool of ToolSchema.act) {
				if (!flat.includes(tool.function.name)) continue;
				const props = tool.function.parameters.properties;
				for (const [propName, schema] of Object.entries(props)) {
					const types = Array.isArray(schema.type) ? schema.type : [schema.type];
					for (const t of types) {
						assert.ok(
							t === "string" || t === "null",
							`${tool.function.name}.${propName} has non-string type: ${t}`,
						);
					}
				}
			}
		});
	});

	describe("API stripping", () => {
		it("API tools have no minLength/maxLength/minItems", () => {
			const json = JSON.stringify(ToolSchema.askApi) + JSON.stringify(ToolSchema.actApi);
			assert.ok(!json.includes("minLength"), "API schemas contain minLength");
			assert.ok(!json.includes("maxLength"), "API schemas contain maxLength");
			assert.ok(!json.includes("minItems"), "API schemas contain minItems");
		});

		it("master tools preserve minLength/maxLength where specified", () => {
			const summarySchema = ToolSchema.master.summary.function.parameters;
			assert.strictEqual(summarySchema.properties.text.maxLength, 80);
			assert.strictEqual(summarySchema.properties.text.minLength, 1);
		});

		it("API tools preserve structure and descriptions", () => {
			for (const apiTool of ToolSchema.actApi) {
				const name = apiTool.function.name;
				const master = ToolSchema.master[name];
				assert.strictEqual(apiTool.function.description, master.function.description);
				assert.strictEqual(apiTool.function.strict, true);
			}
		});
	});

	describe("argument validation", () => {
		it("valid write passes", () => {
			const { valid } = ToolSchema.validate("write", {
				key: "/:known/test", value: "hello",
			});
			assert.ok(valid);
		});

		it("write with empty key fails (minLength)", () => {
			const { valid } = ToolSchema.validate("write", { key: "", value: "x" });
			assert.ok(!valid);
		});

		it("write with empty value passes (blank values are legitimate)", () => {
			const { valid } = ToolSchema.validate("write", { key: "/:known/x", value: "" });
			assert.ok(valid);
		});

		it("valid summary passes", () => {
			const { valid } = ToolSchema.validate("summary", { text: "All good." });
			assert.ok(valid);
		});

		it("summary with empty text fails (minLength)", () => {
			const { valid } = ToolSchema.validate("summary", { text: "" });
			assert.ok(!valid);
		});

		it("summary over 80 chars fails (maxLength)", () => {
			const { valid } = ToolSchema.validate("summary", { text: "x".repeat(81) });
			assert.ok(!valid);
		});

		it("summary at exactly 80 chars passes", () => {
			const { valid } = ToolSchema.validate("summary", { text: "x".repeat(80) });
			assert.ok(valid);
		});

		it("valid unknown passes", () => {
			const { valid } = ToolSchema.validate("unknown", { text: "What is X?" });
			assert.ok(valid);
		});

		it("unknown with empty text fails (minLength)", () => {
			const { valid } = ToolSchema.validate("unknown", { text: "" });
			assert.ok(!valid);
		});

		it("valid read passes", () => {
			const { valid } = ToolSchema.validate("read", { key: "src/app.js", reason: "check it" });
			assert.ok(valid);
		});

		it("read with empty key fails", () => {
			const { valid } = ToolSchema.validate("read", { key: "", reason: "check it" });
			assert.ok(!valid);
		});

		it("valid edit passes", () => {
			const { valid } = ToolSchema.validate("edit", {
				file: "src/app.js", search: "old", replace: "new",
			});
			assert.ok(valid);
		});

		it("edit with null search passes (new file)", () => {
			const { valid } = ToolSchema.validate("edit", {
				file: "src/new.js", search: null, replace: "content",
			});
			assert.ok(valid);
		});

		it("edit with empty replace fails", () => {
			const { valid } = ToolSchema.validate("edit", {
				file: "src/app.js", search: "old", replace: "",
			});
			assert.ok(!valid);
		});

		it("valid prompt passes", () => {
			const { valid } = ToolSchema.validate("prompt", {
				question: "Which?", options: ["A", "B"],
			});
			assert.ok(valid);
		});

		it("prompt with one option fails (minItems: 2)", () => {
			const { valid } = ToolSchema.validate("prompt", {
				question: "Which?", options: ["only one"],
			});
			assert.ok(!valid);
		});

		it("unknown tool name fails", () => {
			const { valid, errors } = ToolSchema.validate("nonexistent", {});
			assert.ok(!valid);
			assert.ok(errors[0].message.includes("Unknown tool"));
		});
	});

	describe("required tool validation", () => {
		it("passes when summary present", () => {
			const { valid } = ToolSchema.validateRequired(["summary", "write", "read"]);
			assert.ok(valid);
		});

		it("fails when summary missing", () => {
			const { valid, missing } = ToolSchema.validateRequired(["write", "read"]);
			assert.ok(!valid);
			assert.deepStrictEqual(missing, ["summary"]);
		});

		it("passes with only summary", () => {
			const { valid } = ToolSchema.validateRequired(["summary"]);
			assert.ok(valid);
		});
	});

	describe("mode validation", () => {
		it("ask mode rejects act-only tools", () => {
			const { valid, invalid } = ToolSchema.validateMode("ask", ["write", "summary", "run"]);
			assert.ok(!valid);
			assert.deepStrictEqual(invalid, ["run"]);
		});

		it("act mode accepts all tools", () => {
			const { valid } = ToolSchema.validateMode("act", [
				"write", "summary", "read", "drop", "env", "prompt",
				"run", "delete", "edit",
			]);
			assert.ok(valid);
		});

		it("ask mode accepts all shared tools", () => {
			const { valid } = ToolSchema.validateMode("ask", [
				"write", "summary", "unknown", "read", "drop", "env", "prompt",
			]);
			assert.ok(valid);
		});
	});
});
