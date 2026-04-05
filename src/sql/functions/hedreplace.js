import { hedreplace } from "../hedberg.js";

export const deterministic = true;

export default function (pattern, replacement, string) {
	if (string === null) return null;
	return hedreplace(pattern, replacement, string);
}
