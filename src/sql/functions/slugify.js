import encodeSegment from "../../agent/pathEncode.js";

export const deterministic = true;

// scheme separator `://` → `___` (three chars replaced, three underscores —
// visually distinctive, nobody writes triple-underscore in real paths or
// identifiers, so a `___` in a slug unambiguously signals "this was a
// scheme separator at write-time"). Round-trippable if a consumer ever
// wants to decode. Done BEFORE comma→/ and split so a path like
// `unknown://geography/x` slugs as `unknown___geography/x` instead of
// dropping a slash via `filter(Boolean)`.
//
// commas→/, then encode-per-segment so / survives as separator. Drop `.`
// and `..` segments — they're shell path-navigation noise that has no
// addressing value AND breaks picomatch globs (literal `.` is treated
// as a directory marker that `**` won't match across), so a command
// like `./executable --help` previously slugged to `./executable_--help`
// and made `sh://turn_N/**` queries miss it.
// encodeSegment handles spaces→_ + URL-encode (single rule, used everywhere).
export default function slugify(text) {
	if (!text) return "";
	return text
		.slice(0, 80)
		.replace(/:\/\//g, "___")
		.replace(/,/g, "/")
		.split("/")
		.filter((seg) => seg && seg !== "." && seg !== "..")
		.map(encodeSegment)
		.join("/");
}
