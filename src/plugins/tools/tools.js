const BOTH = new Set(["ask", "act"]);
const ACT_ONLY = new Set(["act"]);

export default class CoreToolsPlugin {
	static register(hooks) {
		const { tools } = hooks;

		// Structural
		tools.register("write", { modes: BOTH, category: "structural" });
		tools.register("summary", { modes: BOTH, category: "structural" });
		tools.register("unknown", { modes: BOTH, category: "structural" });

		// Ask tools (direct execution)
		tools.register("read", { modes: BOTH, category: "ask" });
		tools.register("drop", { modes: BOTH, category: "ask" });
		tools.register("env", { modes: BOTH, category: "ask" });

		// Act tools (proposed for client resolution)
		tools.register("edit", { modes: ACT_ONLY, category: "act" });
		tools.register("delete", { modes: ACT_ONLY, category: "act" });
		tools.register("run", { modes: ACT_ONLY, category: "act" });
		tools.register("ask_user", { modes: BOTH, category: "act" });
	}
}
