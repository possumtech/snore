export const deterministic = true;

export default function slugify(text) {
	if (!text) return "";
	return encodeURIComponent(text).slice(0, 80);
}
