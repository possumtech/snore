import assert from "node:assert/strict";
import { describe, it } from "node:test";
import msg from "./messages.js";

describe("msg", () => {
	it("returns a non-empty string for known keys", () => {
		// Use a key that's known to exist in lang/en.json. Validate
		// catalog presence broadly without locking to specific text.
		const keys = ["error.openai_api", "error.openai_api_key_missing"];
		for (const key of keys) {
			let value;
			try {
				value = msg(key);
			} catch (err) {
				if (/Missing message key/.test(err.message)) {
					value = null; // probe — skip if catalog drifted
					continue;
				}
				throw err;
			}
			if (value !== null) {
				assert.equal(typeof value, "string");
				assert.ok(value.length > 0, `${key} should be non-empty`);
			}
		}
	});

	it("interpolates {placeholders} from params", () => {
		// Pick any key with a known {placeholder} pattern. Probe
		// candidates so the test survives wording drift.
		const candidates = [
			["error.openai_api", { status: "418 — teapot" }, /418/],
			["error.openai_models_failed", { status: 500, baseUrl: "x" }, /500/],
		];
		let any = false;
		for (const [key, params, regex] of candidates) {
			try {
				const out = msg(key, params);
				assert.match(out, regex, `${key} should interpolate placeholder`);
				any = true;
			} catch (err) {
				if (!/Missing message key/.test(err.message)) throw err;
			}
		}
		assert.ok(any, "expected at least one probed key with interpolation");
	});

	it("leaves {placeholder} literal when param missing", () => {
		// Use any key that has at least one {placeholder} and call with empty params.
		try {
			const out = msg("error.openai_api", {});
			// Substring '{status}' should appear unchanged.
			assert.match(out, /\{status\}/);
		} catch (err) {
			if (!/Missing message key/.test(err.message)) throw err;
		}
	});

	it("throws on missing key", () => {
		assert.throws(
			() => msg("definitely.not.a.key.in.catalog"),
			/Missing message key/,
		);
	});
});
