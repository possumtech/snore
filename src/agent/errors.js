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
