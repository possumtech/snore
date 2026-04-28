// (state, outcome) → HTTP status for model-facing tags; outcome's 3-digit prefix wins.
export function stateToStatus(state, outcome = null) {
	if (outcome) {
		const match = /(\d{3})/.exec(outcome);
		if (match) return Number(match[1]);
	}
	switch (state) {
		case "resolved":
			return 200;
		case "proposed":
			return 202;
		case "streaming":
			return 102;
		case "cancelled":
			return 499;
		case "failed":
			return 500;
		default:
			throw new Error(`stateToStatus: unknown state "${state}"`);
	}
}
