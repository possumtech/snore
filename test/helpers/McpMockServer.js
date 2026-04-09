import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
	const request = JSON.parse(line);
	const response = { jsonrpc: "2.0", id: request.id };

	if (request.method === "initialize") {
		response.result = { protocolVersion: "2024-11-05", capabilities: {} };
	} else if (request.method === "tools/list") {
		response.result = {
			tools: [
				{
					name: "echo",
					description: "Echo back",
					inputSchema: {
						type: "object",
						properties: { message: { type: "string" } },
					},
				},
			],
		};
	} else if (request.method === "tools/call") {
		response.result = {
			content: [
				{ type: "text", text: `Echo: ${request.params.arguments.message}` },
			],
		};
	} else if (request.method === "notifications/initialized") {
		return;
	}

	process.stdout.write(`${JSON.stringify(response)}\n`);
});
