export default class ModelCapabilities {
	#cache = new Map();

	set(modelId, metadata) {
		this.#cache.set(
			modelId,
			Object.freeze({
				id: metadata.id,
				name: metadata.name,
				contextLength: metadata.context_length,
				supportedParameters: new Set(metadata.supported_parameters || []),
				architecture: metadata.architecture || {},
				pricing: metadata.pricing || {},
				maxCompletionTokens:
					metadata.top_provider?.max_completion_tokens || null,
			}),
		);
	}

	get(modelId) {
		return this.#cache.get(modelId) || null;
	}

	supports(modelId, parameter) {
		return (
			this.#cache.get(modelId)?.supportedParameters.has(parameter) ?? false
		);
	}

	supportsPrefill(modelId) {
		const caps = this.#cache.get(modelId);
		if (!caps) return true;
		// Models that use the Claude tokenizer don't support assistant prefill
		// via the standard API (Anthropic uses a different mechanism).
		// If the model explicitly lists assistant_prefill, respect that.
		// Otherwise, infer from architecture.
		if (caps.supportedParameters.has("assistant_prefill")) return true;
		if (caps.architecture?.tokenizer === "Claude") return false;
		return true;
	}
}
