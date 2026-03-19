import test from "node:test";
import assert from "node:assert";
import { DOMParser } from "@xmldom/xmldom";
import Turn from "./Turn.js";

const xmlTemplate = `
    <turn sequence="1">
      <system>System prompt</system>
      <context>
        <file path="test.js" status="modified" size="100" tokens="50">
          <source>console.log('test');</source>
          <symbols>test\tfunc()</symbols>
        </file>
      </context>
      <user>User message</user>
      <assistant>
        <reasoning_content>Thinking...</reasoning_content>
        <content>Response</content>
        <meta>{"usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}, "alias": "gpt-4", "actualModel": "openai/gpt-4"}</meta>
      </assistant>
    </turn>
`;

test("Turn class", async (t) => {
	const parser = new DOMParser();

	await t.test("constructor and doc getter", () => {
		const doc = parser.parseFromString(xmlTemplate, "text/xml");
		const turn = new Turn(doc);
		assert.strictEqual(turn.doc, doc);
	});

	await t.test("assistant helper", () => {
		const doc = parser.parseFromString(xmlTemplate, "text/xml");
		const turn = new Turn(doc);
		const assistant = turn.assistant;
		assert.ok(assistant.reasoning);
		assert.ok(assistant.content);
		assert.ok(assistant.meta);

		assistant.content.add(" More content");
		const contentEl = doc.getElementsByTagName("content")[0];
		assert.strictEqual(contentEl.textContent, "Response More content");

		// Reset meta text content before adding to ensure valid JSON
		const metaEl = doc.getElementsByTagName("meta")[0];
        while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);
		assistant.meta.add({ key: "value" });
		assert.ok(metaEl.textContent.includes('{"key":"value"}'));
	});

	await t.test("serialize()", async () => {
		const doc = parser.parseFromString(xmlTemplate, "text/xml");
		const turn = new Turn(doc);
		const messages = await turn.serialize();
		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].role, "system");
		assert.ok(messages[0].content.includes("System prompt"));
		assert.strictEqual(messages[1].role, "user");
		assert.ok(messages[1].content.includes("User message"));
	});

	await t.test("toJson()", () => {
		const doc = parser.parseFromString(xmlTemplate, "text/xml");
		const turn = new Turn(doc);
		const json = turn.toJson();
		assert.strictEqual(json.sequence, 1);
		assert.strictEqual(json.system.trim(), "System prompt");
		assert.strictEqual(json.user.trim(), "User message");
		assert.strictEqual(json.assistant.content, "Response");
		assert.strictEqual(json.usage.total_tokens, 15);
		assert.strictEqual(json.model.alias, "gpt-4");
		assert.strictEqual(json.files.length, 1);
		assert.strictEqual(json.files[0].path, "test.js");
		assert.strictEqual(json.files[0].symbols[1].params, "()");
	});

	await t.test("toXml()", () => {
		const doc = parser.parseFromString(xmlTemplate, "text/xml");
		const turn = new Turn(doc);
		const xmlOutput = turn.toXml();
		assert.ok(xmlOutput.includes('<turn sequence="1">'));
		assert.ok(xmlOutput.includes("System prompt"));
        assert.ok(xmlOutput.includes("</system>"));
	});

    await t.test("edge cases in toJson", () => {
        const minimalDoc = parser.parseFromString('<turn><assistant><meta>{}</meta></assistant></turn>', 'text/xml');
        const minimalTurn = new Turn(minimalDoc);
        const json = minimalTurn.toJson();
        assert.strictEqual(json.sequence, 0);
        assert.strictEqual(json.usage.prompt_tokens, 0);
    });

    await t.test("serializePretty with various node types", () => {
        const emptyTurn = new Turn(parser.parseFromString('<turn/>', 'text/xml'));
        assert.ok(emptyTurn.toXml().includes('<turn/>'));
    });
});
