// Retell AI integration for outbound carrier IVR calls.
//
// Why Retell instead of the earlier OpenAI-Realtime+Twilio approach: carrier claims
// lines are heavy press-1-for-claims IVR menus that expect real DTMF touch tones.
// A pure conversational voice model can only *speak* digits, it cannot press them,
// so it gets stuck at every menu. Retell ships a dedicated `press_digit` tool that
// is separate from the conversational LLM turn, purpose-built for IVR navigation.
//
// IMPORTANT: Chance's Retell account is currently on the FREE TRIAL. Do not build
// anything that assumes bulk test-call volume. Every call-placing function here is
// dry-run by default (prints the plan) and only calls the real Retell API when both
// config.retell.allowRetellCalls is true (env: ALLOW_RETELL_CALLS=true) AND the
// command's JSON arg passes "execute":true. Before ever pointing this at a real
// carrier line, place ONE controlled test call to Chance's own cell number.
//
// Docs referenced while building this (fetched during development, not guessed):
//   - Create phone call:      https://docs.retellai.com/api-references/create-phone-call
//   - Create Retell LLM:      https://docs.retellai.com/api-references/create-retell-llm
//   - Create agent:           https://docs.retellai.com/api-references/create-agent
//   - Update Retell LLM:      https://docs.retellai.com/api-references/update-retell-llm
//   - Update agent:           https://docs.retellai.com/api-references/update-agent
//   - Press digit (IVR nav):  https://docs.retellai.com/build/single-multi-prompt/press-digit
//   - Import Twilio number:   https://docs.retellai.com/api-references/import-phone-number
//   - Get call (result):      https://docs.retellai.com/api-references/get-call
//   - List calls:             https://docs.retellai.com/api-references/list-calls

const RETELL_API_BASE = "https://api.retellai.com";

export function requireRetellConfig(config, { requireAgent = false } = {}) {
  const missing = [];
  if (!config.retell.apiKey) missing.push("RETELL_API_KEY");
  if (requireAgent && !config.retell.agentId) missing.push("RETELL_AGENT_ID");
  return missing;
}

// ---------------------------------------------------------------------------
// Call packet -> Retell LLM prompt/config conversion
// ---------------------------------------------------------------------------

// Converts the call packet produced by buildClaimCallPacket() (see
// src/assistant/claimCallPrompt.js) into a Retell "general_prompt" plus the
// general_tools array (including the press_digit / IVR navigation tool and an
// end_call tool). This is what gets sent to create-retell-llm / update-retell-llm.
export function buildRetellLlmFromPacket(packet, options = {}) {
  const generalPrompt = renderRetellPrompt(packet);
  const beginMessage = options.beginMessage || "";

  const generalTools = [
    {
      type: "end_call",
      name: "end_call",
      description: "End the call once the objective is complete, a stop rule is triggered, or a human asks to end the call."
    },
    {
      type: "press_digit",
      name: "press_digit",
      description:
        "Press a single DTMF touch-tone digit when an IVR menu explicitly instructs pressing a number, or when the " +
        "IVR does not accept spoken answers and requires numeric keypad input. Wait for the full menu prompt plus " +
        "about 3 seconds of silence before pressing, per the call script's IVR discipline instructions.",
      delay_ms: options.pressDigitDelayMs ?? 1000
    }
  ];

  return {
    generalPrompt,
    beginMessage,
    generalTools,
    // Handy for callers building the create-retell-llm body directly.
    toLlmRequestBody(extra = {}) {
      return {
        general_prompt: generalPrompt,
        begin_message: beginMessage,
        general_tools: generalTools,
        ...extra
      };
    }
  };
}

function renderRetellPrompt(packet) {
  const facts = packet.verifiedFileFacts || {};
  return [
    "You are a calm, professional assistant for Wave Public Adjusting, calling an insurance carrier on behalf of " +
      "public adjuster Chance Pearson. You are NOT the homeowner. Only give the full public adjuster introduction " +
      "to a human representative, never to an IVR system.",
    "",
    `Call objective: ${packet.objective}`,
    "",
    "Verified file facts (only use these, do not invent or guess any value not listed here):",
    factLines(facts),
    "",
    `Damage summary: ${(packet.damageSummary || []).join("; ")}`,
    "",
    "IVR discipline: wait for the full prompt to finish, wait about 3 seconds, then answer briefly. If the menu " +
      "explicitly says to press a number, or does not accept speech, use the press_digit tool with that digit. " +
      "Do not speak digits as words when the system expects a keypress.",
    "",
    "Short answers to use for IVR speech-recognition prompts:",
    bulletLines(packet.shortIvrAnswers),
    "",
    "Once a human representative answers, use this script:",
    packet.humanRepresentativeScript || "",
    "",
    "Information to capture before ending the call:",
    bulletLines(packet.informationToCapture),
    "",
    "Stop rules — end the call and do not improvise past these:",
    bulletLines(packet.stopRules),
    "",
    "When the call is complete, be ready to summarize the result in this shape (a human will read the transcript " +
      "and Retell call analysis afterward, this is just what you should try to have said out loud / confirmed):",
    JSON.stringify(packet.resultFormat, null, 2),
    "",
    ...(packet.postCallJobNimbusReminder || []).map((line) => `Reminder: ${line}`)
  ].join("\n");
}

function factLines(facts) {
  return Object.entries(facts)
    .map(([key, value]) => `- ${key}: ${value || "Missing"}`)
    .join("\n");
}

function bulletLines(items) {
  return (items && items.length ? items : ["(none)"]).map((item) => `- ${item}`).join("\n");
}

// ---------------------------------------------------------------------------
// Configure (create/update) the Retell LLM + agent from a call packet
// ---------------------------------------------------------------------------

// Dry-run by default: always returns/prints the plan. Only calls Retell's API
// when execute is true AND config.retell.allowRetellCalls is true.
export async function configureRetellAgentFromPacket(config, packet, options = {}) {
  const execute = options.execute === true;
  const llm = buildRetellLlmFromPacket(packet, options);
  const missing = requireRetellConfig(config);

  const plan = {
    action: "retell_configure_agent",
    mode: execute && config.retell.allowRetellCalls ? "EXECUTE" : "DRY RUN",
    freeTrialCaution:
      "Chance's Retell account is on the FREE TRIAL. Configuring/updating an agent does not use call minutes, " +
      "but confirm this is the intended agent before running with execute:true.",
    target: {
      llmId: config.retell.llmId || "(none yet - will create new Retell LLM)",
      agentId: config.retell.agentId || "(none yet - will create new agent)",
      voiceId: config.retell.voiceId || "(RETELL_VOICE_ID not set - Retell default will apply)"
    },
    llmRequestBody: llm.toLlmRequestBody(),
    missingConfig: missing
  };

  if (!execute || !config.retell.allowRetellCalls) {
    return {
      ...plan,
      note: "Dry run only. To write this to Retell, set ALLOW_RETELL_CALLS=true and pass \"execute\":true."
    };
  }

  if (missing.length) {
    throw new Error(`Blocked: missing ${missing.join(", ")}`);
  }

  const llmBody = llm.toLlmRequestBody();
  const llmResult = config.retell.llmId
    ? await retellRequest(config, "PATCH", `/update-retell-llm/${config.retell.llmId}`, llmBody)
    : await retellRequest(config, "POST", "/create-retell-llm", llmBody);

  const agentBody = {
    agent_name: options.agentName || "Wave Public Adjusting - Carrier Claim Call",
    response_engine: { type: "retell-llm", llm_id: llmResult.llm_id },
    voice_id: config.retell.voiceId || "11labs-Adrian"
  };

  const agentResult = config.retell.agentId
    ? await retellRequest(config, "PATCH", `/update-agent/${config.retell.agentId}`, agentBody)
    : await retellRequest(config, "POST", "/create-agent", agentBody);

  return {
    ...plan,
    executed: true,
    llmId: llmResult.llm_id,
    agentId: agentResult.agent_id,
    note: "Save llm_id/agent_id into RETELL_LLM_ID/RETELL_AGENT_ID in .env so future runs update rather than duplicate."
  };
}

// ---------------------------------------------------------------------------
// Trigger an outbound call
// ---------------------------------------------------------------------------

// Dry-run by default. Reuses Chance's existing Twilio "from" number
// (config.twilio.fromNumber). That number must already be imported into Retell
// (see importTwilioNumberIntoRetell below) before a real call can succeed -
// Retell requires from_number to be "a number purchased from Retell or imported
// to Retell" (https://docs.retellai.com/api-references/create-phone-call).
export async function triggerRetellCall(config, params = {}) {
  const execute = params.execute === true;
  const toNumber = params.to || config.twilio.verifiedTestNumber;
  const fromNumber = params.from || config.twilio.fromNumber || config.retell.fromNumber;
  const missing = requireRetellConfig(config, { requireAgent: !params.agentId });
  if (!toNumber) missing.push("to (call arg) or TWILIO_VERIFIED_TEST_NUMBER");
  if (!fromNumber) missing.push("from (call arg), TWILIO_FROM_NUMBER, or RETELL_FROM_NUMBER");

  const body = {
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: params.agentId || config.retell.agentId || undefined,
    metadata: params.metadata || undefined,
    retell_llm_dynamic_variables: params.dynamicVariables || undefined
  };

  const plan = {
    action: "retell_outbound_call",
    mode: execute && config.retell.allowRetellCalls ? "EXECUTE" : "DRY RUN",
    freeTrialCaution:
      "Chance's Retell account is on the FREE TRIAL - place ONE controlled test call (e.g. Chance's own cell " +
      "number, TWILIO_VERIFIED_TEST_NUMBER) before ever pointing this at a real carrier line. Trial accounts have " +
      "limited call minutes.",
    request: body,
    missingConfig: missing,
    prerequisite:
      "from_number must already be imported into Retell (POST /import-phone-number) - a bare Twilio-owned number " +
      "will be rejected by Retell's create-phone-call endpoint until it is imported or purchased through Retell."
  };

  if (!execute || !config.retell.allowRetellCalls) {
    return {
      ...plan,
      note: "Dry run only. To place the call, set ALLOW_RETELL_CALLS=true and pass \"execute\":true."
    };
  }

  if (missing.length) {
    throw new Error(`Blocked: missing ${missing.join(", ")}`);
  }

  const cleanBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  const result = await retellRequest(config, "POST", "/v2/create-phone-call", cleanBody);

  return {
    ...plan,
    executed: true,
    callId: result.call_id,
    callStatus: result.call_status
  };
}

// One-time setup helper: import an already-owned Twilio number into Retell so
// it can be used as from_number on outbound calls. Requires the Twilio number
// to have Elastic SIP Trunking enabled with a termination URI ending in
// ".pstn.twilio.com" (Twilio-side setup, cannot be done via this repo).
// Docs: https://docs.retellai.com/api-references/import-phone-number
export async function importTwilioNumberIntoRetell(config, params = {}) {
  const execute = params.execute === true;
  const missing = requireRetellConfig(config);
  const phoneNumber = params.phoneNumber || config.twilio.fromNumber;
  const terminationUri = params.terminationUri || config.retell.terminationUri;
  if (!phoneNumber) missing.push("phoneNumber (call arg) or TWILIO_FROM_NUMBER");
  if (!terminationUri) missing.push("terminationUri (call arg) or RETELL_TERMINATION_URI");

  const body = {
    phone_number: phoneNumber,
    termination_uri: terminationUri,
    sip_trunk_auth_username: params.sipUsername || undefined,
    sip_trunk_auth_password: params.sipPassword || undefined,
    inbound_agents: params.inboundAgentId ? [{ agent_id: params.inboundAgentId, weight: 1 }] : undefined,
    outbound_agents: params.outboundAgentId ? [{ agent_id: params.outboundAgentId, weight: 1 }] : undefined
  };

  const plan = {
    action: "retell_import_twilio_number",
    mode: execute && config.retell.allowRetellCalls ? "EXECUTE" : "DRY RUN",
    prerequisite:
      "Requires Elastic SIP Trunking enabled on this number in the Twilio console first (Twilio dashboard step, " +
      "cannot be done from this repo). See https://docs.retellai.com/api-references/import-phone-number",
    request: body,
    missingConfig: missing
  };

  if (!execute || !config.retell.allowRetellCalls) {
    return {
      ...plan,
      note: "Dry run only. To import, set ALLOW_RETELL_CALLS=true and pass \"execute\":true."
    };
  }
  if (missing.length) {
    throw new Error(`Blocked: missing ${missing.join(", ")}`);
  }

  const cleanBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  const result = await retellRequest(config, "POST", "/import-phone-number", cleanBody);
  return { ...plan, executed: true, result };
}

// ---------------------------------------------------------------------------
// Fetch a completed call's result/transcript
// ---------------------------------------------------------------------------

// Read-only, no dry-run gate needed (does not place calls or spend minutes),
// but still requires RETELL_API_KEY.
export async function fetchRetellCallResult(config, callId) {
  const missing = requireRetellConfig(config);
  if (missing.length) throw new Error(`Blocked: missing ${missing.join(", ")}`);
  if (!callId) throw new Error("Missing required input: callId");

  const call = await retellRequest(config, "GET", `/v2/get-call/${callId}`);
  return {
    callId: call.call_id,
    callStatus: call.call_status,
    disconnectionReason: call.disconnection_reason,
    durationMs: call.duration_ms,
    transcript: call.transcript,
    callAnalysis: call.call_analysis,
    // Full raw payload kept for anyone who needs a field not surfaced above.
    raw: call
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function retellRequest(config, method, path, body) {
  const response = await fetch(`${RETELL_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.retell.apiKey}`,
      "content-type": "application/json"
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`Retell ${method} ${path} failed with ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload;
}
