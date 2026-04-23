/**
 * instructions plugin: phase transition contract.
 *
 * The prose in `instructions_10N.md` advertises the `<update
 * status="1XY">` codes the model is authorized to emit for phase N,
 * where X=current phase and Y=next phase. The scanner must route on Y
 * so the next turn's `<instructions>` block is the phase the model
 * said to go to. Dropping a status silently — the original bug —
 * strands the loop in the current phase regardless of what the model
 * emitted.
 *
 * Routable phases are 4–9. Phases without an `instructions_10N.md`
 * render no <instructions> block (the model runs on base instructions
 * only). That lets routing exist ahead of prose.
 *
 * This file is the contract test between the prose the model reads and
 * the code that interprets the model's reply. It extends automatically
 * as new phases or transitions are advertised.
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Instructions from "./instructions.js";

const ROUTABLE_PHASES = [4, 5, 6, 7, 8, 9];

function phaseFileExists(phase) {
	return existsSync(new URL(`./instructions_10${phase}.md`, import.meta.url));
}

function loadAdvertisedStatuses(phase) {
	if (!phaseFileExists(phase)) return [];
	const md = readFileSync(
		new URL(`./instructions_10${phase}.md`, import.meta.url),
		"utf8",
	);
	return [...md.matchAll(/<update\s+status="(\d+)"/g)].map((m) => Number(m[1]));
}

function makeHooks() {
	const hooks = createHooks();
	const core = new PluginContext("instructions", hooks);
	new Instructions(core);
	return hooks;
}

async function renderFor(rows) {
	const hooks = makeHooks();
	return hooks.assembly.user.filter("", { rows });
}

function updateRow(turn, status) {
	return {
		path: `log://turn_${turn}/update/stub`,
		attributes: JSON.stringify({ status, action: "update" }),
	};
}

function phaseFirstLine(phase) {
	return readFileSync(
		new URL(`./instructions_10${phase}.md`, import.meta.url),
		"utf8",
	)
		.trim()
		.split("\n")[0];
}

describe("instructions phase transition contract", () => {
	it("advertised status codes are well-formed 1XY with X=file phase and Y in routable range", () => {
		for (const currentPhase of ROUTABLE_PHASES) {
			for (const status of loadAdvertisedStatuses(currentPhase)) {
				if (status === 200) continue; // terminal
				const declaredCurrent = Math.floor(status / 10) % 10;
				const declaredNext = status % 10;
				assert.strictEqual(
					declaredCurrent,
					currentPhase,
					`instructions_10${currentPhase}.md advertises status=${status} whose tens-digit is phase ${declaredCurrent}, not ${currentPhase}`,
				);
				assert.ok(
					ROUTABLE_PHASES.includes(declaredNext),
					`instructions_10${currentPhase}.md advertises status=${status} routing to phase ${declaredNext} which is not in the routable range ${ROUTABLE_PHASES}`,
				);
			}
		}
	});

	it("every advertised status routes to the phase it declares (full round-trip)", async () => {
		for (const currentPhase of ROUTABLE_PHASES) {
			for (const status of loadAdvertisedStatuses(currentPhase)) {
				const nextPhase = status === 200 ? 8 : status % 10;
				const out = await renderFor([updateRow(1, status)]);
				if (!phaseFileExists(nextPhase)) {
					assert.ok(
						!out.includes("<instructions>"),
						`status=${status} routes to phase ${nextPhase} which has no file — must render no <instructions> block`,
					);
					continue;
				}
				assert.ok(
					out.includes(phaseFirstLine(nextPhase)),
					`status=${status} (from phase ${currentPhase}) should route to phase ${nextPhase}; got:\n${out}`,
				);
			}
		}
	});

	it("158 regression: Discover → Deploy routes to phase 8, not phase 5", async () => {
		// The original bug: 158 was silently dropped by a VALID_STATUSES
		// whitelist, so the scanner returned the prior 155 and the model
		// got Discovery instructions again. Runs cycled in Discovery
		// until abandoned.
		const out = await renderFor([
			updateRow(1, 145),
			updateRow(2, 155),
			updateRow(3, 158),
		]);
		assert.ok(
			out.includes(phaseFirstLine(8)),
			"158 must route to phase 8 (Deploy)",
		);
		assert.ok(
			!out.includes(phaseFirstLine(5)),
			"must NOT re-emit Discovery instructions after 158",
		);
	});

	it("routes to a phase that has no file yet → no <instructions> block, no crash", async () => {
		// Future phase 9 (no file yet). Emitting 159 must route there
		// cleanly and produce no block, not fall back to Define (phase 4).
		if (phaseFileExists(9)) {
			return; // if someone later adds 109.md, rewrite this test
		}
		const out = await renderFor([updateRow(1, 159)]);
		assert.ok(
			!out.includes("<instructions>"),
			"phase 9 has no file → no <instructions> block",
		);
	});

	it("no-status rows are skipped (don't overwrite the last real status)", async () => {
		const out = await renderFor([
			updateRow(1, 145),
			{
				path: "log://turn_2/get/foo",
				attributes: JSON.stringify({ path: "foo", action: "get" }),
			},
		]);
		assert.ok(out.includes(phaseFirstLine(5)));
	});

	it("empty row set routes to Define (phase 4) — fresh-run default", async () => {
		const out = await renderFor([]);
		assert.ok(out.includes(phaseFirstLine(4)));
	});
});
