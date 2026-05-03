import docs from "./thinkDoc.js";

const THINK = process.env.RUMMY_THINK === "1";

export default class Think {
	constructor(core) {
		core.registerScheme({ modelVisible: 0, category: "logging" });
		if (THINK) {
			core.ensureTool();
			core.filter("instructions.toolDocs", async (docsMap) => {
				docsMap.think = docs;
				return docsMap;
			});
		}

		// Merge <think> bodies into reasoning_content for models without a reasoning channel.
		core.filter("llm.reasoning", (reasoning, { commands }) => {
			const thinkText = commands
				.filter((c) => c.name === "think")
				.map((c) => c.body)
				.filter(Boolean)
				.join("\n");
			return [reasoning, thinkText].filter(Boolean).join("\n");
		});
	}
}
