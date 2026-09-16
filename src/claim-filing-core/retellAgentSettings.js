// Canonical Retell runtime controls for the carrier claim-filing agent.
//
// Keep these settings in one pure module so the publisher, live attestation,
// and tests all evaluate the same contract. Claim truth and authorization stay
// in the bridge; these values only control the conversation/telephony runtime.

export const RETELL_CLAIM_LLM_SETTINGS = Object.freeze({
  begin_message: "",
  start_speaker: "user",
  begin_after_user_silence_ms: null,
  model: "gpt-4.1",
  s2s_model: null,
  model_temperature: 0,
  model_high_priority: false,
  tool_call_strict_mode: true,

  // This is intentionally one reviewed prompt with two reviewed tools. Clear
  // every inherited Retell extension point so an old state/router, MCP, KB, or
  // default value cannot survive when a draft is cloned from production.
  states: Object.freeze([]),
  starting_state: null,
  mcps: Object.freeze([]),
  knowledge_base_ids: Object.freeze([]),
  // Retell materializes these retrieval defaults on every fresh draft even
  // when no knowledge bases are attached. Pin the exact inert defaults so the
  // publisher can PATCH the current object-only schema and attest the readback.
  kb_config: Object.freeze({ top_k: 3, filter_score: 0.6 }),
  default_dynamic_variables: Object.freeze({})
});

// Voice is a separately reviewed part of the production claim-agent contract.
// Do not inherit it invisibly from whichever Retell draft happens to be cloned.
export const RETELL_CLAIM_VOICE_SETTINGS = Object.freeze({
  voice_id: "retell-Cimo",
  voice_model: null,
  fallback_voice_ids: null,
  voice_temperature: 1,
  voice_speed: 1,
  enable_dynamic_voice_speed: false,
  volume: 1,
  voice_emotion: null,
  enable_expressive_mode: false,
  expressive_emotion_tags: Object.freeze([]),
  expressive_mode_prompt: null
});

export const RETELL_CLAIM_AGENT_SETTINGS = Object.freeze({
  agent_name: "Wave Public Adjusting - Carrier Claim Call",
  language: "en-US",
  responsiveness: 0.55,
  enable_dynamic_responsiveness: false,
  interruption_sensitivity: 0.35,
  enable_backchannel: false,
  backchannel_frequency: 0.8,
  backchannel_words: null,
  begin_message_delay_ms: 0,
  reminder_trigger_ms: 30000,
  // Carrier holds and IVR processing are intentional silence. Native reminder
  // turns would fight NO_RESPONSE_NEEDED and reintroduce repetition.
  reminder_max_count: 0,
  ambient_sound: null,
  ambient_sound_volume: 1,

  // Do not inherit account/dashboard hooks or behavior packs into the filing
  // runtime. The bridge polls and reviews results under its own approval model.
  webhook_url: null,
  webhook_events: Object.freeze([]),
  webhook_timeout_ms: 10000,
  pronunciation_dictionary: null,

  stt_mode: "accurate",
  custom_stt_config: null,
  vocab_specialization: "general",
  boosted_keywords: Object.freeze([
    "{{insuredName}}",
    "{{carrier}}",
    "{{propertyAddress}}",
    "{{policyNumberSpoken}}",
    "{{claimNumber}}",
    "Wave Public Adjusting",
    "Titan Reconstruction",
    "Letter of Representation"
  ]),
  denoising_mode: "noise-cancellation",

  ring_duration_ms: 60000,
  end_call_after_silence_ms: 600000,
  max_call_duration_ms: 1800000,
  // Native voicemail hangup can mistake a carrier recording/IVR and bypass the
  // transcript guard. The prompt requests guarded ending only after voicemail
  // is transcript-backed.
  voicemail_option: null,
  // The carrier agent must navigate IVRs with press_digit. Native IVR hangup
  // would terminate the exact calls this agent exists to complete.
  ivr_option: null,
  call_screening_option: null,
  allow_user_dtmf: false,
  allow_dtmf_interruption: false,
  // Retell materializes an empty object here even when DTMF is disabled. Pin
  // the inert readback shape so exact publication attestation stays stable.
  user_dtmf_options: Object.freeze({}),

  guardrail_config: Object.freeze({
    output_topics: Object.freeze([]),
    input_topics: Object.freeze([])
  }),
  handbook_config: Object.freeze({
    default_personality: false,
    conversational_personality: false,
    natural_filler_words: false,
    high_empathy: false,
    echo_verification: false,
    nato_phonetic_alphabet: false,
    speech_normalization: false,
    smart_matching: false,
    ai_disclosure: false,
    scope_boundaries: false
  }),

  // Result review, callback ownership, and guarded writeback currently consume
  // Retell's raw transcript/metadata/analysis fields. Retell deletes those raw
  // fields when everything_except_pii is enabled, so keep full storage until a
  // scrub-aware canonical call projection is implemented and regression-tested.
  data_storage_setting: "everything",
  data_storage_retention_days: 30,
  pii_config: Object.freeze({
    mode: "post_call",
    categories: Object.freeze([
      "ssn",
      "passport",
      "driver_license",
      "credit_card",
      "bank_account",
      "password",
      "pin",
      "medical_id",
      "date_of_birth"
    ])
  }),
  opt_in_signed_url: true,
  signed_url_expiration_ms: 3600000,

  post_call_analysis_model: "gpt-4.1-mini",
  timezone: "America/Chicago"
});

export function buildRetellClaimLlmSettings() {
  return structuredClone(RETELL_CLAIM_LLM_SETTINGS);
}

export function buildRetellClaimAgentSettings() {
  return structuredClone(RETELL_CLAIM_AGENT_SETTINGS);
}

export function buildRetellClaimVoiceSettings() {
  return structuredClone(RETELL_CLAIM_VOICE_SETTINGS);
}

export const RETELL_CLAIM_AGENT_ATTESTED_FIELDS = Object.freeze(
  Object.keys(RETELL_CLAIM_AGENT_SETTINGS)
);

export function normalizeRetellClaimLlmSettings(llm = {}) {
  return Object.fromEntries(Object.keys(RETELL_CLAIM_LLM_SETTINGS).map((field) => [
    field,
    llm?.[field] ?? null
  ]));
}

export function normalizeRetellClaimAgentSettings(agent = {}) {
  const attested = Object.fromEntries(RETELL_CLAIM_AGENT_ATTESTED_FIELDS.map((field) => [
    field,
    agent?.[field] ?? null
  ]));
  if (attested.pii_config && typeof attested.pii_config === "object") {
    attested.pii_config = {
      mode: attested.pii_config.mode ?? null,
      categories: Array.isArray(attested.pii_config.categories)
        ? [...attested.pii_config.categories].map(String).sort()
        : []
    };
  }
  return attested;
}

export function normalizeRetellClaimVoiceSettings(agent = {}) {
  return {
    voice_id: String(agent?.voice_id || ""),
    voice_model: agent?.voice_model ?? null,
    fallback_voice_ids: Array.isArray(agent?.fallback_voice_ids)
      ? [...agent.fallback_voice_ids].map(String)
      : null,
    voice_temperature: agent?.voice_temperature ?? 1,
    voice_speed: agent?.voice_speed ?? 1,
    enable_dynamic_voice_speed: agent?.enable_dynamic_voice_speed ?? false,
    volume: agent?.volume ?? 1,
    voice_emotion: agent?.voice_emotion ?? null,
    enable_expressive_mode: agent?.enable_expressive_mode ?? false,
    expressive_emotion_tags: Array.isArray(agent?.expressive_emotion_tags)
      ? [...agent.expressive_emotion_tags].map(String).sort()
      : [],
    expressive_mode_prompt: agent?.expressive_mode_prompt ?? null
  };
}

export function retellClaimSettingsMismatches({ llm = {}, agent = {} } = {}) {
  const expectedLlm = normalizeRetellClaimLlmSettings(RETELL_CLAIM_LLM_SETTINGS);
  const actualLlm = normalizeRetellClaimLlmSettings(llm);
  const expectedAgent = normalizeRetellClaimAgentSettings(RETELL_CLAIM_AGENT_SETTINGS);
  const actualAgent = normalizeRetellClaimAgentSettings(agent);
  const expectedVoice = normalizeRetellClaimVoiceSettings(RETELL_CLAIM_VOICE_SETTINGS);
  const actualVoice = normalizeRetellClaimVoiceSettings(agent);
  return [
    ...Object.keys(expectedLlm).filter((field) => !sameValue(actualLlm[field], expectedLlm[field])).map((field) => `llm.${field}`),
    ...Object.keys(expectedAgent).filter((field) => !sameValue(actualAgent[field], expectedAgent[field])).map((field) => `agent.${field}`),
    ...Object.keys(expectedVoice).filter((field) => !sameValue(actualVoice[field], expectedVoice[field])).map((field) => `voice.${field}`)
  ];
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
