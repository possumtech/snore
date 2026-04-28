import { WebSocketServer } from "ws";
import ClientConnection from "./ClientConnection.js";

export default class SocketServer {
	#db;
	#wss;
	#hooks;
	#connections = new Set();

	constructor(db, options) {
		this.#db = db;
		this.#hooks = options.hooks;
		this.#wss = new WebSocketServer(options);

		this.#wss.on("connection", (ws, _req) => {
			const conn = new ClientConnection(ws, this.#db, this.#hooks);
			this.#connections.add(conn);
			// Delete after drain settles so server.close() can await client-initiated shutdowns.
			ws.on("close", () => {
				conn.shutdown().finally(() => this.#connections.delete(conn));
			});
		});

		this.#wss.on("error", (_err) => {});
	}

	address() {
		return this.#wss.address();
	}

	on(event, handler) {
		this.#wss.on(event, handler);
	}

	async close() {
		// Drain in-flight runs first; otherwise detached kickoffs pin the event loop.
		const shutdowns = [];
		for (const conn of this.#connections) {
			shutdowns.push(conn.shutdown().catch(() => {}));
		}
		await Promise.all(shutdowns);
		this.#connections.clear();

		await new Promise((resolve) => {
			if (!this.#wss) return resolve();
			this.#wss.close(resolve);
		});
	}
}
