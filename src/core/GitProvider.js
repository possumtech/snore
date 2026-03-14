import git from "isomorphic-git";
import fs from "node:fs";

export default class GitProvider {
	/**
	 * Detects the root of the git repository.
	 * @param {string} path - The path to start detection from.
	 * @returns {Promise<string|null>} - The absolute path to the root or null.
	 */
	static async detectRoot(path) {
		try {
			return await git.findRoot({ fs, filepath: path });
		} catch {
			return null;
		}
	}

	/**
	 * Lists all tracked files in the repository.
	 * @param {string} root - The absolute path to the repository root.
	 * @returns {Promise<Set<string>>} - A set of tracked relative file paths.
	 */
	static async getTrackedFiles(root) {
		try {
			const files = await git.listFiles({ fs, dir: root });
			return new Set(files);
		} catch {
			return new Set();
		}
	}

	/**
	 * Checks if a file is ignored by git.
	 * @param {string} root - The repository root.
	 * @param {string} path - The relative file path to check.
	 * @returns {Promise<boolean>} - True if ignored.
	 */
	static async isIgnored(root, path) {
		try {
			return await git.isIgnored({ fs, dir: root, filepath: path });
		} catch {
			return false;
		}
	}

	/**
	 * Gets the current HEAD hash.
	 * @param {string} root - The repository root.
	 * @returns {Promise<string|null>} - The hash or null.
	 */
	static async getHeadHash(root) {
		try {
			return await git.resolveRef({ fs, dir: root, ref: "HEAD" });
		} catch {
			return null;
		}
	}
}
