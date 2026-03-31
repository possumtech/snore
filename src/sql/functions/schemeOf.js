export const deterministic = true;

export default function (path) {
	if (!path) return null;
	const idx = path.indexOf("://");
	return idx > 0 ? path.slice(0, idx) : null;
}
