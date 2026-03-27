# PLAN

## Remaining

(empty)

## Done

- [x] **Wire `repo_map_references` population** — `RepoMap.updateIndex()` now runs a second pass after symbol extraction: scans each re-indexed file's content for whole-word matches of symbol names from other files, filtered by min length 3. ARCHITECTURE.md §2.4.1 documents the algorithm. 4 integration tests cover: basic population, self-exclusion, short-name filtering, and heat calculation.
- [x] **State table nag warnings** — warnings now include concrete templates of correct behavior. Stray output outside `<todo>`, `<known>`, `<unknown>`, `<edit>` tags generates a warning. Rule 6 fallback allows graceful completion after 3 nag retries.
- [x] **Structured feedback delivery** — `Turn.toJson()` exposes `feedback` array with `{ level, target, message }` objects.


## Blue Skies

1. Any functionality that can rely on our hooks/filters/plugin functionality to be segregated out into a "core plugin" should be segregated into a core plugin.

2. I suspect that we're suffering from a lack of modularity, separation of concerns, single responsibility, and organization of files and folders to reflect our modularized architecture goals, resulting in context overload for both of us.

3. I suspect that our "state machine" management remains kind of hacky and would like it to be as table-driven and deterministic as possible, applying well-defined rules in a well-defined order that is well-documented, rather than a spaghetti of imperative decisions. Ideally, I would like the rest of the codebase to be at a modularity and maturity to where our key focus can be in perfecting the relationship and rules in the agent/mode interactions.
