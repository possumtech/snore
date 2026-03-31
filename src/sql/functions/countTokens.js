import { countTokens } from "../../agent/tokens.js";

export const deterministic = true;

export default function (text) {
	return text ? countTokens(text) : 0;
}
