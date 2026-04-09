export default [
	["* get: URL or git repo to install from.", "The source of the MCP server."],
	[
		"* name: Local name for the server.",
		"Used to identify the server in subsequent calls.",
	],
	[
		"Example 1: Proposing installation of a GitHub MCP server",
		'<mcp get="https://github.com/modelcontextprotocol/servers/tree/main/src/github" name="github"/>',
	],
	[
		"Example 2: Listing available tools for an installed server",
		'<mcp name="github"/>',
	],
	[
		"* Installation requires user approval. The plugin will create a proposal (202) for you to accept.",
		"Aligns with the 'proposed' status paradigm.",
	],
];
