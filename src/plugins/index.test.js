import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { registerPlugins } from "./index.js";

describe("Plugin Loader", () => {
	const testDir = join(process.cwd(), "test_loader_err");

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		// Create a file where we expect a directory
		await fs.writeFile(join(testDir, "not_a_dir.js"), "content");
	});

	after(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should handle non-existent directories gracefully", async () => {
		await assert.doesNotReject(registerPlugins(["/non/existent/dir"]));
	});

	it("should log errors in debug mode when scanning a non-directory", async () => {
		process.env.RUMMY_DEBUG = "true";
		const errorMock = mock.method(console, "error", () => {});

		// Attempt to scan a file as a directory
		await registerPlugins([join(testDir, "not_a_dir.js")]);

		assert.ok(errorMock.mock.callCount() >= 1);
		assert.ok(
			errorMock.mock.calls[0].arguments[0].includes(
				"Cannot scan plugin directory",
			),
		);

		delete process.env.RUMMY_DEBUG;
		errorMock.mock.restore();
	});
});
