import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createHooks from "../../src/hooks/Hooks.js";
import RpcRegistry from "../../src/server/RpcRegistry.js";
import SocketServer from "../../src/server/SocketServer.js";
import { registerPlugins } from "../../src/plugins/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default class TestServer {
	constructor(server, url, hooks) {
		this.server = server;
		this.url = url;
		this.hooks = hooks;
	}

	static async start(db) {
		const hooks = createHooks(false);
		hooks.rpc.registry = new RpcRegistry();

		const pluginsDir = join(__dirname, "../../src/plugins");
		await registerPlugins([pluginsDir], hooks);

		if (process.env.OPENROUTER_API_KEY) {
			try {
				const { default: OpenRouterClient } = await import(
					"../../src/llm/OpenRouterClient.js"
				);
				const or = new OpenRouterClient(
					process.env.OPENROUTER_API_KEY,
					{},
					null,
					db,
				);
				await or.refreshCatalog();
			} catch {}
		}

		const server = new SocketServer(db, { port: 0, hooks });
		const addr = server.address();
		const url = `ws://localhost:${addr.port}`;
		return new TestServer(server, url, hooks);
	}

	async stop() {
		await this.server.close();
	}
}
