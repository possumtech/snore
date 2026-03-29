import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createHooks from "../../src/domain/hooks/Hooks.js";
import RpcRegistry from "../../src/infrastructure/rpc/RpcRegistry.js";
import SocketServer from "../../src/infrastructure/socket/SocketServer.js";
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

		// Register internal and core plugins so hooks like RepoMap work in tests
		const internalPluginsDir = join(__dirname, "../../src/application/plugins");
		const corePluginsDir = join(__dirname, "../../src/plugins");
		await registerPlugins([internalPluginsDir, corePluginsDir], hooks);

		// Prefetch OpenRouter catalog so first init doesn't timeout
		if (process.env.OPENROUTER_API_KEY) {
			try {
				const { default: OpenRouterClient } = await import(
					"../../src/infrastructure/llm/OpenRouterClient.js"
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
