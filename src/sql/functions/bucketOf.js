export const deterministic = true;

export default function (scheme, state, turn) {
	if (state === "ignore" || state === "proposed") return null;
	if (scheme === null && turn > 0 && state !== "symbols") return "file";
	if (scheme === null && state === "symbols" && turn > 0) return "file:symbols";
	if (scheme === null && turn === 0) return "file:path";
	if (scheme === "known" && turn > 0) return "known";
	if (scheme === "known" && turn === 0) return "stored";
	if (scheme === "unknown") return "unknown";
	if (scheme === "prompt") return "prompt";
	if (scheme === "http" || scheme === "https") return turn > 0 ? "file" : "file:path";
	if (["system", "user", "reasoning", "inject", "keys", "search"].includes(scheme)) return null;
	return "result";
}
