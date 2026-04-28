// Writer tier excluded from scheme.writable_by; see SPEC writer_tiers.
export class PermissionError extends Error {
	constructor(scheme, writer, allowed) {
		super(
			`403: writer "${writer}" not permitted for scheme "${scheme ?? "file"}" (allowed: ${allowed.join(", ")})`,
		);
		this.name = "PermissionError";
		this.scheme = scheme ?? "file";
		this.writer = writer;
		this.allowed = [...allowed];
	}
}
