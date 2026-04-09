import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export default class McpServerManager {
	#servers = new Map();

	async spawn(name, command, args = [], env = {}) {
		if (this.#servers.has(name)) return this.#servers.get(name);

		const child = spawn(command, args, {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "inherit"],
		});

		const rl = createInterface({ input: child.stdout });
		const pending = new Map();
		let nextId = 1;

		rl.on("line", (line) => {
			try {
				const response = JSON.parse(line);
				if (response.id && pending.has(response.id)) {
					const { resolve, reject } = pending.get(response.id);
					pending.delete(response.id);
					if (response.error) reject(new Error(response.error.message));
					else resolve(response.result);
				}
			} catch (err) {
				console.error(
					`[MCP] Failed to parse line from ${name}: ${err.message}`,
				);
			}
		});

		const call = (method, params = {}) => {
			return new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, { resolve, reject });
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});
		};

		const server = { child, call, rl };
		this.#servers.set(name, server);

		// Initialize MCP handshake
		await call("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "rummy-mcp", version: "0.1.0" },
		});
		await call("notifications/initialized", {});

		return server;
	}

	async listTools(name) {
		const server = this.#servers.get(name);
		if (!server) throw new Error(`Server ${name} not running`);
		const result = await server.call("tools/list");
		return result.tools;
	}

	async callTool(name, toolName, params) {
		const server = this.#servers.get(name);
		if (!server) throw new Error(`Server ${name} not running`);
		return await server.call("tools/call", {
			name: toolName,
			arguments: params,
		});
	}

	stop(name) {
		const server = this.#servers.get(name);
		if (server) {
			server.child.kill();
			this.#servers.delete(name);
		}
	}

	stopAll() {
		for (const name of this.#servers.keys()) {
			this.stop(name);
		}
	}
}
