# PLAN

## Remaining

- [ ] **E2E: Verify command resolution tests** — assertions updated to `level: target # message` format, prompts updated to reference "env tool" not `<env>` tag. Run `npm run test:e2e` and confirm the 3 command_resolution tests and 1 editor_diff_lifecycle command test pass.
- [ ] **E2E: Fix diff resolution tests** — 2 tests fail with "Model completed instead of proposing." Investigate prompt design — the model may not reliably produce edits. Redesign tests to be deterministic.
- [ ] **E2E: Option D prefill workflow** — Write a test proving: model lists read + edit → server executes read → continuation prefill has checked read → model continues with informed edit. Key files: `AgentLoop.js:#buildPrefill`, `ToolExtractor.js`, `ResponseParser.js:mergePrefill`.
- [ ] Multi-client notification isolation testing
- [ ] Database retention policies (turn_elements, pending_context, file_promotions cleanup)

## Blue Skies

1. Any functionality that can rely on our hooks/filters/plugin functionality to be segregated out into a "core plugin" should be segregated into a core plugin.

2. I suspect that we're suffering from a lack of modularity, separation of concerns, single responsibility, and organization of files and folders to reflect our modularized architecture goals, resulting in context overload for both of us.

3. I suspect that our "state machine" management remains kind of hacky and would like it to be as table-driven and deterministic as possible, applying well-defined rules in a well-defined order that is well-documented, rather than a spaghetti of imperative decisions. Ideally, I would like the rest of the codebase to be at a modularity and maturity to where our key focus can be in perfecting the relationship and rules in the agent/mode interactions.
