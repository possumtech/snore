const BOTH = new Set(["ask", "act"]);
const ACT_ONLY = new Set(["act"]);

export default class CoreToolsPlugin {
	static register(hooks) {
		const { tools } = hooks;

		// Structural
		tools.register("summary", { modes: BOTH, category: "structural" });
		tools.register("update", { modes: BOTH, category: "structural" });
		tools.register("unknown", { modes: BOTH, category: "structural" });

		// Investigation (direct execution)
		tools.register("read", { modes: BOTH, category: "ask" });
		tools.register("store", { modes: BOTH, category: "ask" });
		tools.register("env", { modes: BOTH, category: "ask" });

		// Mutation (proposed for client resolution)
		tools.register("write", { modes: BOTH, category: "act" });
		tools.register("move", { modes: BOTH, category: "act" });
		tools.register("copy", { modes: BOTH, category: "act" });
		tools.register("delete", { modes: BOTH, category: "act" });
		tools.register("run", { modes: ACT_ONLY, category: "act" });
		tools.register("ask_user", { modes: BOTH, category: "act" });
	}
}
