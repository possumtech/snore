// Outcomes that record a failure but don't strike — findings the model
// adapts to, not contract violations. `not_found` (model acted on an
// entry that doesn't exist) and `conflict` (SEARCH text didn't match
// current body) are recoverable: read the new state, try again. Hard
// outcomes (validation, permission, exit:N) DO strike. Shared between
// error.js's verdict accumulator (recordedFailed gate) and Entries'
// auto-failure hook (passes soft=true so error.log.emit skips turn
// errors increment when the outcome is soft).
export const SOFT_FAILURE_OUTCOMES = new Set(["not_found", "conflict"]);

// Writer tier excluded from scheme.writable_by; see SPEC writer_tiers.
export class PermissionError extends Error {
	constructor(scheme, writer, allowed) {
		// Paths without `://` have a null scheme. Report null verbatim
		// rather than substituting a plausible-sounding "file" — there is
		// no scheme called "file" and the error must reflect actual state.
		const schemeLabel = scheme === null ? "(none)" : scheme;
		super(
			`403: writer "${writer}" not permitted for scheme "${schemeLabel}" (allowed: ${allowed.join(", ")})`,
		);
		this.name = "PermissionError";
		this.scheme = scheme;
		this.writer = writer;
		this.allowed = [...allowed];
	}
}

// Body length exceeded the entries.body CHECK constraint (RUMMY_ENTRY_SIZE_MAX
// at create-time). Surfaced as a 413 strike. The cap value lives only in the
// schema — JS does not duplicate it, because the database persists across
// rummy invocations and the env var that built the schema may differ from
// the env var seen by the running instance. Reporting body size is enough
// for the model to adapt; operators can read the cap from the schema.
export class EntryOverflowError extends Error {
	constructor(path, size) {
		super(
			`413: entry "${path}" body ${size} bytes exceeds RUMMY_ENTRY_SIZE_MAX`,
		);
		this.name = "EntryOverflowError";
		this.path = path;
		this.size = size;
	}
}
