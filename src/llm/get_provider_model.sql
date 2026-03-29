-- PREP: get_provider_model
SELECT
	id
	, context_length
	, supported_parameters
	, tokenizer
	, max_completion_tokens
FROM provider_models
WHERE id = :id;
