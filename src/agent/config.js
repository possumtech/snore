// Validates required RUMMY_* env at module load; defaults in .env.example.

// Parsers signal "invalid" by returning Number.NaN — the validation loop
// collects all such failures into `missing[]` and reports them in one
// consolidated error. Throwing from a parser would short-circuit the
// loop and force operators to fix issues serially across restarts.
const parseBool = (v) => {
	if (v === "0" || v === "false") return false;
	if (v === "1" || v === "true") return true;
	return Number.NaN;
};

const REQUIRED = {
	BUDGET_CEILING: { env: "RUMMY_BUDGET_CEILING", parse: Number },
	LLM_DEADLINE: { env: "RUMMY_LLM_DEADLINE", parse: Number },
	LLM_MAX_BACKOFF: { env: "RUMMY_LLM_MAX_BACKOFF", parse: Number },
	FETCH_TIMEOUT: { env: "RUMMY_FETCH_TIMEOUT", parse: Number },
	MAX_STRIKES: { env: "RUMMY_MAX_STRIKES", parse: Number },
	MIN_CYCLES: { env: "RUMMY_MIN_CYCLES", parse: Number },
	MAX_CYCLE_PERIOD: { env: "RUMMY_MAX_CYCLE_PERIOD", parse: Number },
	RUN_TIMEOUT: { env: "RUMMY_RUN_TIMEOUT", parse: Number },
	PLUGINS_LOAD_TIMEOUT: { env: "RUMMY_PLUGINS_LOAD_TIMEOUT", parse: Number },
	THINK: { env: "RUMMY_THINK", parse: parseBool, expected: "0|1|true|false" },
};

const config = {};
const missing = [];
for (const [key, spec] of Object.entries(REQUIRED)) {
	const raw = process.env[spec.env];
	if (raw === undefined || raw === "") {
		missing.push(spec.env);
		continue;
	}
	const parsed = spec.parse(raw);
	if (typeof parsed === "number" && Number.isNaN(parsed)) {
		const expected = spec.expected ?? "number";
		missing.push(`${spec.env} (got "${raw}", expected ${expected})`);
		continue;
	}
	config[key] = parsed;
}
if (missing.length > 0) {
	throw new Error(
		`RUMMY config missing or invalid: ${missing.join(", ")}. ` +
			"Set in .env, .env.example, or shell env.",
	);
}

export default Object.freeze(config);
