/**
 * Typed errors for the agent/Entries layer. Callers catch by type,
 * not by regex.
 */

/**
 * Thrown when a writer tier isn't permitted to write to a scheme.
 * See SPEC writer_tiers: schemes declare writable_by = subset of
 * {system, plugin, client, model}. A write from an excluded tier
 * rejects with this error.
 */
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
