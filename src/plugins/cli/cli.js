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

		// In-process CLI has no socket client to resolve proposals; default
		// YOLO so any proposal-emitting tool auto-accepts. Operator can
		// pass --RUMMY_YOLO=0 to opt out.
		if (process.env.RUMMY_YOLO == null) process.env.RUMMY_YOLO = "1";

		const projectRoot = process.cwd();
		const alias = `cli_${Date.now()}`;

		const projectAgent = new ProjectAgent(db, hooks);
		const { projectId } = await projectAgent.init(alias, projectRoot);

		// Watchdog; overridable via --RUMMY_RUN_TIMEOUT=<ms>.
		const timeoutMs = config.RUN_TIMEOUT;
		const timer = setTimeout(() => {
			console.error(`rummy-cli: timed out after ${timeoutMs}ms`);
			process.exit(124);
		}, timeoutMs);
		timer.unref();

		// stderr progress: log update entries as they land.
		hooks.entry.created.on((entry) => {
			if (entry?.scheme !== "update") return;
			const turnMatch = entry.path?.match(/^log:\/\/turn_(\d+)\//);
			if (!turnMatch) return;
			const status = entry.attributes?.status ?? 102;
			console.error(`[rummy-cli] turn ${turnMatch[1]} status=${status}`);
		});

		const runFn =
			mode === "act"
				? projectAgent.act.bind(projectAgent)
				: projectAgent.ask.bind(projectAgent);

		try {
			const result = await runFn(projectId, model, prompt, alias, {});
			const { status } = result;
			if (TERMINAL_STATUSES.has(status)) {
				const summary = await this.#findLatestSummary(db, alias);
				if (summary) process.stdout.write(`${summary}\n`);
			}
			await new Promise((r) => setTimeout(r, 50));
			process.exit(status === 200 ? 0 : 1);
		} catch (err) {
			console.error(`rummy-cli: run crashed: ${err.message}`);
			process.exit(1);
		}
	}

	async #findLatestSummary(db, alias) {
		const runRow = await db.get_run_by_alias.get({ alias });
		if (!runRow) return null;
		const entries = await db.get_known_entries.all({ run_id: runRow.id });
		const updates = entries
			.filter(
				(e) =>
					e.scheme === "log" &&
					/^log:\/\/turn_\d+\/update\//.test(e.path) &&
					e.state === "resolved",
			)
			.toSorted((a, b) => a.turn - b.turn);
		return updates[updates.length - 1]?.body ?? null;
	}
}
