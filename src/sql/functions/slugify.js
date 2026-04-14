export const deterministic = true;

// Build URI paths the model can round-trip:
//   "history,mongol,khan"   → "history/mongol/khan"   (commas become path separators)
//   "contents of Document 1" → "contents_of_Document_1" (spaces become underscores)
// Slice on decoded text, then split-encode-join per segment so / survives as
// a separator while anything URL-unsafe inside a segment gets escaped.
export default function slugify(text) {
	if (!text) return "";
	return text
		.slice(0, 80)
		.replace(/,/g, "/")
		.replace(/ /g, "_")
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
}
