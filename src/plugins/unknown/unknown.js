const BOTH = new Set(["ask", "act"]);

export default class UnknownPlugin {
	static register(hooks) {
		hooks.tools.register("unknown", {
			modes: BOTH,
			category: "structural",
			project: (entry) => `# unknown\n${entry.body}`,
		});
	}
}
