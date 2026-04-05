import { hedmatch } from "../../plugins/hedberg/patterns.js";

export const deterministic = true;

export default function (pattern, string) {
	if (string === null) return 0;
	return hedmatch(pattern, string) ? 1 : 0;
}
