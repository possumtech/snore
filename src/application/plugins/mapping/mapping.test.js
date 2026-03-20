import test from "node:test";
import createHooks from "../../../domain/hooks/Hooks.js";
import RepoMapPlugin from "./mapping.js";

test("RepoMapPlugin", async (t) => {
	await t.test("register should add hooks", () => {
		const hooks = createHooks();
		RepoMapPlugin.register(hooks);
	});

	await t.test("onTurn should execute and append files", async () => {
		const hooks = createHooks();
		RepoMapPlugin.register(hooks);

		const mockRummy = {
			project: { id: "p1", path: "/tmp" },
			activeFiles: [],
			db: {
				get_project_repo_map: {
					all: async () => [
						{
							path: "a.js",
							visibility: "mappable",
							name: "f",
							type: "func",
							line: 1,
						},
					],
				},
				get_file_type_handlers: {
					all: async () => [{ extension: "js", extractor: "hd" }],
				},
				get_ranked_repo_map: {
					all: async () => [
						{ path: "a.js", visibility: "mappable", heat: 1, is_active: 0 },
					],
				},
				upsert_repo_map_file: {
					get: async () => ({ id: 1 }),
					run: async () => ({ id: 1 }),
				},
				clear_repo_map_file_data: { run: async () => {} },
				insert_repo_map_tag: { run: async () => {} },
				get_file_references: { all: async () => [] },
				get_project_references: { all: async () => [] },
			},
			tag: (name, attrs) => ({ name, attrs, appendChild: () => {} }),
			contextEl: { appendChild: () => {} },
		};

		await hooks.processTurn(mockRummy);
	});

	await t.test("init completed should trigger updateIndex", async () => {
		const hooks = createHooks();
		RepoMapPlugin.register(hooks);

		await hooks.project.init.completed.emit({
			projectId: "p1",
			projectPath: "/tmp",
			db: {
				get_project_repo_map: { all: async () => [] },
				get_file_type_handlers: {
					all: async () => [{ extension: "js", extractor: "hd" }],
				},
				upsert_repo_map_file: {
					get: async () => ({ id: 1 }),
					run: async () => ({ id: 1 }),
				},
				clear_repo_map_file_data: { run: async () => {} },
				insert_repo_map_tag: { run: async () => {} },
			},
		});
	});
});
