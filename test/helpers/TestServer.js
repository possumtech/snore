import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import createHooks from "../../src/hooks/Hooks.js";
import { registerPlugins } from "../../src/plugins/index.js";
import RpcRegistry from "../../src/server/RpcRegistry.js";
import SocketServer from "../../src/server/SocketServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default class TestServer {
	constructor(server, url, hooks) {
		this.server = server;
		this.url = url;
		this.hooks = hooks;
	}

	static async start(db, options = {}) {
		// Set RUMMY_HOME before plugin registration so telemetry picks it up
		// and writes per-turn diagnostic files under {home}/turns/{run_alias}/
		if (options.home) {
			process.env.RUMMY_HOME = options.home;
		}

		const hooks = createHooks(false);
		hooks.rpc.registry = new RpcRegistry();

		const pluginsDir = join(__dirname, "../../src/plugins");
		await registerPlugins([pluginsDir], hooks);

		// Bootstrap models from env vars (same as service.js)
		for (const key of Object.keys(process.env)) {
			if (!key.startsWith("RUMMY_MODEL_") || key === "RUMMY_TEST_MODEL")
				continue;
			const alias = key.replace("RUMMY_MODEL_", "");
			const contextEnv = process.env[`RUMMY_CONTEXT_${alias}`];
			const context_length = contextEnv
				? Number.parseInt(contextEnv, 10)
				: null;
			await db.upsert_model.get({
				alias,
				actual: process.env[key],
				context_length,
			});
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
