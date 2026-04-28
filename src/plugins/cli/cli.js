import config from "../../agent/config.js";
import ProjectAgent from "../../agent/ProjectAgent.js";

const TERMINAL_STATUSES = new Set([200, 204, 413, 422, 499, 500]);

// Inert unless RUMMY_PROMPT is set; see plugin README.
export default class Cli {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("boot.completed", this.#onBoot.bind(this));
	}

	async #onBoot({ db, hooks }) {
		const prompt = process.env.RUMMY_PROMPT;
		if (!prompt) return;

		const model = process.env.RUMMY_MODEL;
		if (!model) {
			console.error("rummy-cli: RUMMY_MODEL is required");
			process.exit(2);
		}

		const rawMode = process.env.RUMMY_MODE;
		const mode = rawMode == null ? "act" : rawMode;
		if (mode !== "ask" && mode !== "act") {
			console.error(
				`rummy-cli: RUMMY_MODE must be "ask" or "act" (got ${JSON.stringify(rawMode)})`,
			);
			process.exit(2);
		}

		const projectRoot = process.cwd();
		const alias = `cli_${Date.now()}`;

		const projectAgent = new ProjectAgent(db, hooks);
		const { projectId } = await projectAgent.init(alias, projectRoot);

		// Watchdog; overridable via --RUMMY_RUN_TIMEOUT_MS=<ms>.
		const timeoutMs = config.RUN_TIMEOUT_MS;
		const timer = setTimeout(() => {
			console.error(`rummy-cli: timed out after ${timeoutMs}ms`);
			process.exit(124);
		}, timeoutMs);
		timer.unref();

		// stderr for progress; stdout reserved for the final summary.
		hooks.run.state.on(async (state) => {
			if (state.run !== alias) return;
			const { status, turn, summary } = state;
			console.error(`[rummy-cli] turn ${turn} status=${status}`);
			if (!TERMINAL_STATUSES.has(status)) return;
			if (summary) process.stdout.write(`${summary}\n`);
			// Brief flush window for any pending writes / hooks.
			await new Promise((r) => setTimeout(r, 50));
			process.exit(status === 200 ? 0 : 1);
		});

		const runFn =
			mode === "act"
				? projectAgent.act.bind(projectAgent)
				: projectAgent.ask.bind(projectAgent);

		runFn(projectId, model, prompt, alias, {}).catch((err) => {
			console.error(`rummy-cli: run crashed: ${err.message}`);
			process.exit(1);
		});
	}
}
