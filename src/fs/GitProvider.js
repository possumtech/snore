import { execSync } from "node:child_process";

export default class GitProvider {
	static async detectRoot(path) {
		try {
			return execSync("git rev-parse --show-toplevel", {
				cwd: path,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {
			return null;
		}
	}

	static async getTrackedFiles(root) {
		try {
			const output = execSync("git ls-files", {
				cwd: root,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			return new Set(output ? output.split("\n") : []);
		} catch {
			return new Set();
		}
	}

	static async isIgnored(root, path) {
		try {
			execSync(`git check-ignore -q "${path}"`, {
				cwd: root,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return true;
		} catch {
			return false;
		}
	}

	static async getHeadHash(root) {
		try {
			return execSync("git rev-parse HEAD", {
				cwd: root,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {
			return null;
		}
	}
}
