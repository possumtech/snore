import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
	readFileSync(join(__dirname, "../../lang/en.json"), "utf8"),
);

export default function msg(key, params = {}) {
	const template = catalog[key];
	if (!template) throw new Error(`Missing message key: ${key}`);
	return template.replace(/\{(\w+)\}/g, (_, name) => {
		if (name in params) return String(params[name]);
		return `{${name}}`;
	});
}
