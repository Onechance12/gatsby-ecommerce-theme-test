import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRetellClaimAgentSettings,
  buildRetellClaimLlmSettings,
  buildRetellClaimVoiceSettings,
  normalizeRetellClaimAgentSettings,
  normalizeRetellClaimLlmSettings,
  normalizeRetellClaimVoiceSettings,
  retellClaimSettingsMismatches,
  RETELL_CLAIM_AGENT_ATTESTED_FIELDS
} from "./retellAgentSettings.js";

test("claim LLM waits for the carrier and pins deterministic tool behavior", () => {
  assert.deepEqual(buildRetellClaimLlmSettings(), {
    begin_message: "",
    start_speaker: "user",
    begin_after_user_silence_ms: null,
    model: "gpt-4.1",
    s2s_model: null,
    model_temperature: 0,
    model_high_priority: false,
    model_ultrafast: false,
    model_config: {
      type: "cascading",
      primary: { model: "gpt-4.1", tier: "standard" },
      backup: null,
      temperature: 0
    },
    tool_call_strict_mode: true,
    states: [],
    starting_state: null,
    mcps: [],
    knowledge_base_ids: [],
    kb_config: { top_k: 3, filter_score: 0.6 },
    default_dynamic_variables: {}
  });
});

test("current Retell model selection accepts null/omitted no-backup readback without inheriting a fallback", () => {
  const expected = buildRetellClaimLlmSettings();
  assert.equal(expected.model_config.backup, null);
  const live = structuredClone(expected);
  delete live.model_config.backup;
  assert.deepEqual(normalizeRetellClaimLlmSettings(live), normalizeRetellClaimLlmSettings(expected));
  assert.equal(Object.hasOwn(expected.model_config, "backup"), true);
  assert.equal(Object.hasOwn(live.model_config, "backup"), false);
  const copy = buildRetellClaimLlmSettings();
  copy.model_config.primary.model = "changed";
  assert.equal(buildRetellClaimLlmSettings().model_config.primary.model, "gpt-4.1");
});

test("authoritative model drift fails even when every deprecated model field still matches", () => {
  const llm = buildRetellClaimLlmSettings();
  const agent = { ...buildRetellClaimAgentSettings(), ...buildRetellClaimVoiceSettings() };
  for (const mutate of [
    config => { config.primary.model = "different-model"; },
    config => { config.primary.tier = "ultrafast"; },
    config => { config.temperature = 0.5; },
    config => { config.backup = { model: "gpt-4.1", tier: "standard", kick_in_timeout_ms: 30150 }; },
    config => { config.primary.unreviewed_setting = true; },
    config => { config.unreviewed_setting = true; },
    config => { delete config.primary; }
  ]) {
    const changed = structuredClone(llm);
    mutate(changed.model_config);
    assert.ok(retellClaimSettingsMismatches({ llm: changed, agent }).includes("llm.model_config"));
    assert.equal(changed.model, "gpt-4.1");
    assert.equal(changed.model_temperature, 0);
  }
  const missing = structuredClone(llm);
  delete missing.model_config;
  assert.ok(retellClaimSettingsMismatches({ llm: missing, agent }).includes("llm.model_config"));
  const ultrafast = { ...llm, model_ultrafast: true };
  assert.ok(retellClaimSettingsMismatches({ llm: ultrafast, agent }).includes("llm.model_ultrafast"));
});

test("claim runtime is tuned for carrier holds, accurate entities, and no native IVR hangup", () => {
  const settings = buildRetellClaimAgentSettings();
  assert.equal(settings.agent_name, "Wave Public Adjusting - Carrier Claim Call");
  assert.equal(settings.stt_mode, "accurate");
  assert.equal(settings.responsiveness, 0.55);
  assert.equal(settings.interruption_sensitivity, 0.35);
  assert.equal(settings.enable_backchannel, false);
  assert.equal(settings.backchannel_frequency, 0.8);
  assert.equal(settings.backchannel_words, null);
  assert.equal(settings.begin_message_delay_ms, 0);
  assert.equal(settings.reminder_max_count, 0);
  assert.equal(settings.ambient_sound_volume, 1);
  assert.equal(settings.end_call_after_silence_ms, 600000);
  assert.equal(settings.max_call_duration_ms, 1800000);
  assert.equal(settings.ivr_option, null);
  assert.equal(settings.voicemail_option, null);
  assert.equal(settings.webhook_url, null);
  assert.deepEqual(settings.webhook_events, []);
  assert.equal(settings.custom_stt_config, null);
  assert.equal(settings.allow_user_dtmf, false);
  assert.equal(settings.allow_dtmf_interruption, false);
  assert.deepEqual(settings.user_dtmf_options, {});
  assert.deepEqual(settings.guardrail_config, { output_topics: [], input_topics: [] });
  assert.equal(settings.handbook_config.natural_filler_words, false);
  assert.ok(settings.boosted_keywords.includes("{{policyNumberSpoken}}"));
  assert.equal(Object.hasOwn(settings, "voicemail_detection_timeout_ms"), false);
  assert.equal(Object.hasOwn(settings, "is_public"), false);
});

test("claim voice is an explicit reviewed projection rather than inherited draft state", () => {
  const voice = buildRetellClaimVoiceSettings();
  assert.deepEqual(voice, {
    voice_id: "retell-Cimo",
    voice_model: null,
    fallback_voice_ids: null,
    voice_temperature: 1,
    voice_speed: 1,
    enable_dynamic_voice_speed: false,
    volume: 1,
    voice_emotion: null,
    enable_expressive_mode: false,
    expressive_emotion_tags: [],
    expressive_mode_prompt: null
  });
  assert.deepEqual(normalizeRetellClaimVoiceSettings({ voice_id: "retell-Cimo" }), voice);
});

test("claim storage retains review evidence for guarded callbacks and expires it after 30 days", () => {
  const settings = buildRetellClaimAgentSettings();
  assert.equal(settings.data_storage_setting, "everything");
  assert.equal(settings.data_storage_retention_days, 30);
  assert.equal(settings.opt_in_signed_url, true);
  assert.equal(settings.signed_url_expiration_ms, 3600000);
  for (const operationalField of [
    "person_name",
    "address",
    "email",
    "phone_number",
    "customer_account_number"
  ]) {
    assert.equal(settings.pii_config.categories.includes(operationalField), false);
  }
  assert.deepEqual(RETELL_CLAIM_AGENT_ATTESTED_FIELDS, Object.keys(settings));
});

test("settings builders return isolated mutable copies", () => {
  const first = buildRetellClaimAgentSettings();
  first.boosted_keywords.push("changed");
  first.handbook_config.scope_boundaries = true;
  const second = buildRetellClaimAgentSettings();
  assert.equal(second.boosted_keywords.includes("changed"), false);
  assert.equal(second.handbook_config.scope_boundaries, false);
});

test("every pinned runtime-control drift is diagnosed by field", () => {
  const llm = buildRetellClaimLlmSettings();
  const agent = {
    ...buildRetellClaimAgentSettings(),
    ...buildRetellClaimVoiceSettings()
  };
  assert.deepEqual(retellClaimSettingsMismatches({ llm, agent }), []);

  for (const field of Object.keys(llm)) {
    const drifted = structuredClone(llm);
    drifted[field] = field === "model_temperature" ? 0.4 : `drift-${field}`;
    assert.ok(retellClaimSettingsMismatches({ llm: drifted, agent }).includes(`llm.${field}`), field);
  }
  const voiceFields = new Set(Object.keys(buildRetellClaimVoiceSettings()));
  for (const field of Object.keys(agent)) {
    const drifted = structuredClone(agent);
    drifted[field] = typeof drifted[field] === "boolean"
      ? !drifted[field]
      : typeof drifted[field] === "number"
        ? drifted[field] + 1
        : Array.isArray(drifted[field]) || field === "fallback_voice_ids"
          ? [`drift-${field}`]
          : `drift-${field}`;
    const prefix = voiceFields.has(field) ? "voice" : "agent";
    assert.ok(retellClaimSettingsMismatches({ llm, agent: drifted }).includes(`${prefix}.${field}`), field);
  }
});

test("normalization treats omitted nullable native controls as explicit null and canonicalizes PII categories", () => {
  const llm = normalizeRetellClaimLlmSettings({ ...buildRetellClaimLlmSettings(), begin_after_user_silence_ms: undefined });
  assert.equal(llm.begin_after_user_silence_ms, null);
  const agent = buildRetellClaimAgentSettings();
  agent.pii_config.categories.reverse();
  assert.deepEqual(
    normalizeRetellClaimAgentSettings(agent).pii_config.categories,
    [...buildRetellClaimAgentSettings().pii_config.categories].sort()
  );
});
