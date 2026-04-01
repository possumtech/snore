export const deterministic = true;

export default function slugify(text) {
	if (!text) return "";
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_\s]/g, "")
		.replace(/[\s_]+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 32);
}
