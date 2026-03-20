import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import RummyContext from "./RummyContext.js";

describe("RummyContext", () => {
	const dom = new DOMImplementation();
	const createDoc = () => {
		const doc = dom.createDocument(null, "turn", null);
		const root = doc.documentElement;
		root.appendChild(doc.createElement("system"));
		root.appendChild(doc.createElement("context"));
		root.appendChild(doc.createElement("user"));
		root.appendChild(doc.createElement("assistant"));
		return doc;
	};

	it("should provide access to standard XML sections", () => {
		const doc = createDoc();
		const ctx = new RummyContext(doc, {});

		strictEqual(ctx.system.tagName, "system");
		strictEqual(ctx.contextEl.tagName, "context");
		strictEqual(ctx.user.tagName, "user");
		strictEqual(ctx.assistant.tagName, "assistant");
	});

	it("should provide access to context data", () => {
		const mockContext = {
			db: { id: "db-1" },
			project: { id: "p-1" },
			activeFiles: ["a.js"],
			type: "act",
			sessionId: "s-1",
		};
		const ctx = new RummyContext(createDoc(), mockContext);

		strictEqual(ctx.db.id, "db-1");
		strictEqual(ctx.project.id, "p-1");
		deepStrictEqual(ctx.activeFiles, ["a.js"]);
		strictEqual(ctx.type, "act");
		strictEqual(ctx.sessionId, "s-1");
	});

	it("should create new tags with attributes and children", () => {
		const ctx = new RummyContext(createDoc(), {});
		const tag = ctx.tag("myTag", { id: "123" }, [
			"Hello",
			ctx.tag("child", {}, []),
		]);

		strictEqual(tag.tagName, "myTag");
		strictEqual(tag.getAttribute("id"), "123");
		strictEqual(tag.childNodes.length, 2);
		strictEqual(tag.childNodes[0].nodeValue, "Hello");
		strictEqual(tag.childNodes[1].tagName, "child");
	});
});
