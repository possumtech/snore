export const deterministic = true;

export default function (scheme, state) {
	if (scheme !== null && scheme !== "known" && scheme !== "unknown") return 0;
	if (scheme === null && state !== "symbols") return 1;
	if (scheme === "known") return 2;
	if (scheme === null && state === "symbols") return 3;
	return 4;
}
