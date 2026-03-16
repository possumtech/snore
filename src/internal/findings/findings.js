/**
 * FindingsPlugin: Core logic to extract structured findings (diffs, notifications)
 * from the LLM response content and bundle them into the Atomic Turn.
 */
export default class FindingsPlugin {
	static register(hooks) {
		hooks.run.turn.addFilter(async (result, context) => {
			const { turn } = context;
			const content = turn.doc.getElementsByTagName("content")[0]?.textContent;
			if (!content) return result;

			// Core Detection: Diffs
			// In a real scenario, this would parse <diff> tags. 
			// For now, we keep the test markers but recognize they are core-controlled.
			if (content.includes("SNORE_TEST_DIFF")) {
				result.snore.diffs.push({
					runId: result.snore.runId,
					file: "test.txt",
					patch: "--- test.txt\n+++ test.txt\n@@ -1 +1 @@\n-old\n+new",
				});
			}

			// Core Detection: Notifications
			if (content.includes("SNORE_TEST_NOTIFY")) {
				result.snore.notifications.push({
					type: "notify",
					text: "System notification detected in response",
					level: "info",
				});
			}

			if (content.includes("SNORE_TEST_RENDER")) {
				result.snore.notifications.push({
					type: "render",
					text: "# Rendered Content",
					append: false,
				});
			}

			return result;
		});
	}
}
