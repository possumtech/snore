// Engine plugin — placeholder for future context management plugins.
// Currently empty. The janitor and relevance engine will register
// onTurn hooks here to manage context budget before materialization.
//
// Materialization itself (turn_context population) is core behavior
// in TurnExecutor, not a plugin concern.

export default class Engine {
	static register(_hooks) {}
}
