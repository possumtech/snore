export const deterministic = true;

export default function (scheme, state, turn) {
	if (state === "proposed") return null;
	if (scheme === null && turn > 0 && state !== "symbols") return "full";
	if (scheme === null && state === "symbols" && turn > 0) return "summary";
	if (scheme === null && turn === 0) return "index";
	if (scheme === "known" && turn > 0) return "full";
	if (scheme === "known" && turn === 0) return "index";
	if (scheme === "unknown") return "full";
	if (scheme === "user" || scheme === "prompt") return "full";
	if (scheme === "http" || scheme === "https")
		return turn > 0 ? "full" : "index";
	if (
		["system", "reasoning", "content", "inject", "keys", "search"].includes(scheme)
	)
		return null;
	return "full";
}
