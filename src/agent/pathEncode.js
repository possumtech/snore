// Single source of truth for path-segment encoding: spaces → _, then URL-encode.
// Used by slugify (for summary-derived slugs) and Entries (for normalize/dedup/logPath).
export default function encodeSegment(s) {
	return encodeURIComponent(String(s).replace(/ /g, "_"));
}
