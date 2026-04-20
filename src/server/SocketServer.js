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

		this.#wss.on("connection", (ws, req) => {
			if (process.env.RUMMY_DEBUG === "true") {
				console.log(`[SOCKET] New connection from ${req.socket.remoteAddress}`);
			}
			const conn = new ClientConnection(ws, this.#db, this.#hooks);
			this.#connections.add(conn);
			// Remove from the tracking set only after the connection's
			// shutdown drain has fully settled — not on raw ws-close —
			// so server close() can still find and await an in-progress
			// shutdown kicked off by a client-initiated disconnect.
			ws.on("close", () => {
				conn.shutdown().finally(() => this.#connections.delete(conn));
			});
		});

		this.#wss.on("error", (_err) => {
			// Proxy to registry or handle locally
		});
	}

	address() {
		return this.#wss.address();
	}

	on(event, handler) {
		this.#wss.on(event, handler);
	}

	async close() {
		// Drain in-flight runs on each connection before closing the
		// socket — otherwise detached kickoff Promises keep the Node
		// event loop alive past server shutdown.
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
