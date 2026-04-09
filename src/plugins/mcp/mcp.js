import McpRegistry from "./McpRegistry.js";
import McpServerManager from "./McpServerManager.js";
import docs from "./mcpDoc.js";

export default class Mcp {
	#core;
	#registry;
	#manager;

	constructor(core) {
		this.#core = core;
		this.#registry = new McpRegistry();
		this.#manager = new McpServerManager();

		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));

		core.filter("instructions.toolDocs", this.filterDocs.bind(this));

		// Check for resolved installations at turn start
		core.on("turn.started", this.onTurnStarted.bind(this));

		// On startup, initialize installed servers and register their tools
		this.initServers().catch((err) =>
			console.error(`[MCP] Failed to init servers: ${err.message}`),
		);
	}

	async initServers() {
		for (const [name, config] of this.#registry.all()) {
			await this.registerServerTools(name, config);
		}
	}

	async onTurnStarted({ rummy }) {
		const entries = await rummy.entries.getEntriesByPattern(
			rummy.runId,
			"mcp://*",
			null,
		);
		for (const entry of entries) {
			const attrs = entry.attributes ? JSON.parse(entry.attributes) : {};
			if (
				entry.status === 200 &&
				attrs.get &&
				!this.#registry.get(attrs.name)
			) {
				// User accepted the installation proposal
				await this.installServer(attrs.name, attrs.get);
			}
		}
	}

	async installServer(name, url) {
		// Mock installation logic: just update registry with dummy command for the URL
		// For a real plugin, this might be `git clone` then `npm install`
		const config = {
			command: "node",
			args: [url],
			env: {},
		};
		this.#registry.set(name, config);
		await this.registerServerTools(name, config);
	}

	async registerServerTools(name, config) {
		try {
			const _server = await this.#manager.spawn(
				name,
				config.command,
				config.args,
				config.env,
			);
			const tools = await this.#manager.listTools(name);

			for (const tool of tools) {
				const schemeName = `${name}_${tool.name}`.replace(/-/g, "_");
				this.#core.hooks.tools.ensureTool(schemeName);
				this.#core.hooks.tools.onHandle(schemeName, async (entry, rummy) => {
					const result = await this.#manager.callTool(
						name,
						tool.name,
						entry.attributes,
					);
					const body = JSON.stringify(result.content, null, 2);
					await rummy.entries.upsert(
						rummy.runId,
						rummy.sequence,
						entry.resultPath,
						body,
						200,
						{
							attributes: entry.attributes,
							loopId: rummy.loopId,
						},
					);
				});

				// Register scheme in DB so it's visible to the model
				if (this.#core.db) {
					await this.#core.db.upsert_scheme.run({
						name: schemeName,
						model_visible: 1,
						category: "logging",
					});
				}
			}
		} catch (err) {
			console.warn(
				`[MCP] Failed to register tools for ${name}: ${err.message}`,
			);
		}
	}

	async filterDocs(docsMap) {
		docsMap.mcp = docs;
		// Add docs for all registered MCP tools
		for (const [name, _config] of this.#registry.all()) {
			try {
				const tools = await this.#manager.listTools(name);
				for (const tool of tools) {
					const schemeName = `${name}_${tool.name}`.replace(/-/g, "_");
					docsMap[schemeName] =
						`### ${schemeName}\n${tool.description}\n\nAttributes:\n${JSON.stringify(tool.inputSchema.properties, null, 2)}`;
				}
			} catch (_err) {
				// Server might not be running yet
			}
		}
		return docsMap;
	}

	async handler(entry, rummy) {
		const { get, name } = entry.attributes;
		const { entries: store, sequence: turn, runId, loopId } = rummy;

		if (get) {
			// Installation proposal
			const resultPath = `mcp://${name}`;
			const body = `Proposing installation of MCP server "${name}" from ${get}.`;
			await store.upsert(runId, turn, resultPath, body, 202, {
				attributes: entry.attributes,
				loopId,
			});
			return;
		}

		const config = this.#registry.get(name);
		if (!config) {
			await store.upsert(
				runId,
				turn,
				entry.resultPath,
				`Server ${name} not installed.`,
				404,
				{ loopId },
			);
			return;
		}

		const tools = await this.#manager.listTools(name);
		await store.upsert(
			runId,
			turn,
			entry.resultPath,
			JSON.stringify(tools, null, 2),
			200,
			{ loopId },
		);
	}

	full(entry) {
		return `# mcp ${entry.attributes.name || ""}\n${entry.body}`;
	}

	summary(entry) {
		return entry.attributes.name || "";
	}
}
