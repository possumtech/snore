const BOTH = new Set(["ask", "act"]);

export default class UpdatePlugin {
	static register(hooks) {
		hooks.tools.register("update", {
			modes: BOTH,
			category: "structural",
			project: (entry) => `# update\n${entry.body}`,
		});
	}
}
