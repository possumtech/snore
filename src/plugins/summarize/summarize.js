const BOTH = new Set(["ask", "act"]);

export default class SummarizePlugin {
	static register(hooks) {
		hooks.tools.register("summarize", {
			modes: BOTH,
			category: "structural",
			project: (entry) => `# summarize\n${entry.body}`,
		});
	}
}
