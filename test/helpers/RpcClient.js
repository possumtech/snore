import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

export default class RpcClient extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.ws = null;
		this.id = 0;
		this.pending = new Map();
	}

	async connect() {
		this.ws = new WebSocket(this.url);
		return new Promise((resolve, reject) => {
			this.ws.on("open", resolve);
			this.ws.on("error", reject);
			this.ws.on("message", (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.method) {
					this.emit(msg.method, msg.params);
				} else if (msg.id !== undefined) {
					const p = this.pending.get(msg.id);
					if (p) {
						this.pending.delete(msg.id);
						if (msg.error) p.reject(new Error(msg.error.message));
						else p.resolve(msg.result);
					}
				}
			});
		});
	}

	async call(method, params = {}) {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
		});
	}

	close() {
		this.ws.close();
	}
}
