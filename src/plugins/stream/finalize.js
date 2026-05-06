import Entries from "../../agent/Entries.js";
import { logPathToDataBase } from "../helpers.js";

// Single termination site for streaming entries. Both stream/completed
// (external producer signaling close) and yolo's local child-spawn
// close handler funnel through here so finalization shape stays
// identical: channel terminal states, log-entry body rewrite, and
// dormant-run wake all live in one place.
//
// terminalState: "resolved" (exit_code=0), "failed" (non-zero).
// Aborts/cancellations write their own state ("cancelled") through the
// stream/aborted and stream/cancel paths and do NOT call this helper —
// explicit cancellation should not summon a follow-up turn.
export default async function finalizeStream({
	db,
	entries,
	hooks,
	runRow,
	path,
	exitCode = 0,
	duration = null,
	wake = true,
}) {
	const rawBase = logPathToDataBase(path);
	if (!rawBase) {
		throw new Error(
			`path must be a log entry (log://turn_N/...); got: ${path}`,
		);
	}
	// The log entry path may arrive in its raw URL-encoded form (e.g.
	// `%20` for spaces) but the data-channel rows are stored under the
	// canonical form (`%20` → `_` via encodeSegment). Normalize the
	// derived dataBase so `${dataBase}_*` matches the stored channel
	// paths regardless of which form the caller passed in.
	const dataBase = Entries.normalizePath(rawBase);

	const runId = runRow.id;
	const terminalState = exitCode === 0 ? "resolved" : "failed";
	const terminalOutcome = exitCode === 0 ? null : `exit:${exitCode}`;

	const channels = await entries.getEntriesByPattern(
		runId,
		`${dataBase}_*`,
		null,
	);
	for (const ch of channels) {
		await entries.set({
			runId,
			path: ch.path,
			state: terminalState,
			body: ch.body,
			outcome: terminalOutcome,
		});
	}

	const logEntry = await entries.getAttributes(runId, path);
	let command = "";
	if (logEntry?.command) command = logEntry.command;
	else if (logEntry?.summary) command = logEntry.summary;
	const channelSummary = channels
		.map((c) => {
			const size = c.body ? `${c.tokens} tokens` : "empty";
			return `${c.path} (${size})`;
		})
		.join(", ");
	const dur = duration ? ` (${duration})` : "";
	const exitLabel = exitCode === 0 ? "exit=0" : `exit=${exitCode}`;
	const body = `ran '${command}', ${exitLabel}${dur}. Output: ${channelSummary}`;
	await entries.set({ runId, path, state: "resolved", body });

	if (!wake) return { channels: channels.length };

	// Dormancy: any pending (100) or active (102) loop on the run blocks
	// the wake — the active loop will see the new log entry on its next
	// turn assembly and the producer doesn't owe it a fresh prompt.
	const inflight = await db.get_pending_loops.all({ run_id: runId });
	if (inflight.length > 0) return { channels: channels.length, woke: false };

	// Mode for the wake loop: inherit from the latest completed loop on
	// the run. Fresh runs without a completed loop don't get woken (the
	// child closing before any loop terminated is a state we'd never
	// reach in practice).
	const latest = await db.get_latest_completed_loop.get({ run_id: runId });
	if (!latest) return { channels: channels.length, woke: false };

	await hooks.run.wake.emit({
		runAlias: runRow.alias,
		body: "Process complete",
		mode: latest.mode,
	});
	return { channels: channels.length, woke: true };
}
