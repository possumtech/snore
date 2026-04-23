import Entries from "../../agent/Entries.js";
import docs from "./rmDoc.js";

const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

export default class Rm {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.rm = docs;
			return docsMap;
		});
		core.on("proposal.accepted", this.#onAccepted.bind(this));
	}

	async #onAccepted(ctx) {
		const m = LOG_ACTION_RE.exec(ctx.path);
		if (m?.[1] !== "rm") return;
		const target = ctx.attrs?.path;
		if (!target) return;
		await ctx.entries.rm({ runId: ctx.runId, path: target });
		if (ctx.projectRoot) {
			const { unlink } = await import("node:fs/promises");
			const { join } = await import("node:path");
			try {
				await unlink(join(ctx.projectRoot, target));
			} catch (err) {
				// File may already be absent — entry rm'd regardless.
				if (err.code !== "ENOENT") throw err;
			}
		}
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const target = entry.attributes.path;
		if (!target) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: "",
				state: "failed",
				outcome: "validation",
				attributes: { error: "path is required" },
				loopId,
			});
			return;
		}
		const normalized = Entries.normalizePath(target);
		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			entry.attributes.body,
		);

		if (matches.length === 0) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: "",
				state: "failed",
				outcome: "not_found",
				attributes: { path: target, error: `${target} not found` },
				loopId,
			});
			return;
		}

		const fileMatches = matches.filter((m) => m.scheme === null);
		const schemeMatches = matches.filter((m) => m.scheme !== null);

		// Scheme entries: remove all, write one aggregate result entry
		for (const match of schemeMatches)
			await store.rm({ runId: runId, path: match.path });
		if (schemeMatches.length > 0) {
			const paths = schemeMatches.map((m) => m.path).join("\n");
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: paths,
				state: "resolved",
				attributes: { path: target },
				loopId,
			});
		}

		// File entries: individual proposals (require user resolution)
		if (fileMatches.length > 0 && schemeMatches.length > 0)
			await store.rm({ runId: runId, path: entry.resultPath });
		for (const match of fileMatches) {
			const resultPath =
				schemeMatches.length === 0 && fileMatches.length === 1
					? entry.resultPath
					: await store.logPath(runId, turn, "rm", match.path);
			await store.set({
				runId,
				turn,
				path: resultPath,
				body: match.path,
				state: "proposed",
				attributes: { path: match.path },
				loopId,
			});
		}
	}

	full(entry) {
		const header = `# rm ${entry.attributes.path || entry.path}`;
		return entry.body ? `${header}\n${entry.body}` : header;
	}

	summary() {
		return "";
	}
}
