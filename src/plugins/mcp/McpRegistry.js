import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export default class McpRegistry {
	#path;
	#servers = new Map();

	constructor() {
		const rummyHome = process.env.RUMMY_HOME || join(homedir(), ".rummy");
		this.#path = join(rummyHome, "mcp.json");
		this.load();
	}

	load() {
		if (!existsSync(this.#path)) {
			this.#servers = new Map();
			return;
		}
		try {
			const data = JSON.parse(readFileSync(this.#path, "utf8"));
			this.#servers = new Map(Object.entries(data));
		} catch (err) {
			console.error(`[MCP] Failed to load registry: ${err.message}`);
			this.#servers = new Map();
		}
	}

	save() {
		try {
			const dir = dirname(this.#path);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const data = Object.fromEntries(this.#servers);
			writeFileSync(this.#path, JSON.stringify(data, null, 2));
		} catch (err) {
			console.error(`[MCP] Failed to save registry: ${err.message}`);
		}
	}

	get(name) {
		return this.#servers.get(name);
	}

	set(name, config) {
		this.#servers.set(name, config);
		this.save();
	}

	all() {
		return [...this.#servers.entries()];
	}

	remove(name) {
		this.#servers.delete(name);
		this.save();
	}
}
