import ProjectAgent from "../../agent/ProjectAgent.js";
import File from "../file/file.js";

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

		// Operator-declared project surface (comma-separated literal paths,
		// relative to project root). Files are ingested as entries with
		// default visibility=archived; the model promotes specific
		// entries via <get>. Decouples membership (constraint) from
		// visibility (per-entry, model-controlled).
		const projectFilesRaw = process.env.RUMMY_PROJECT_FILES;
		if (projectFilesRaw) {
			const patterns = projectFilesRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			for (const pattern of patterns) {
				await File.setConstraint(db, projectId, pattern, "add");
			}
		}

		// Watchdog; overridable via --RUMMY_LOOP_TIMEOUT=<ms>. Drains
		// the active loop before exit so SQLite, turn slices, and
		// last_run.txt are durable on disk before the process dies —
		// without this, harbor's outer asyncio.wait_for kills the
		// docker exec mid-pipeline and the trial.log cp commands never
		// run, leaving the post-mortem packet empty.
		const timeoutMs = Number(process.env.RUMMY_LOOP_TIMEOUT);
		const timer = setTimeout(async () => {
			console.error(`rummy-cli: timed out after ${timeoutMs}ms — draining`);
			try {
				await projectAgent.shutdown();
			} catch (err) {
				console.error(`rummy-cli: drain failed: ${err.message}`);
			}
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

		// Capture enriched terminal payload (status, cost, tokens, model)
		// from ask.completed / act.completed. Only one fires for our run.
		let runSummary = null;
		const captureSummary = (payload) => {
			if (payload.run !== alias) return;
			runSummary = payload;
		};
		hooks.ask.completed.on(captureSummary);
		hooks.act.completed.on(captureSummary);

		const runFn =
			mode === "act"
				? projectAgent.act.bind(projectAgent)
				: projectAgent.ask.bind(projectAgent);

		try {
			const result = await runFn(projectId, model, prompt, alias, {});
			const { status } = result;
			if (TERMINAL_STATUSES.has(status)) {
				const text = await this.#findLatestSummary(db, alias);
				if (text) process.stdout.write(`${text}\n`);
			}
			if (runSummary) {
				process.stdout.write(
					`__RUMMY_RUN_SUMMARY__ ${JSON.stringify({
						run: runSummary.run,
						status: runSummary.status,
						turn: runSummary.turn,
						turns: runSummary.turns,
						cost: runSummary.cost,
						tokens: runSummary.tokens,
						model: runSummary.model,
					})}\n`,
				);
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
		if (updates.length === 0) return null;
		return updates.at(-1).body;
	}
}
