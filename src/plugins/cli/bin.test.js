import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

function run(args = []) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			env: { ...process.env, RUMMY_PROMPT: "", RUMMY_MODEL: "" },
		});
		const chunks = [];
		child.stderr.on("data", (d) => chunks.push(d));
		child.on("close", (code) => {
			resolve({ code, stderr: Buffer.concat(chunks).toString() });
		});
		// 2s safety: if the process hangs (server boot path), kill it.
		setTimeout(() => child.kill("SIGKILL"), 2000).unref();
	});
}

describe("rummy-cli bin: argv parsing", () => {
	it("rejects lowercase env-shape flags with exit 2 + descriptive stderr", async () => {
		const { code, stderr } = await run(["--lower=value"]);
		assert.equal(code, 2);
		assert.match(stderr, /unknown arg/);
		assert.match(stderr, /env-var-shape/);
	});

	it("rejects bare positional arg (non-flag) with exit 2", async () => {
		const { code, stderr } = await run(["positional"]);
		assert.equal(code, 2);
		assert.match(stderr, /unknown arg/);
	});

	it("accepts well-formed flags (smoke: would not exit at parse stage)", async () => {
		// We can't fully boot service.js inside a unit test, but we can confirm
		// well-formed args don't trigger the parse-error exit-2 path.
		const { code } = await run(["--FOO=bar"]);
		assert.notEqual(code, 2);
	});
});
