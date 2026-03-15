import HookRegistry from "../core/HookRegistry.js";
import RepoMapPlugin from "./RepoMapPlugin.js";

export function registerCorePlugins() {
	const hooks = HookRegistry.instance;

	// Register the RepoMap logic as our first official internal plugin
	RepoMapPlugin.register(hooks);
}
