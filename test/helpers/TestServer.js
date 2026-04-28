import SocketServer from "../../src/server/SocketServer.js";

export default class TestServer {
	constructor(server, url, hooks) {
		this.server = server;
		this.url = url;
		this.hooks = hooks;
	}

	/**
	 * Start a SocketServer wired to an existing TestDb's hooks + plugins.
	 * One plugin graph per test, shared between DB-direct and server paths.
	 */
	static async start(tdb, options = {}) {
		// Bootstrap models from env vars (same as service.js).
		for (const key of Object.keys(process.env)) {
			if (!key.startsWith("RUMMY_MODEL_") || key === "RUMMY_TEST_MODEL")
				continue;
			const alias = key.replace("RUMMY_MODEL_", "");
			const contextEnv = process.env[`RUMMY_CONTEXT_${alias}`];
			const context_length = contextEnv
				? Number.parseInt(contextEnv, 10)
				: null;
			await tdb.db.upsert_model.get({
				alias,
				actual: process.env[key],
				context_length,
			});
		}

		const server = new SocketServer(tdb.db, { port: 0, hooks: tdb.hooks });
		const addr = server.address();
		const url = `ws://localhost:${addr.port}`;
		return new TestServer(server, url, tdb.hooks);
	}

	async stop() {
		await this.server.close();
	}
}
