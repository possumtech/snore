import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const originalFetch = globalThis.fetch;

describe("SOCKET_PROTOCOL v0.2.0 Verification (Full Compliance)", () => {
	let tdb;
	let tserver;
	let client;
	const projectPath = join(process.cwd(), "test_protocol_v020");

	before(async () => {
		globalThis.fetch = async () => {
			return new Response(
				JSON.stringify({
					model: "mock-model",
					choices: [
						{
							message: {
								role: "assistant",
								content: "Original Response",
								reasoning_content: "Thought process",
							},
						},
					],
					usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		tdb = await TestDb.create("protocol_v020");
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		globalThis.fetch = originalFetch;
		if (client) client.close();
		if (tserver) await tserver.stop();
		if (tdb) await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
	});

	it("should support 'ping' method", async () => {
		const result = await client.call("ping", {});
		assert.deepStrictEqual(result, {});
	});

	it("should support 'getModels' method", async () => {
		const result = await client.call("getModels", {});
		assert.ok(Array.isArray(result));
	});

	it("should support lifecycle and file operations", async () => {
		const initResult = await client.call("init", {
			projectPath,
			projectName: "Protocol Test",
			clientId: "test-client",
		});
		assert.ok(initResult.context);
		assert.ok("gitRoot" in initResult.context);

		// updateFiles
		const updateResult = await client.call("updateFiles", {
			files: [{ path: "README.md", visibility: "active" }],
		});
		assert.strictEqual(updateResult.status, "ok");

		// getFiles
		const files = await client.call("getFiles", {});
		assert.ok(Array.isArray(files));
		assert.ok(files.some((f) => f.path === "README.md"));
	});

	it("should support 'act' method and all bundled findings", async () => {
		// Mock LLM response to trigger all detections via SnoreNvimPlugin
		tserver.hooks.addFilter("llm.response", (response) => {
			return {
				...response,
				content: "Acting... SNORE_TEST_NOTIFY SNORE_TEST_RENDER SNORE_TEST_DIFF",
				reasoning_content: "I need to notify and diff.",
			};
		});

		const result = await client.call("act", {
			model: "mock-model",
			prompt: "Trigger notifications",
		});

		// Verify Atomic Turn bundling
		assert.ok(result.id);
		assert.strictEqual(result.model, "mock-model");
		assert.strictEqual(result.snore.alias, "mock-model");
		assert.ok(result.snore.actualModel);
		assert.ok(Array.isArray(result.snore.activeFiles));

		// Verify bundled diffs
		assert.ok(result.snore.diffs.length > 0);
		assert.strictEqual(result.snore.diffs[0].file, "test.txt");
		assert.ok(result.snore.diffs[0].patch.includes("--- test.txt"));

		// Verify bundled notifications
		assert.ok(result.snore.notifications.length >= 2);
		const notify = result.snore.notifications.find((n) => n.type === "notify");
		const render = result.snore.notifications.find((n) => n.type === "render");
		assert.strictEqual(notify.text, "System notification detected in response");
		assert.strictEqual(render.text, "# Rendered Content");

		const message = result.choices[0].message;
		assert.strictEqual(message.role, "assistant");
		assert.ok(message.content.includes("Acting..."));
		assert.strictEqual(message.reasoning_content, "I need to notify and diff.");
		assert.ok(result.usage);
	});

	it("should support iterating on a Run (multi-turn context)", async () => {
		// 1. First act to start a run
		tserver.hooks.addFilter("llm.response", (response) => ({
			...response,
			content: "Proposal 1",
		}));

		const res1 = await client.call("act", {
			model: "mock-model",
			prompt: "First request",
		});
		const runId = res1.id;

		// 2. Second act with same runId
		// We mock fetch to verify the messages sent to the LLM
		const originalFetch = globalThis.fetch;
		let lastSentMessages = [];
		globalThis.fetch = async (_url, options) => {
			const body = JSON.parse(options.body);
			lastSentMessages = body.messages;
			return new Response(
				JSON.stringify({
					model: "mock-model",
					choices: [{ message: { role: "assistant", content: "Proposal 2" } }],
					usage: { total_tokens: 5 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			const res2 = await client.call("act", {
				model: "mock-model",
				prompt: "Second request",
				runId,
			});

			assert.strictEqual(res2.id, runId);
			// Verify history: should have [System, User(1), Assistant(1), User(2)]
			assert.strictEqual(lastSentMessages.length, 4);
			assert.strictEqual(
				lastSentMessages[1].content,
				"<user><ask>First request</ask></user>",
			);
			assert.strictEqual(lastSentMessages[2].content, "Proposal 1");
			assert.strictEqual(
				lastSentMessages[3].content,
				"<user><ask>Second request</ask></user>",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
