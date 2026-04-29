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
		// Best-effort: a single connection failing to shut down cleanly should not
		// prevent the others from closing, but the failure must be visible.
		const results = await Promise.allSettled(
			Array.from(this.#connections, (conn) => conn.shutdown()),
		);
		for (const r of results) {
			if (r.status === "rejected") {
				console.error(
					`[RUMMY] Connection shutdown failed: ${r.reason?.message ?? r.reason}`,
				);
			}
		}
		this.#connections.clear();

		await new Promise((resolve) => {
			if (!this.#wss) return resolve();
			this.#wss.close(resolve);
		});
	}
}
