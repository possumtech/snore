import assert from "node:assert";
import { describe, it } from "node:test";
import Turn from "./Turn.js";

describe("Turn", () => {
	it("should serialize to OpenAI messages with XML tags and file status", () => {
		const turn = new Turn();
		turn.system.content.add("System instructions", 10);
		turn.user.prompt.add("User question", 10);
		turn.context.files.add(
			{ path: "f1.js", content: "code", status: "active" },
			10,
		);
		turn.context.files.add(
			{ path: "f2.js", symbols: [{ name: "sym" }], mode: "hot" },
			20,
		);

		const messages = turn.serialize();
		const sys = messages[0].content;

		// Use regex to ignore indentation noise
		assert.ok(/<file path="f1.js" status="active">/.test(sys));
		assert.ok(/code/.test(sys));
		assert.ok(/<file path="f2.js" status="hot">/.test(sys));
	});

	it("should serialize full turn including assistant reasoning", () => {
		const turn = new Turn();
		turn.assistant.reasoning.add("Thinking...", 10);
		turn.assistant.content.add("Response", 10);

		const xml = turn.toXml();
		assert.ok(xml.includes("<reasoning_content>"));
		assert.ok(xml.includes("Thinking..."));
		assert.ok(xml.includes("<content>"));
		assert.ok(xml.includes("Response"));
	});
});
