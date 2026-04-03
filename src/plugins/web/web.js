import WebFetcher from "./WebFetcher.js";

const SEARCH_DOCS = `## <search>[query]</search> - Search the web
Example: <search>node.js streams backpressure</search>
Example: <search results="5">SQLite WAL mode</search> (limit results)
* Optional \`results\` attribute limits the number of results (default: 12)
* Results appear in context next turn.
* Use \`<read>\` on a URL from results to fetch full content as markdown.`;

const FETCH_DOCS = `## <read>[url]</read> - Fetch a web page
Example: <read>https://docs.example.com/api</read>
* Content is extracted, cleaned, and stored as markdown.`;

export default class WebPlugin {
	static register(hooks) {
		hooks.tools.register("search", {
			modes: new Set(["ask", "act"]),
			category: "ask",
			docs: SEARCH_DOCS,
			project: (entry) => entry.body,
		});

		hooks.tools.onProject("http", (entry) => entry.body);
		hooks.tools.onProject("https", (entry) => entry.body);

		let fetcher = null;

		const getFetcher = () => {
			fetcher ??= new WebFetcher();
			return fetcher;
		};

		// Handle search:// entries
		hooks.tools.onHandle("search", async (entry, rummy) => {
			const attrs = entry.attributes || {};
			const query = attrs.path || entry.body;
			if (!query) return;

			const limit = attrs.results || 12;
			const results = await getFetcher().search(query, { limit });

			const urls = [];
			for (const r of results) {
				const url = WebFetcher.cleanUrl(r.url);
				urls.push(url);
				await rummy.write({
					path: url,
					body: `${r.title}\n${r.snippet}`,
					state: "summary",
					attributes: { query, engine: r.engine },
				});
			}

			const listing = urls.join("\n");
			await rummy.entries.upsert(
				rummy.runId,
				rummy.sequence,
				entry.resultPath,
				`${results.length} results for "${query}"\n${listing}`,
				"info",
			);
		});

		// Handle read:// entries with http(s) URLs — priority 5 (before core read at 10)
		hooks.tools.onHandle(
			"read",
			async (entry, rummy) => {
				const attrs = entry.attributes || {};
				const target = attrs.path;
				if (!target || !/^https?:\/\//.test(target)) return;

				const { entries: store, sequence: turn, runId } = rummy;
				const existing = await store.getBody(runId, target);
				if (existing !== null) return;

				const clean = WebFetcher.cleanUrl(target);
				const fetched = await getFetcher().fetch(clean);
				if (fetched.error) {
					console.warn(`[RUMMY] Fetch failed: ${clean} — ${fetched.error}`);
					return;
				}

				const header = fetched.title ? `# ${fetched.title}\n\n` : "";
				await store.upsert(
					runId,
					turn,
					clean,
					header + (fetched.content || ""),
					"full",
					{
						attributes: {
							title: fetched.title,
							excerpt: fetched.excerpt,
							byline: fetched.byline,
							siteName: fetched.siteName,
						},
					},
				);
			},
			5,
		);

		// Amend system prompt with web tool docs
		hooks.onTurn(async (rummy) => {
			const { entries: store, runId } = rummy;
			const attrs = await store.getAttributes(runId, "system://prompt");
			if (!attrs) return;
			const amendments = attrs.amendments || [];
			const webDocs = `${SEARCH_DOCS}\n\n${FETCH_DOCS}`;
			if (amendments.some((a) => a.includes("search"))) return;
			amendments.push(webDocs);
			await store.upsert(
				runId,
				rummy.sequence,
				"system://prompt",
				await store.getBody(runId, "system://prompt"),
				"info",
				{ attributes: { ...attrs, amendments } },
			);
		}, 15);
	}
}
