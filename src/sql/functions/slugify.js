import encodeSegment from "../../agent/pathEncode.js";

export const deterministic = true;

// commas→/, then encode-per-segment so / survives as separator.
// encodeSegment handles spaces→_ + URL-encode (single rule, used everywhere).
export default function slugify(text) {
	if (!text) return "";
	return text
		.slice(0, 80)
		.replace(/,/g, "/")
		.split("/")
		.filter(Boolean)
		.map(encodeSegment)
		.join("/");
}
