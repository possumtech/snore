import docs from "./thinkDoc.js";

const THINK_ENABLED = process.env.RUMMY_THINK;
if (THINK_ENABLED === undefined)
	throw new Error("RUMMY_THINK must be set (1 or 0)");

export default class Think {
	constructor(core) {
		core.registerScheme({ modelVisible: 0, category: "logging" });
		if (THINK_ENABLED === "1") {
			core.ensureTool();
			core.filter("instructions.toolDocs", async (docsMap) => {
				docsMap.think = docs;
				return docsMap;
			});
		}

		// Merge <think> tag bodies into the turn's reasoning_content so
		// models without a dedicated reasoning channel still expose their
		// reasoning through the same field.
		core.filter("llm.reasoning", (reasoning, { commands }) => {
			const thinkText = commands
				.filter((c) => c.name === "think")
				.map((c) => c.body)
				.filter(Boolean)
				.join("\n");
			const parts = [reasoning || "", thinkText].filter(Boolean);
			return parts.join("\n");
		});
	}
}
