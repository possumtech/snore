import { WebSocketServer } from "ws";
import ClientConnection from "./ClientConnection.js";

export default class SocketServer {
	#db;
	#wss;
	#hooks;

	constructor(db, options) {
		this.#db = db;
		this.#hooks = options.hooks;
		this.#wss = new WebSocketServer(options);

		this.#wss.on("connection", (ws, req) => {
			if (process.env.RUMMY_DEBUG === "true") {
				console.log(`[SOCKET] New connection from ${req.socket.remoteAddress}`);
			}
			new ClientConnection(ws, this.#db, this.#hooks);
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

	close() {
		return new Promise((resolve) => {
			if (!this.#wss) return resolve();
			this.#wss.close(resolve);
		});
	}
}
