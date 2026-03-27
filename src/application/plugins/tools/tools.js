const BOTH = new Set(["ask", "act"]);
const ACT_ONLY = new Set(["act"]);

export default class CoreToolsPlugin {
	static register(hooks) {
		const { tools } = hooks;

		tools.register("read", { modes: BOTH, category: "ask" });
		tools.register("drop", { modes: BOTH, category: "ask" });
		tools.register("summary", { modes: BOTH, category: "structural" });
		tools.register("env", { modes: BOTH, category: "act" });
		tools.register("prompt_user", { modes: BOTH, category: "act" });
		tools.register("edit", { modes: ACT_ONLY, category: "act" });
		tools.register("create", { modes: ACT_ONLY, category: "act" });
		tools.register("delete", { modes: ACT_ONLY, category: "act" });
		tools.register("run", { modes: ACT_ONLY, category: "act" });
	}
}
