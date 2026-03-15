export default class TestE2EPlugin {
	static register(hooks) {
		hooks.addAction("TURN_SYSTEM_PROMPT_BEFORE", async (slot) => {
			// Identity Protocol injection
			slot.add("IDENTITY_KEY: ALBATROSS-99", 1);
		});
	}
}
