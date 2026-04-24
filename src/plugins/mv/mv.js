import Entries from "../../agent/Entries.js";
import docs from "./mvDoc.js";

const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

export default class Mv {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.mv = docs;
			return docsMap;
		});
		core.on("proposal.accepted", this.#onAccepted.bind(this));
	}

	async #onAccepted(ctx) {
		const m = LOG_ACTION_RE.exec(ctx.path);
		if (m?.[1] !== "mv") return;
		if (!ctx.attrs?.isMove || !ctx.attrs?.from) return;
		await ctx.entries.rm({ runId: ctx.runId, path: ctx.attrs.from });
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const { path, to } = entry.attributes;
		const VALID = { visible: 1, summarized: 1, archived: 1 };
		const visibility = VALID[entry.attributes.visibility]
			? entry.attributes.visibility
			: undefined;

		// Visibility-in-place: no destination, change visibility of matched entries
		if (visibility && !to) {
			const matches = await store.getEntriesByPattern(runId, path);
			for (const match of matches)
				await store.set({
					runId: runId,
					path: match.path,
					visibility: visibility,
				});
			const label = `set to ${visibility}`;
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${matches.map((m) => m.path).join(", ")} ${label}`,
				state: "resolved",
				visibility: "archived",
				loopId,
			});
			return;
		}

		const source = await store.getBody(runId, path);
		if (source === null) return;

		const destScheme = Entries.scheme(to);
		const existing = await store.getBody(runId, to);
		const warning =
			existing !== null && destScheme !== null
				? `Overwrote existing entry at ${to}`
				: null;

		const body = `${path} ${to}`;
		if (destScheme === null) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body,
				state: "proposed",
				attributes: { from: path, to, isMove: true, warning },
				loopId,
			});
		} else {
			await store.set({
				runId,
				turn,
				path: to,
				body: source,
				state: "resolved",
				visibility,
				loopId,
			});
			await store.rm({ runId: runId, path: path });
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body,
				state: "resolved",
				attributes: { from: path, to, isMove: true, warning },
				loopId,
			});
		}
	}

	full(entry) {
		return `# mv ${entry.attributes.from} ${entry.attributes.to}`;
	}

	summary() {
		return "";
	}
}
