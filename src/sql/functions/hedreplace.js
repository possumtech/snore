import { hedreplace } from "../../lib/hedberg/patterns.js";

export const deterministic = true;

export default function (pattern, replacement, string) {
	if (string === null) return null;
	return hedreplace(pattern, replacement, string);
}
