import { WebSocket } from "ws";

/**
 * AD-HOC TEST: example_paris.js
 */

// Load environment variables
try {
	process.loadEnvFile();
} catch {
	// No .env file found, relying on shell env
}

const PORT = process.env.PORT || 3000;

const ws = new WebSocket(`ws://localhost:${PORT}`);

ws.on("open", () => {
	console.log("--- SNORE Live Paris Test ---");
	console.log(`Connected to SNORE on port ${PORT}`);

	// 1. Initialize project
	console.log("\n1. Initializing Project...");
	ws.send(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "init",
			params: {
				projectPath: process.cwd(),
				projectName: "SNORE Ad-hoc Test",
				clientId: "manual-tester",
			},
			id: "init-req",
		}),
	);
});

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString());

	if (msg.error) {
		console.error("\nError Response:", JSON.stringify(msg.error, null, 2));
		process.exit(1);
	}

	if (msg.id === "init-req") {
		console.log("Project Initialized:", msg.result.projectId);

		// 2. Perform the 'ask' using the 'ccp' alias
		console.log("\n2. Asking 'ccp' (DeepSeek) the Paris question...");
		ws.send(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "ask",
				params: {
					model: "ccp",
					prompt:
						"What is the capital of France? Answer with exactly one word.",
				},
				id: "ask-req",
			}),
		);
	} else if (msg.id === "ask-req") {
		console.log("\n3. Final Response from Agent:");
		console.log("----------------------------");
		console.log(msg.result.response);
		console.log("----------------------------");
		console.log("Run ID:", msg.result.id);

		console.log("\nTest Complete. Closing.");
		ws.close();
	}
});

ws.on("error", (err) => {
	console.error("WebSocket Error:", err.message);
	console.log("Is SNORE running? (npm start)");
});
