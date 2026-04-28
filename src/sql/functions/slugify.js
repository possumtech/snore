export const deterministic = true;

// commas→/, spaces→_, encode-per-segment so / survives as separator.
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
