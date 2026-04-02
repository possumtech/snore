import WebFetcher from "./WebFetcher.js";

const TOOL_DOCS = `# Web Tools

## <search>[query]</search> - Search the web

* Example: <search>node.js streams backpressure</search>
* Example: <search>SQLite WAL mode performance</search>
* Results appear in context next turn. Use \`<read>\` to fetch full content.

## URL Fetch

URLs are fetched and converted to markdown when read:

* Example: <read>https://docs.example.com/api</read>
* Content is extracted, cleaned, and stored as markdown.`;

export default class WebPlugin {
	static register(hooks) {
		// Register search as a plugin tool
		hooks.tools.register("search", {
			modes: new Set(["ask", "act"]),
			category: "ask",
		});

		let fetcher = null;

		const getFetcher = () => {
			fetcher ??= new WebFetcher();
			return fetcher;
		};

		// Inject tool documentation into system prompt
		hooks.prompt.tools.addFilter(async (sections) => {
			sections.push(TOOL_DOCS);
			return sections;
		});

		// Handle search commands
		hooks.action.search.addFilter(async (_result, { query }) => {
			const results = await getFetcher().search(query);
			const listing = results
				.map(
					(r) => `${r.title}\n  ${WebFetcher.cleanUrl(r.url)}\n  ${r.snippet}`,
				)
				.join("\n\n");
			return {
				value: `${results.length} results for "${query}"\n\n${listing}`,
				meta: { query, count: results.length, results },
			};
		});

		// Handle URL fetch for read commands
		hooks.action.fetch.addFilter(async (_result, { url }) => {
			const clean = WebFetcher.cleanUrl(url);
			const fetched = await getFetcher().fetch(clean);
			if (fetched.error) {
				console.warn(`[RUMMY] Fetch failed: ${clean} — ${fetched.error}`);
				return null;
			}
			const header = fetched.title ? `# ${fetched.title}\n\n` : "";
			return {
				url: clean,
				value: header + (fetched.content || ""),
				meta: {
					title: fetched.title,
					excerpt: fetched.excerpt,
					byline: fetched.byline,
					siteName: fetched.siteName,
				},
			};
		});
	}
}
