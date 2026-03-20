import { ok, strictEqual } from "node:assert";
import fs from "node:fs/promises";
import { describe, it, mock } from "node:test";
import PromptManager from "./PromptManager.js";

describe("PromptManager", () => {
	it("should return the custom prompt if provided", async () => {
		const custom = "Custom Prompt";
		const result = await PromptManager.getSystemPrompt("act", custom);
		strictEqual(result, custom);
	});

	it("should read from the file system if custom prompt is null", async () => {
		const readFileMock = mock.method(fs, "readFile", async (path) => {
			if (path.includes("system.act.md")) return "Act Prompt";
			throw new Error("File not found");
		});

		const result = await PromptManager.getSystemPrompt("act");
		strictEqual(result, "Act Prompt");
		readFileMock.mock.restore();
	});

	it("should fallback to generic system.md if type-specific file is missing", async () => {
		const readFileMock = mock.method(fs, "readFile", async (path) => {
			if (path.includes("system.act.md")) throw new Error("ENOENT");
			if (path.includes("system.md")) return "Generic Prompt";
			throw new Error("File not found");
		});

		const result = await PromptManager.getSystemPrompt("act");
		strictEqual(result, "Generic Prompt");
		readFileMock.mock.restore();
	});

	it("should return a default prompt if all file reads fail", async () => {
		const readFileMock = mock.method(fs, "readFile", async () => {
			throw new Error("ENOENT");
		});

		const result = await PromptManager.getSystemPrompt("act");
		ok(result.includes("helpful software engineering assistant"));
		readFileMock.mock.restore();
	});

	it("should format identity correctly", () => {
		const model = "gpt-4";
		const identity = PromptManager.formatIdentity(model);
		strictEqual(identity, `AGENT_MODEL: gpt-4\n`);
	});
});
