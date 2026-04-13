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
	}
}
