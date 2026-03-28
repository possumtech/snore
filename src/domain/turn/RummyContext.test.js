import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import RummyContext from "./RummyContext.js";

describe("RummyContext", () => {
	const createRoot = () => ({
		tag: "turn",
		attrs: { sequence: "0" },
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
		],
	});

	it("should provide access to standard sections", () => {
		const root = createRoot();
		const ctx = new RummyContext(root, {});

		strictEqual(ctx.system.tag, "system");
		strictEqual(ctx.contextEl.tag, "context");
		strictEqual(ctx.user.tag, "user");
		strictEqual(ctx.assistant.tag, "assistant");
	});

	it("should provide access to context data", () => {
		const mockContext = {
			db: { id: "db-1" },
			project: { id: "p-1" },
			activeFiles: ["a.js"],
			type: "act",
			sessionId: "s-1",
		};
		const ctx = new RummyContext(createRoot(), mockContext);

		strictEqual(ctx.db.id, "db-1");
		strictEqual(ctx.project.id, "p-1");
		deepStrictEqual(ctx.activeFiles, ["a.js"]);
		strictEqual(ctx.type, "act");
		strictEqual(ctx.sessionId, "s-1");
	});

	it("should create new tags with attributes and children", () => {
		const ctx = new RummyContext(createRoot(), {});
		const node = ctx.tag("myTag", { id: "123" }, [
			"Hello",
			ctx.tag("child", {}, []),
		]);

		strictEqual(node.tag, "myTag");
		strictEqual(node.attrs.id, "123");
		strictEqual(node.content, "Hello");
		strictEqual(node.children.length, 1);
		strictEqual(node.children[0].tag, "child");
	});
});
