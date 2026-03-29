-- PREP: upsert_provider_model
INSERT INTO provider_models (
	id
	, canonical_slug
	, name
	, description
	, context_length
	, modality
	, tokenizer
	, instruct_type
	, input_modalities
	, output_modalities
	, pricing_prompt
	, pricing_completion
	, pricing_input_cache_read
	, max_completion_tokens
	, is_moderated
	, supported_parameters
	, default_parameters
	, knowledge_cutoff
	, expiration_date
	, created
	, fetched_at
)
VALUES (
	:id
	, :canonical_slug
	, :name
	, :description
	, :context_length
	, :modality
	, :tokenizer
	, :instruct_type
	, :input_modalities
	, :output_modalities
	, :pricing_prompt
	, :pricing_completion
	, :pricing_input_cache_read
	, :max_completion_tokens
	, :is_moderated
	, :supported_parameters
	, :default_parameters
	, :knowledge_cutoff
	, :expiration_date
	, :created
	, CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO UPDATE SET
	canonical_slug = EXCLUDED.canonical_slug
	, name = EXCLUDED.name
	, description = EXCLUDED.description
	, context_length = EXCLUDED.context_length
	, modality = EXCLUDED.modality
	, tokenizer = EXCLUDED.tokenizer
	, instruct_type = EXCLUDED.instruct_type
	, input_modalities = EXCLUDED.input_modalities
	, output_modalities = EXCLUDED.output_modalities
	, pricing_prompt = EXCLUDED.pricing_prompt
	, pricing_completion = EXCLUDED.pricing_completion
	, pricing_input_cache_read = EXCLUDED.pricing_input_cache_read
	, max_completion_tokens = EXCLUDED.max_completion_tokens
	, is_moderated = EXCLUDED.is_moderated
	, supported_parameters = EXCLUDED.supported_parameters
	, default_parameters = EXCLUDED.default_parameters
	, knowledge_cutoff = EXCLUDED.knowledge_cutoff
	, expiration_date = EXCLUDED.expiration_date
	, created = EXCLUDED.created
	, fetched_at = CURRENT_TIMESTAMP;
