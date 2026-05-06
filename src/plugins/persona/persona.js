export default class Persona {
	constructor(core) {
		core.registerScheme({ name: "persona", category: "data" });
		core.hooks.tools.onView("persona", (entry) => entry.body, "visible");
		core.hooks.tools.onView("persona", () => "", "summarized");
	}
}
