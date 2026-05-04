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
				const nextPhase = status === 200 ? 7 : status % 10;
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

	it("forward chain: 145 → Discovery, 156 → Demotion, 167 → Deployment, 200 → Deployment", async () => {
		// The forward-progression chain through the four stages. Catches
		// any silent-drop regression in the routing scanner: dropping
		// any status would strand the loop in the prior phase regardless
		// of what the model emitted.
		const cases = [
			{ status: 145, nextPhase: 5 },
			{ status: 156, nextPhase: 6 },
			{ status: 167, nextPhase: 7 },
			{ status: 200, nextPhase: 7 },
		];
		for (const { status, nextPhase } of cases) {
			const out = await renderFor([updateRow(1, status)]);
			assert.ok(
				out.includes(phaseFirstLine(nextPhase)),
				`status=${status} must route to phase ${nextPhase}`,
			);
		}
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

describe("validateNavigation: FVSM advance gates (@fvsm_state_machine)", () => {
	// SPEC.md @fvsm_state_machine — the four-rule contract.
	function makeRummy({
		unknowns = 0,
		visibleUnknowns = 0,
		knowns = 0,
		currentStatus = null,
	}) {
		const updateRows = currentStatus
			? [
					{
						path: "log://turn_1/update/stub",
						state: "resolved",
						attributes: { status: currentStatus },
					},
				]
			: [];
		return {
			runId: 1,
			sequence: 2,
			entries: {
				getEntriesByPattern: async (_runId, pattern) => {
					if (pattern === "unknown://**")
						return Array.from({ length: unknowns }, (_, i) => ({
							path: `unknown://x${i}`,
							visibility: i < visibleUnknowns ? "visible" : "summarized",
						}));
					if (pattern === "known://**")
						return Array.from({ length: knowns }, (_, i) => ({
							path: `known://x${i}`,
						}));
					if (pattern === "log://*/update/**") return updateRows;
					if (pattern === "prompt://*") return [];
					return [];
				},
			},
		};
	}

	it("145 (Decomposition → Distillation): rejected with zero unknowns", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			145,
			makeRummy({ unknowns: 0 }),
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "YOU MUST identify unknowns in current mode");
	});

	it("145: passes with ≥1 unknown", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			145,
			makeRummy({ unknowns: 1 }),
		);
		assert.equal(result.ok, true);
	});

	it("156 (Distillation → Demotion): rejected with zero knowns", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			156,
			makeRummy({ knowns: 0, currentStatus: 145 }),
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "YOU MUST identify knowns in current mode");
	});

	it("156: passes with ≥1 known (regardless of unknowns; Demotion will police them)", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			156,
			makeRummy({
				unknowns: 3,
				visibleUnknowns: 3,
				knowns: 1,
				currentStatus: 145,
			}),
		);
		assert.equal(result.ok, true);
	});

	it("167 (Demotion → Delivery): rejected when any unknown remains visible", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			167,
			makeRummy({
				unknowns: 3,
				visibleUnknowns: 1,
				knowns: 2,
				currentStatus: 156,
			}),
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "YOU MUST demote all unknowns before Delivery");
	});

	it("167: passes when no unknown is visible (all summarized/archived)", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			167,
			makeRummy({
				unknowns: 3,
				visibleUnknowns: 0,
				knowns: 2,
				currentStatus: 156,
			}),
		);
		assert.equal(result.ok, true);
	});

	it("167: passes when no unknowns exist at all", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			167,
			makeRummy({ unknowns: 0, knowns: 2, currentStatus: 156 }),
		);
		assert.equal(result.ok, true);
	});

	it("200 (Delivery completion): rejected when phase ≠ 7", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			200,
			makeRummy({ knowns: 1, currentStatus: 145 }),
		);
		assert.equal(result.ok, false);
	});

	it("Illegal jump (e.g. 167 from phase 4) is rejected", async () => {
		const hooks = makeHooks();
		const result = await hooks.instructions.validateNavigation(
			167,
			makeRummy({}),
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "Illegal navigation attempt");
	});
});

describe("getCurrentPhase: reads only successful advances", () => {
	// Per SPEC.md @fvsm_state_machine, rejected advance attempts are
	// not written as phase-history entries (update.js emits error.log
	// only). getCurrentPhase therefore needs no failed-state filter —
	// every row in `log://*/update/**` is a successful advance.
	function makeRummyWithUpdates(updateRows) {
		return {
			runId: 1,
			sequence: 5,
			entries: {
				getEntriesByPattern: async (_runId, pattern) => {
					if (pattern === "log://*/update/**") return updateRows;
					return [];
				},
			},
		};
	}

	it("returns the phase of the most recent successful advance", async () => {
		const hooks = makeHooks();
		const phase = await hooks.instructions.getCurrentPhase(
			makeRummyWithUpdates([
				{
					path: "log://turn_1/update/stub",
					state: "resolved",
					attributes: { status: 145 },
				},
				{
					path: "log://turn_2/update/stub",
					state: "resolved",
					attributes: { status: 156 },
				},
			]),
		);
		assert.equal(phase, 6);
	});

	it("returns Decomposition (4) when no advances have happened", async () => {
		const hooks = makeHooks();
		const phase = await hooks.instructions.getCurrentPhase(
			makeRummyWithUpdates([]),
		);
		assert.equal(phase, 4);
	});
});
