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
		// Mock LLM response to trigger all detections via RummyNvimPlugin
		tserver.hooks.addFilter("llm.response", (response) => {
			return {
				...response,
				content:
					"Acting... RUMMY_TEST_NOTIFY RUMMY_TEST_RENDER RUMMY_TEST_DIFF",
				reasoning_content: "I need to notify and diff.",
			};
		});

		const result = await client.call("act", {
			model: "mock-model",
			prompt: "Trigger notifications",
		});

		// Verify Atomic Turn bundling
		assert.ok(result.runId);
		assert.strictEqual(result.model.requested, "mock-model");
		assert.strictEqual(result.model.display, "mock-model");
		assert.ok(result.model.actual);
		assert.ok(Array.isArray(result.activeFiles));

		// Verify bundled diffs
		assert.ok(result.diffs.length > 0);
		assert.strictEqual(result.diffs[0].file, "test.txt");
		assert.ok(result.diffs[0].patch.includes("--- test.txt"));

		// Verify bundled notifications
		assert.ok(result.notifications.length >= 2);
		const notify = result.notifications.find((n) => n.type === "notify");
		const render = result.notifications.find((n) => n.type === "render");
		assert.strictEqual(notify.text, "System notification detected in response");
		assert.strictEqual(render.text, "# Rendered Content");

		assert.ok(result.content.includes("Acting..."));
		assert.strictEqual(result.reasoning, "I need to notify and diff.");
		assert.ok(result.usage);
	});

	it("should support iterating on a Run (multi-turn context)", async () => {
		// 1. First act to start a run
		tserver.hooks.llm.response.addFilter((response) => ({
			...response,
			content: "Proposal 1",
		}));

		const res1 = await client.call("act", {
			model: "mock-model",
			prompt: "First request",
		});
		const runId = res1.runId;
		assert.ok(runId);
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

			assert.strictEqual(res2.runId, runId);
			// Verify history: should have [System, User(1), Assistant(1), User(2)]
			assert.strictEqual(lastSentMessages.length, 4);
			assert.strictEqual(
				lastSentMessages[1].content,
				"<user><act>First request</act></user>",
			);
			assert.strictEqual(lastSentMessages[2].content, "Proposal 1");
			assert.strictEqual(
				lastSentMessages[3].content,
				"<user><act>Second request</act></user>",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("should support systemPrompt, persona, skills, and inject edit instructions for 'act'", async () => {
		await client.call("systemPrompt", { text: "You are the base agent." });
		await client.call("persona", { text: "You are a helpful test bot." });
		await client.call("skill/add", { name: "test-skill-1" });
		await client.call("skill/add", { name: "test-skill-2" });
		await client.call("skill/remove", { name: "test-skill-2" });

		const originalFetch = globalThis.fetch;
		let lastSentMessages = [];
		globalThis.fetch = async (_url, options) => {
			const body = JSON.parse(options.body);
			lastSentMessages = body.messages;
			return new Response(
				JSON.stringify({
					model: "mock-model",
					choices: [{ message: { role: "assistant", content: "OK" } }],
					usage: { total_tokens: 5 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			await client.call("act", {
				model: "mock-model",
				prompt: "Check persona",
			});

			assert.strictEqual(lastSentMessages.length, 2);
			const systemPrompt = lastSentMessages[0].content;
			
			// Verify systemPrompt injected
			assert.ok(systemPrompt.includes("You are the base agent."));
			// Verify persona injected
			assert.ok(systemPrompt.includes("<persona>You are a helpful test bot.</persona>"));
			// Verify skill injected
			assert.ok(systemPrompt.includes("<skills><skill>test-skill-1</skill></skills>"));
			// Verify removed skill is absent
			assert.ok(!systemPrompt.includes("test-skill-2"));
			// Verify edit instructions injected because type is 'act'
			assert.ok(systemPrompt.includes("<instructions><edit_format>"));
			assert.ok(systemPrompt.includes("<<<<<<< SEARCH"));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
