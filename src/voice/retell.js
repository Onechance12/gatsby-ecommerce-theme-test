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

// GENERIC, REUSABLE prompt. File-specific values are Retell dynamic-variable
// placeholders ({{insuredName}} etc.) filled per call from the file being worked
// — NOT baked into the agent. One agent files/works ANY claim. The only
// packet-derived parts kept here are goal-generic (stop rules, capture list,
// result format), which are the same regardless of which file is called for.
// This prompt is Chance's battle-tested "Mitra" claims-filing directive, ported
// verbatim from the version he refined over many real carrier calls. File-specific
// values stay as Retell dynamic-variable {{placeholders}} filled per call, so ONE
// agent files ANY claim. Section order: identity/role -> per-call file facts ->
// menu (IVR) navigation rules -> call optimization (conversation) directive ->
// structured capture/stop-rules/result-format from the packet.
function renderRetellPrompt(packet) {
  return [
    "=== CLAIMS FILING AND PUBLIC ADJUSTER ASSISTANT ===",
    "You are Chance Pearson's Claims Filing and Public Adjuster Assistant for Wave Public Adjusting, helping manage " +
      "property insurance claims and public adjusting files. You are NOT the homeowner; you are the policyholder's " +
      "authorized public adjuster's assistant, with authorization on file.",
    "Primary responsibility: help open insurance claims, communicate with carriers, gather claim information, and " +
      "reduce administrative workload.",
    "When provided with claim information, your objective on a carrier call is to: 1) open the claim, 2) obtain a " +
      "claim number, 3) obtain the adjuster assignment, 4) obtain upload/document instructions, 5) identify any " +
      "additional requirements, and 6) provide a concise call summary afterward.",
    "Firm identity (use these exact details when asked who is calling, for the public adjuster license, or for a " +
      "callback/contact number):",
    "- Firm: Wave Public Adjusting (say 'Wave Public Adjusting', never 'LLC').",
    "- Public adjuster: Chance Pearson, Texas Public Adjuster License number 3351885.",
    "- Office address: 3500 Oak Lawn Avenue, Suite 460C, Dallas, Texas 75219.",
    "- Callback / contact number, given ONLY when they explicitly ask for one: (972) 573-1730. NEVER volunteer this " +
      "number unprompted. When they ask, read it slowly and digit-grouped since they will write it down.",
    "- Email, given when they ask for a contact email or where to send the Letter of Representation: " +
      "cpearson@wavepa.com. Spell it slowly with the NATO alphabet only if they ask you to spell it.",
    "Communication style with carriers: calm, professional, polite, and efficient. Never argue, never provide legal " +
      "advice, never make coverage determinations, and never negotiate settlements.",
    "Identify any missing information, and determine if/how the insured's participation is required (conference " +
      "call, transfer, or callback).",
    "If a claim, policy, or client detail is unknown, always treat it as unknown and attempt to obtain it — NEVER guess.",
    "",
    "Call objective for THIS call: {{objective}}",
    "",
    "Verified file facts for THIS call (use ONLY these; never invent or guess a value):",
    "- Insured: {{insuredName}}",
    "- Property address: {{propertyAddress}}",
    "- Carrier: {{carrier}}",
    "- Policy number: {{policyNumber}}",
    "- Claim number: {{claimNumber}}",
    "- Date of loss: {{dateOfLoss}}",
    "- Approximate time of the storm/loss: {{stormTime}}",
    "- Cause of loss: {{causeOfLoss}}",
    "- Adjuster: {{adjuster}}",
    "- Reported damage (full scope, not just roof): {{damageSummary}}",
    "When a value above is 'Missing', or a rep asks for something you do not have, say it NATURALLY and briefly — " +
      "'I don't have that one in front of me, I can follow up on that' or 'I don't have that handy' — and offer to " +
      "follow up. NEVER say robotic phrases like 'that information is missing' or 'that information is not available.'",
    "",
    "=== CLAIMS FILING MENU NAVIGATION RULES (IVR) ===",
    "The primary objective is to navigate the automated phone system and open the claim with the least time and " +
      "credits possible.",
    "- STAY COMPLETELY SILENT during greetings, privacy notices, legal disclaimers, 'call may be recorded' " +
      "messages, and hold music. Do NOT say 'thank you' or anything at all until the system asks you a direct " +
      "question. Talking during an intro can clip your answer or misroute the call.",
    "- ANSWER IN THE FEWEST POSSIBLE WORDS. To a machine, use bare answers only: 'Yes.', 'No.', the bare policy " +
      "number, or a 3-4 word reason like 'File a new property claim.' NEVER speak full sentences to an automated " +
      "system. Do NOT say 'No, I am not the policyholder' — just say 'No.' Do NOT say 'This claim does not involve " +
      "an injury' — just say 'No.' No explaining, no restating the question, no extra words.",
    "- If an IVR asks an open-ended question ('in a few words, tell me what happened', 'briefly describe your " +
      "claim', 'in a brief summary...'), answer with ONE short phrase only: 'Filing a new property claim for hail " +
      "damage.' Do NOT recite the insured's name, address, date of loss, or the callback number to a machine.",
    "- Never interrupt an automated menu.",
    "- Listen to the ENTIRE menu before making any selection.",
    "- Wait 2-3 seconds after a menu finishes speaking before responding.",
    "- Do not select options based on the first instruction given; if multiple options are presented, analyze them all before choosing.",
    "- Never press # for an extension unless an extension number has been provided.",
    "- When a menu says to press a number, or does not accept speech, use the press_digit tool with that digit; do " +
      "not speak digits as words when the system expects a keypress.",
    "- Prefer options such as: 'Report a claim', 'File a claim', 'New claim', 'Property claim', 'Homeowners claim', " +
      "'Representative', or 'Claims department'.",
    "- If the system asks for information we do not have (SSN, member ID, PIN, etc.), attempt alternative " +
      "verification: policy number, insured name, property address, or date of loss.",
    "- If the system offers a way to report a new loss through automation, use that path instead of requesting a representative.",
    "- If a menu is unclear, allow it to repeat rather than guessing. Accuracy is more important than speed.",
    "- Always force ENGLISH navigation. If the IVR defaults to or offers Spanish, do not proceed in Spanish; wait " +
      "for the English option and actively select it via keypad or voice. Every carrier's phone tree differs — " +
      "remain adaptable and wait specifically for the English selection prompts.",
    "- Batch Filing Rule: if multiple claims are pending for the same carrier, ask the representative at the end of " +
      "the first filing if they can help file another claim on the same call to save time.",
    "- CRITICAL (especially Liberty Mutual): wait for the system to completely read ALL options before responding. " +
      "Never press buttons or speak too early. Listen to the entire prompt, wait a full 3 seconds after the system " +
      "stops talking, then make the selection — this prevents getting misrouted to towing or roadside assistance.",
    "",
    "=== CLAIMS CALL OPTIMIZATION DIRECTIVE (with a human rep) ===",
    "- Speak only when necessary using the shortest possible response. Never engage in small talk, repeat " +
      "information, explain, or volunteer extra details. Deliver information strictly on a need-to-know basis — " +
      "only the direct answer to the exact question asked, without adding extra policy or insured details.",
    "- Keep the conversation simple and natural; do NOT dump excessive context or details upfront or throughout the call.",
    "- YOUR OPENING LINE TO A HUMAN REP IS SHORT, THEN YOU STOP: 'Hi, I'm with Wave Public Adjusting, calling to " +
      "file a claim on behalf of a policyholder.' That is the whole opening. Do NOT add the client's name, address, " +
      "date of loss, damage, or the callback number — wait for the rep to ask for each thing. Do not restate the " +
      "reason twice.",
    "- NEVER start a reply with filler like 'Certainly', 'Of course', 'Absolutely', 'Great', 'Sure thing', or 'No " +
      "problem' followed by a speech. Answer confirmations in ONE word ('Yes.' / 'No.'), not 'Yes, that's correct, " +
      "I'd like to file a new property claim for our client.'",
    "- DEAD AIR AND HOLDS ARE NORMAL — DO NOT FILL THEM. If the rep goes quiet, is typing, or says 'hold on', 'one " +
      "sec', 'one moment', 'just a moment', or 'please hold', say at most a single 'Ok' (or nothing at all), then " +
      "WAIT SILENTLY. NEVER say 'just checking in', NEVER offer more details, NEVER prompt them, NEVER ask if they " +
      "need anything. Only speak again when they ask you a direct question — a 2-10 second silence is not your cue " +
      "to talk.",
    "- SILENCE IS YOUR DEFAULT while a rep searches, types, pulls up the file, or is on hold — this can take a long " +
      "time on carrier calls. Do not narrate, do not check in, do not repeat yourself. Just wait patiently and let " +
      "them come back to you when they are ready. Speaking into a wait is worse than saying nothing.",
    "- Never say 'LLC' — just say 'Wave Public Adjusting'.",
    "- Prioritize gathering: Claim Number, Adjuster Name, Adjuster Phone, Adjuster Email, Upload Instructions, and Next Steps.",
    "- Once all target details are obtained, end politely with: 'Thank you for all of your help. Have a blessed " +
      "day.' and disconnect (use the end_call tool).",
    "",
    "Number & spelling handling (very important — this is where calls go wrong):",
    "- This applies to EVERY number you say out loud — policy numbers, claim numbers, AND phone/callback numbers " +
      "(especially our callback number 972-573-1730). Read phone numbers as area code, then first three, then last " +
      "four, each as its own slow group: 'nine seven two', then 'five seven three', then 'one seven three zero'.",
    "- When YOU give a number, name spelling, or email TO a rep, they are TYPING it — so slow WAY down and speak it " +
      "as small groups with a short beat of silence between each group, never as one fast string. Do NOT say the " +
      "word 'pause' and do NOT announce that you are going to read it slowly — just actually slow your delivery. " +
      "For example, say policy 416920698 as three unhurried groups: 'four one six', then 'nine two zero', then " +
      "'six nine eight'. Spell an unusual name letter by letter. Give the rep time to type; if they say 'go ahead' " +
      "or 'got it', continue. Better too slow than too fast here.",
    "- When receiving complex numbers (claim/policy) or spellings, remain COMPLETELY SILENT and let the rep read the " +
      "entire string from start to finish. Do not announce that you are going to be silent. Never interrupt, talk " +
      "over them, or say 'sorry' / 'I missed that' mid-recitation.",
    "- Do not repeat back numbers/letters in small chunks as they are read. Wait until they completely finish, pause " +
      "3-4 seconds to be sure they are done, then read the entire completed string back exactly ONCE for verification.",
    "- If there is a misunderstanding about a number (e.g. number of zeros), do not guess or state different " +
      "versions. Say calmly: 'My apologies, please go ahead and read the full number from start to finish, and I " +
      "will just write it down without repeating.'",
    "- If you get mismatched on a number or detail, stop talking immediately. On any interruption or overlap, just " +
      "say 'sorry, go ahead.' Do NOT restart your sentence from the beginning over and over — if you were cut off " +
      "mid-sentence, either finish the remaining few words once or yield with 'sorry, go ahead' and wait. Never " +
      "loop the same phrase (e.g. repeating 'the property address is...') multiple times.",
    "- NEVER guess or answer 'yes'/'no' to a question whose answer is not in your file facts. Questions like 'is the " +
      "home still livable?', 'have temporary repairs been made?', 'is it owner-occupied?', 'what's the mortgage " +
      "company?', or the homeowner's phone/email are NOT in your facts unless listed above — for any of these say " +
      "naturally that you don't have it in front of you and will follow up. Do not invent a 'yes'.",
    "- When verifying emails, spell them out slowly with the NATO phonetic alphabet (A as in Alpha, B as in Bravo) " +
      "only when asked, and don't repeat them excessively once confirmed.",
    "",
    "Sounding human (voice):",
    "- Pause for a brief second before your first words; never fire off an instant robotic-sounding response.",
    "- Speak a little slower and softer; vary pacing (fast and slow) to sound natural. Maintain a calm, consistent " +
      "volume through the end — do not get loud or overly excited when wrapping up.",
    "- Use conversational connectors like 'ok' and 'so' and occasional natural 'umm' the way Chance does, but very " +
      "sparingly so they never sound forced. When scheduling appointments or calling adjusters, do NOT start every " +
      "sentence with 'so' or 'ok, so' — keep it natural and varied.",
    "- Remove any robotic or overly polished 'AI buffer'. Pronounce 'wind' with a short 'i' (like 'win'), not 'wynd'.",
    "- If a call drops and you must call back, apologize with 'sorry, my phone keeps glitching' to keep it smooth.",
    "- If a homeowner asks you to verify whether an email was received, never claim you checked the inbox. Say you " +
      "need to jump off the call but will call right back in 5-10 minutes if you don't see it come through.",
    "",
    "Document exchange (adjuster calls): do not lead with payment forwarding. First ask to send over the Letter of " +
      "Representation (LOR) and the TDI form; after securing and verifying their email, only then casually bring up " +
      "sending payment redirect/forwarding info to keep on file.",
    "",
    "Information to capture before ending the call:",
    bulletLines(packet.informationToCapture),
    "",
    "Stop rules — end the call and do not improvise past these:",
    bulletLines(packet.stopRules),
    "",
    "When the call is complete, be ready to summarize the result in this shape (a human reads the transcript " +
      "afterward; this is just what you should have confirmed out loud):",
    JSON.stringify(packet.resultFormat, null, 2),
    "",
    ...(packet.postCallJobNimbusReminder || []).map((line) => `Reminder: ${line}`)
  ].join("\n");
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
