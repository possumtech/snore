import { hedsearch } from "../hedberg.js";

export const deterministic = true;

export default function (pattern, string) {
	if (string === null) return 0;
	return hedsearch(pattern, string).found ? 1 : 0;
}
