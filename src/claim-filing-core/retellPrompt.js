// Portable Retell prompt / tools / post-call-analysis schema. Pure +
// dependency-free (no HTTP, no env, no config object). The HTTP layer
// (src/voice/retell.js) imports these and adds transport + gating. Retell stays
// the carrier claim-filing engine because it supports DTMF IVR navigation
// (press_digit), which a pure conversational voice model cannot do.

// Build the Retell LLM config (general_prompt + general_tools) from a call
// packet. Returns the pieces plus a toLlmRequestBody() convenience.
export function buildRetellLlmFromPacket(packet, options = {}) {
  const generalPrompt = renderRetellPrompt(packet);
  const beginMessage = options.beginMessage || "";
  const generalTools = [
    {
      type: "custom",
      name: "request_guarded_end_call",
      description:
        "Request permission to end. The bridge verifies transcript-backed outcome, required wrap-up, final closing, " +
        "and representative acknowledgement. If denied, stay connected and follow its instruction.",
      url: options.guardedEndCallUrl || "https://jobnimbus-chatgpt-bridge.onrender.com/retell/guarded-end-call",
      method: "POST",
      headers: options.guardedEndCallAuthorization ? { authorization: options.guardedEndCallAuthorization } : undefined,
      speak_during_execution: false,
      // Retell must run the LLM again after a denial so it can follow the
      // bridge instruction and remain connected. Successful requests stop the
      // call server-side before another utterance can be produced.
      speak_after_execution: true,
      timeout_ms: 10000,
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Active dynamic-variable call goal." },
          reason: { type: "string", enum: ["objective_complete", "callback_confirmed", "no_number_yet", "voicemail", "automated_system", "wrong_number", "human_requested_end", "safety_stop"] },
          outcome: { type: "string", enum: ["claim_filed", "existing_claim_confirmed", "callback_requested", "blocked_missing_information", "carrier_unreachable", "no_result"] },
          claim_number: { type: "string", description: "Carrier-spoken claim/reference number, else empty." },
          callback_confirmed: { type: "boolean" },
          document_submission_requested: { type: "boolean", description: "True only after asking for the LOR/document destination." },
          next_step_requested: { type: "boolean", description: "True only after asking the carrier next step/timeframe." },
          additional_claims_completed: { type: "integer", description: "Completed approved additional-claim count." },
          additional_claim_numbers: { type: "string", description: "Comma-separated completed additional claim numbers." },
          batch_continuation_resolved: { type: "boolean", description: "True when all approved additional claims are resolved." }
        },
        required: ["goal", "reason", "outcome", "claim_number", "callback_confirmed", "document_submission_requested", "next_step_requested", "additional_claims_completed", "additional_claim_numbers", "batch_continuation_resolved"]
      }
    },
    {
      type: "press_digit",
      name: "press_digit",
      description:
        "Press one DTMF digit only when the completed IVR menu requires that exact keypad input.",
      // Retell otherwise materializes true and immediately runs another model
      // turn after the digit. Keep this false so the carrier IVR can respond
      // before the agent reasons or speaks again.
      speak_after_execution: false,
      // Retell's pause-detection delay. One second matches the spoken IVR
      // contract and avoids treating a slow menu pause as the end of the menu.
      delay_ms: options.pressDigitDelayMs ?? 1000
    }
  ];
  return {
    generalPrompt,
    beginMessage,
    generalTools,
    toLlmRequestBody(extra = {}) {
      return {
        general_prompt: generalPrompt,
        begin_message: beginMessage,
        general_tools: generalTools,
        // A carrier or IVR must speak first so Retell does not talk over the
        // greeting, recording notice, or menu.
        ...extra,
        start_speaker: "user"
      };
    }
  };
}

// Retell prices the initial prompt and tools together after dynamic-variable
// substitution. This is deliberately a conservative, dependency-free estimate
// used to stop unexpectedly large packets before a paid call. It is not an
// assertion about Retell's proprietary tokenizer.
export const RETELL_INITIAL_CONTEXT_CHARACTER_LIMIT = 14000;

export function estimateRetellInitialContext(llm, dynamicVariables = {}) {
  const expandedPrompt = String(llm?.generalPrompt || "").replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (_match, key) => String(dynamicVariables?.[key] ?? "Missing")
  );
  const characters = JSON.stringify({
    general_prompt: expandedPrompt,
    general_tools: Array.isArray(llm?.generalTools) ? llm.generalTools : []
  }).length;
  return {
    characters,
    estimatedTokens: Math.ceil(characters / 4),
    withinLimit: characters <= RETELL_INITIAL_CONTEXT_CHARACTER_LIMIT
  };
}

// The post-call analysis schema Retell runs against the transcript after every
// call. It populates call_analysis.custom_analysis_data with exactly the fields
// resultExtraction.js reads — so the writeback prefers a structured extraction
// over transcript guessing. Field names here MUST match the cad.* keys in
// resultExtraction.js. Docs: https://docs.retellai.com/build/post-call-analysis
export function postCallAnalysisSchema() {
  return [
    { type: "string", name: "claim_number", description: "The claim or reference number the carrier gave for this filing, digits/letters only. Empty if none was issued on the call." },
    { type: "string", name: "adjuster_name", description: "Full name of the CARRIER-ASSIGNED adjuster or handling team only. Never put Chance Pearson, Wave Public Adjusting, the insured, or the carrier intake representative here. Empty if no carrier adjuster was assigned." },
    { type: "string", name: "adjuster_phone", description: "Direct phone number for the CARRIER-ASSIGNED adjuster or carrier claims team only. Never use Chance's, Wave's, the homeowner's, or the intake representative's number. Empty if not provided." },
    { type: "string", name: "adjuster_email", description: "Email address for the CARRIER-ASSIGNED adjuster only. Never use cpearson@wavepa.com, the homeowner email, or the general document-submission email. Empty if not provided." },
    { type: "string", name: "document_submission", description: "The exact email address, portal, fax, or carrier instruction for sending the Letter of Representation and supporting documents. If no destination exists yet, capture the carrier's exact instruction such as 'wait for the assigned adjuster'. Empty only when the topic was never resolved." },
    { type: "boolean", name: "document_submission_requested", description: "True only when the assistant explicitly asked where to send the Letter of Representation and supporting documents. False when the assistant never asked." },
    { type: "string", name: "next_step", description: "The next step or timeframe the rep described (e.g. 'adjuster will call in 24-48 hours', 'inspection to be scheduled'). Empty if none." },
    { type: "boolean", name: "inspection_scheduled", description: "True only when the carrier or adjuster and the assistant finalized an exact inspection date and arrival window on this call. False for proposed options, voicemails, or unresolved scheduling." },
    { type: "string", name: "inspection_start", description: "Confirmed inspection arrival-window start as an ISO 8601 timestamp with an explicit UTC offset, for example 2026-07-17T14:00:00-05:00. Empty unless inspection_scheduled is true." },
    { type: "string", name: "inspection_end", description: "Confirmed inspection arrival-window end as an ISO 8601 timestamp with an explicit UTC offset. Empty unless inspection_scheduled is true." },
    { type: "string", name: "inspection_timezone", description: "Timezone for the confirmed inspection. Use America/Chicago for Central time. Empty unless inspection_scheduled is true." },
    { type: "string", name: "inspection_access_requirements", description: "Whether interior access, homeowner presence, contractor attendance, or another access condition was stated. Empty if none was stated." },
    { type: "string", name: "representative_name", description: "The carrier representative's name, if a human representative participated. Empty if not provided." },
    { type: "string", name: "blocking_reason", description: "The exact reason the claim could not be filed or the objective could not be completed. Empty when completed." },
    { type: "boolean", name: "callback_requested", description: "True only when the carrier explicitly confirmed a queue or scheduled callback request. False otherwise." },
    { type: "string", name: "additional_claims", description: "For approved batch filings, a compact JSON array with one object per additional insured containing fileNumber, insuredName, claimNumber, adjusterName, adjusterPhone, adjusterEmail, documentSubmission, nextStep, and outcome. Empty array string [] when no additional claim was handled." },
    {
      type: "enum",
      name: "filing_outcome",
      description: "The outcome of the call. 'claim_filed' = a NEW claim was opened and a claim number issued. 'existing_claim_confirmed' = an already-existing claim was confirmed. 'callback_requested' = the carrier confirmed a callback but no claim was filed yet. 'blocked_missing_information' = a representative could not proceed because a required fact was unavailable. 'carrier_unreachable' = no representative or usable claim intake path was reached. 'no_result' = another incomplete outcome.",
      choices: ["claim_filed", "existing_claim_confirmed", "callback_requested", "blocked_missing_information", "carrier_unreachable", "no_result"]
    }
  ];
}

// One compact carrier-only prompt. Homeowner coordination, inspection
// scheduling, and multi-file batch work belong to their dedicated agents or
// operator lanes. File-specific values remain dynamic variables so one
// published agent can safely handle an approved exact-file packet.
export function renderRetellPrompt(packet) {
  return [
    "=== CARRIER CLAIM INTAKE — EXACT FILE ONLY ===",
    "You are Chance Pearson's AI assistant for Wave Public Adjusting. Handle one claim. Never pose as Chance, the homeowner, " +
      "or a human; negotiate; give legal advice; change policy/payment; or write JobNimbus.",
    "Goal {{goal}}. Objective {{objective}}. Direction {{directionMode}}.",
    "Success requires a claim/reference number plus adjuster, document destination, and next step. A queue callback is not a filed claim.",
    "",
    "=== SPEAKING RULES ===",
    "- TOP-PRIORITY TURN RULE: one question gets one short answer. Answer only what was asked, then stop. No recap, " +
      "filler, repetition, or volunteered history.",
    "- Never ask the carrier 'How can I help you?' You called.",
    "- Be concise. Do not say 'Certainly', 'Absolutely', 'No problem', 'take your time', or 'let me know if you need anything else.'",
    "- If interrupted, say only 'Sorry, go ahead,' then listen; never restart in a loop.",
    "- If a machine acknowledges, holds, transfers, plays music, or processes, return exactly NO_RESPONSE_NEEDED. Never speak the token.",
    "- If a human is typing, checking, documenting, transferring, or asks for a moment, return exactly NO_RESPONSE_NEEDED " +
      "unless a brief 'Ok' is socially necessary once. Wait-state language is never a wrap-up.",
    "- After your final goodbye return exactly NO_RESPONSE_NEEDED; end only after the representative's later acknowledgement.",
    "- In a speech-ready number, each spaced hyphen creates a short silence. Never say 'dash'.",
    "",
    "=== IDENTITY ===",
    "- If asked your name or who is calling, say exactly: 'Chance Pearson's AI assistant with Wave Public Adjusting.' " +
      "Never answer that caller-identity question with the insured's name.",
    "- If asked if you are AI, say yes. Firm: Wave Public Adjusting, never 'LLC'.",
    "- Public adjuster: Chance Pearson, Texas license 3351885.",
    "- Office: 3500 Oak Lawn Avenue, Suite 460C, Dallas, Texas 75219.",
    "- Contact number, only when asked: 'nine seven two - five seven three - one seven three zero.'",
    "- Contact email, only when asked: cpearson@wavepa.com. Say 'c pearson at wave, P A, dot com.'",
    "- After a live greeting, open by goal. " +
      "For file_new_claim say: 'Hi, this is Chance Pearson's AI assistant with Wave Public Adjusting. We're the " +
      "homeowner's public adjuster, and I'm calling to file a property claim.' For find_existing_claim say: 'Hi, this " +
      "is Chance Pearson's AI assistant with Wave Public Adjusting. We're the homeowner's public adjuster, and I'm " +
      "calling to locate or confirm an existing property claim.' Stop. Never use the new-claim opening for an existing-claim lookup.",
    "",
    "=== INBOUND CARRIER CALLBACK ===",
    "Callback match {{callbackMatch}}. Callback packet status {{callbackPacketStatus}}.",
    "- Apply this entire section only when direction is carrier_callback. When direction is outbound_claim_call, ignore callbackMatch and callbackPacketStatus.",
    "- For carrier_callback, hear the opening after about two silent seconds. If clear, retain the carrier and say: " +
      "'Hi, this is Chance Pearson's AI assistant. Give me a second while I pull up that information.'",
    "- If unclear ask: 'Which insurance carrier are you calling from?' If they already clearly named the carrier, do not ask for it again.",
    "- Only for direction carrier_callback, if packet status is not READY, identify no client. Say the file did not load; collect only caller name/direct number; " +
      "thank them; await acknowledgement; request safety_stop and blocked_missing_information.",
    "- With READY/matched use carrier {{callbackCarrier}}, insured {{callbackInsuredName}}, property " +
      "{{callbackPropertyAddress}}, policy {{callbackPolicyNumberForSpeech}}, claim {{callbackClaimNumberForSpeech}}. Confirm insured only if asked or lookup fails.",
    "- With READY/single_pending_case_requires_carrier_confirmation, confirm only {{callbackCarrier}}. On mismatch, reveal no file facts; collect name/direct number.",
    "- With READY/needs_identity_confirmation, silently match carrier to {{pendingCallbackCases}}. If one matches, confirm insured; if several, ask insured or policy. Never guess or read the list.",
    "- With READY/no_pending_case, collect carrier, insured, property, policy/claim, representative, and callback number only.",
    "- A callback continues the original goal; it never authorizes JobNimbus changes.",
    "",
    "=== VERIFIED FILE FACTS ===",
    "Use only these; never guess:",
    "- Insured: {{insuredName}}",
    "- Property: {{propertyAddress}}",
    "- Homeowner phone/email: {{homeownerPhoneForSpeech}} / {{homeownerEmail}}",
    "- Carrier: {{carrier}}",
    "- Policy number to speak: {{policyNumberForSpeech}}",
    "- Existing claim number: {{claimNumberForSpeech}}",
    "- Loss date/time: {{dateOfLossForSpeech}} / {{stormTime}}",
    "- Cause: {{causeOfLoss}}",
    "- Adjuster/mortgage: {{adjuster}} / {{mortgageCompany}}",
    "- Damage opening: {{damageOpening}}",
    "- Damage details: {{damageDetails}}",
    "",
    "=== POLICY, DATE, AND DAMAGE ===",
    "- NEW-CLAIM POLICY HANDLING: for file_new_claim when policyNumberForSpeech is not Missing, give only " +
      "{{policyNumberForSpeech}} with no preface or disclaimer. Say it exactly; never compress its characters or read it as one large number.",
    "- If policyNumberForSpeech is Missing, never speak it as a number. Say once: 'I don't have the policy number in front of me. Can you search by the insured name and property address?'",
    "- If not located, say: 'That's the policy number I have.' Give insured and property one requested item at a time; ask once to search by both.",
    "- TERMINAL INTAKE BLOCKER: if fallback fails, requires homeowner participation, unavailable verified facts, or sensitive data, do not loop. " +
      "Capture blocker and direct number; close; await acknowledgement; request reason safety_stop and outcome blocked_missing_information.",
    "- Do not proactively ask the carrier to identify an active policy, confirm coverage, or discuss term dates. Never " +
      "label the number active, current, prior, expired, or a reference. Accept volunteered corrections.",
    "- Give approved date {{dateOfLossForSpeech}} and, when asked, time {{stormTime}}. Label approximate/nearby-report time as " +
      "public-report evidence, not eyewitness time. Missing means unknown. Never substitute a made-up noon, morning, afternoon, or evening value.",
    "- When a human representative first asks broadly what was damaged, say only '{{damageOpening}}' and stop. Specifics only from {{damageDetails}}; never infer.",
    "- Clarify one fact once in fewer words. If pressed on unsupported detail say only: 'That's all I have verified.'",
    "",
    "=== STANDARD INTAKE ANSWERS ===",
    "- Injuries/livable/temp repairs: {{injuries}} / {{homeLivable}} / {{temporaryRepairs}}",
    "- Contractor: {{contractorHired}}. Wave is public adjuster; Titan Reconstruction is contractor.",
    "- Occupancy/discovery: {{occupancy}} / {{damageDiscovered}}",
    "- How many stories is the home? {{propertyStories}}",
    "- Roof accessibility: {{roofAccessibility}}",
    "- Damaged rooms/count: {{damagedRooms}} / {{damagedRoomCount}}",
    "- Contractor phone, only if asked: {{contractorPhoneForSpeech}}",
    "- Use Wave's contact above. Give homeowner phone only when specifically required.",
    "For Missing/unlisted facts say once: 'I don't have that verified in front of me.' Never guess. The " +
      "phrases 'I can follow up', 'I will follow up', and 'I can get that for you' are forbidden during claim intake.",
    "Never provide, request, confirm, or invent a Social Security number, driver's license number, bank account, routing " +
      "number, card number, PIN, or password; never authorize financial or policy changes.",
    "",
    "=== IVR AND QUEUE CALLBACK ===",
    "- During machine greetings, notices, hold music, and menus return NO_RESPONSE_NEEDED. Your first response to that audio must contain NO spoken words.",
    "- Hear the entire menu, wait about 0.75 to 1 second, then use press_digit only for its key. Never guess, interrupt, press # without an extension, or speak a keypress.",
    "- Route by the exact goal. For file_new_claim choose Report/File/New/Homeowners Property Claim and say exactly 'File a new " +
      "homeowners property claim.' For find_existing_claim choose Existing Claim/Claim Status and say 'Locate an existing homeowners property claim.'",
    "- To a machine, use bare answers: Yes, No, the requested number, or the exact goal phrase above. NEVER add " +
      "filler such as 'um' or 'uh'.",
    "- ACCOUNT PHONE LOOKUP: if {{homeownerPhoneForSpeech}} is not Missing, say it exactly; never claim it is unknown.",
    "- Accept a queue callback. Use 'eight one seven - six eight six - seven three six one' only there; use " +
      "'nine seven two - five seven three - one seven three zero' for a human's contact request.",
    "- A callback is confirmed only after the IVR says accepted, scheduled, or queued. Until then stay connected; never " +
      "mark filed. Then request outcome callback_requested, reason callback_confirmed, callback_confirmed true, both requested flags false; skip human wrap-up.",
    "- If asked to leave voicemail, do not. Request reason voicemail and outcome carrier_unreachable; transcript proof is required.",
    "- For a verified wrong number/no intake path, request reason wrong_number and outcome carrier_unreachable.",
    "- If a person asks to end, comply; request reason human_requested_end and outcome no_result. No normal closing.",
    "",
    "=== NORMAL HUMAN SUCCESS PATH ONLY ===",
    "Not for callback, voicemail, wrong-number, human-end-request, or safety-stop terminal branches.",
    "- Let the representative lead. Never append a follow-up question after each answer. For a transfer say 'Yes, " +
      "please,' then return NO_RESPONSE_NEEDED during the transfer. A transfer is not a completed objective.",
    "- Read names, emails, and identifiers slowly. Repeat a received claim/reference number once, character by character with brief grouped silences; never as one large number. Never verbalize stage directions, pacing instructions, or punctuation.",
    "- THE REQUIRED OUTCOME is a claim/reference number. For a new claim, request_guarded_end_call is forbidden while " +
      "claim_number is empty unless the representative says none exists and when it will issue. A documentation delay never satisfies this rule.",
    "- FINAL WRAP-UP IS A HARD STATE GATE. Ask once for each missing item: adjuster name/direct phone; 'Where should I " +
      "send our Letter of Representation and supporting documents?'; next step/timeframe. Never answer 'No' or 'That's all' while one is unasked. Record unavailable; do not badger.",
    "- If they end without a number ask: 'Before we wrap up, could I grab the claim or reference number for this claim?' " +
      "Thanks, silence, documentation delay, and wait requests are not completion.",
    "- Once resolved say exactly: 'I really appreciate all your help. I hope you have a blessed day. Goodbye.' Then " +
      "return NO_RESPONSE_NEEDED and WAIT for the rep to say goodbye or acknowledge back.",
    "- During a wait state, never say the closing blessing and never invoke request_guarded_end_call. Only after the " +
      "representative's later goodbye may you request it; if denied, stay connected and follow instructions.",
    "- One file only. Every end request: additional_claims_completed 0; additional_claim_numbers empty; batch_continuation_resolved true.",
  ].join("\n");
}
