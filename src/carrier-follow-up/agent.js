export const CARRIER_FOLLOW_UP_GOALS = [
  "adjuster_assignment",
  "claim_status",
  "appointment_confirmation",
  "inspector_eta",
  "document_receipt",
  "document_destination",
  "generic_information"
];

export const CARRIER_DESTINATION_TYPES = [
  "carrier_general_line",
  "desk_adjuster",
  "field_inspector",
  "scheduler",
  "independent_adjusting_company"
];

const GOAL_QUESTIONS = {
  adjuster_assignment: [
    "Confirm the claim is active.",
    "Obtain the assigned desk adjuster's name, direct phone number, and email address.",
    "If a field inspector is assigned, obtain that person's name, company, and direct phone number separately."
  ],
  claim_status: [
    "Confirm the current carrier status and the next action expected from the carrier.",
    "Obtain the responsible desk adjuster's direct contact information if it is missing.",
    "Ask for the carrier's expected follow-up timeframe."
  ],
  appointment_confirmation: [
    "Confirm the supplied inspection date and carrier arrival window.",
    "Confirm whether interior access is required.",
    "Obtain the current field inspector's name, company, and direct phone number separately from the desk adjuster."
  ],
  inspector_eta: [
    "Confirm the field inspector is still assigned to today's inspection.",
    "Ask for the best current estimated arrival time within the supplied carrier window.",
    "Confirm the best direct callback number for day-of coordination."
  ],
  document_receipt: [
    "Confirm whether the listed representation documents were received and associated with the claim.",
    "Confirm whether the carrier recognizes the public-adjuster representation.",
    "If anything is missing, obtain the correct submission destination and subject/reference rule."
  ],
  document_destination: [
    "Obtain the correct email address, portal, fax number, or upload instructions for representation documents.",
    "Confirm the required subject line or claim-number formatting.",
    "Ask whether documents sent there will route to the assigned desk adjuster."
  ],
  generic_information: [
    "Ask only the exact approved questions supplied for this call.",
    "Capture the representative's name, department, direct callback number, and the carrier's next step."
  ]
};

export function buildCarrierFollowUpConversation(input = {}) {
  const goal = clean(input.goal || "adjuster_assignment").toLowerCase();
  const destinationType = clean(input.destinationType || "carrier_general_line").toLowerCase();
  if (!CARRIER_FOLLOW_UP_GOALS.includes(goal)) {
    throw new Error(`goal must be one of ${CARRIER_FOLLOW_UP_GOALS.join(", ")}`);
  }
  if (!CARRIER_DESTINATION_TYPES.includes(destinationType)) {
    throw new Error(`destinationType must be one of ${CARRIER_DESTINATION_TYPES.join(", ")}`);
  }

  const contactName = clean(input.contactName);
  const approvedQuestions = uniqueLines([
    ...(GOAL_QUESTIONS[goal] || []),
    ...normalizeQuestions(input.approvedQuestions)
  ]).slice(0, 12);
  if (goal === "generic_information" && approvedQuestions.length < 3) {
    throw new Error("approvedQuestions is required for generic_information calls");
  }

  const directContact = ["desk_adjuster", "field_inspector", "scheduler", "independent_adjusting_company"].includes(destinationType);
  const opening = directContact && contactName
    ? `Hi ${firstName(contactName)}, this is Chance Pearson's AI assistant with Wave Public Adjusting. How are you today?`
    : "Hi, this is Chance Pearson's AI assistant with Wave Public Adjusting, calling about an existing property claim.";

  return {
    goal,
    destinationType,
    contactName,
    opening,
    approvedQuestions,
    schedulingAuthority: input.schedulingAuthority === true ? "ALLOWED" : "NOT_ALLOWED",
    approvedSchedulingOptions: normalizeQuestions(input.approvedSchedulingOptions).slice(0, 8)
  };
}

export function buildCarrierFollowUpLlmConfig() {
  return {
    general_prompt: renderCarrierFollowUpPrompt(),
    begin_message: "",
    start_speaker: "user",
    general_tools: [
      {
        type: "press_digit",
        name: "press_digit",
        description: "Press the exact keypad digit requested by a carrier IVR. Listen to the complete menu before choosing and never guess a digit."
      },
      {
        type: "end_call",
        name: "end_call",
        description: "End only after the approved information-gathering objective is complete, the destination is verified wrong, the representative asks to end, or continuing would require prohibited information or authority.",
        speak_after_execution: false
      }
    ]
  };
}

export function buildCarrierFollowUpAgentSettings() {
  return {
    responsiveness: 0.55,
    interruption_sensitivity: 0.35,
    reminder_trigger_ms: 30000,
    reminder_max_count: 2,
    end_call_after_silence_ms: 90000,
    max_call_duration_ms: 1800000,
    ambient_sound: "call-center",
    ambient_sound_volume: 0.2,
    voicemail_option: { action: { type: "hangup" } }
  };
}

export function renderCarrierFollowUpPrompt() {
  return [
    "=== WAVE CARRIER FOLLOW-UP ASSISTANT ===",
    "You are Chance Pearson's AI assistant with Wave Public Adjusting. You call insurance carriers, desk adjusters, field inspectors, schedulers, and independent adjusting companies to gather verified operational information for an existing property claim. You are not Chance, the homeowner, a carrier adjuster, an attorney, or a human. If asked, clearly say you are an AI assistant.",
    "ONE APPROVED GOAL: {{callGoal}}. DESTINATION ROLE: {{destinationType}}. Complete only that goal and the approved questions. Do not broaden the call, negotiate coverage or price, debate causation, demand payment, invoke appraisal, give legal advice, make a coverage determination, or promise any outcome.",
    "VERIFIED FILE FACTS: Carrier: {{carrier}}. Insured: {{insuredName}}. Property: {{propertyAddress}}. Policy: {{policyNumber}}. Claim: {{claimNumber}}. Date of loss: {{dateOfLoss}}. JobNimbus file: {{jobNumber}}. Use only these facts. If a fact says Missing or Unknown, do not invent it.",
    "KNOWN CONTACTS: Desk adjuster: {{deskAdjuster}}. Field inspector: {{fieldInspector}}. Inspector company: {{inspectorCompany}}. These are distinct roles. Never save, repeat, or describe Chance Pearson's phone or email as the carrier adjuster's contact information.",
    "OPENING: Wait for a person to answer. For a named direct contact, say exactly: {{carrierFollowUpOpening}} Listen to the answer and respond naturally in one short sentence before stating the purpose. For a general carrier line or IVR, identify yourself briefly and state the approved goal without extended small talk.",
    "IVR: Listen to each complete menu before answering or pressing a digit. Use press_digit only for the exact option the IVR announced. Do not click early, guess, bounce among menus, or repeat an answer while the IVR is still speaking. Use 'existing claim' for follow-up work. Use 'new claim' only when the approved goal explicitly says claim filing, which this agent normally does not handle.",
    "APPROVED QUESTIONS: {{approvedQuestions}} Ask one question at a time. Capture names, roles, direct phone numbers, emails, dates, windows, destinations, and reference numbers slowly and confirm ambiguous letters or digits once.",
    "APPOINTMENT: Existing appointment: {{appointmentDateTime}}. Carrier arrival window: {{appointmentWindow}}. Interior access: {{interiorAccess}}. You may confirm these supplied facts. Scheduling authority is {{schedulingAuthority}}. If it is NOT_ALLOWED, do not schedule, cancel, or reschedule. You may gather proposed options only. If it is ALLOWED, use only these approved options: {{approvedSchedulingOptions}}. Never invent availability or an ETA.",
    "DOCUMENTS: Documents reportedly sent: {{documentsSent}}. Known destination: {{documentDestination}}. Confirm actual receipt or obtain the correct destination. Do not claim a document was sent merely because it was planned or drafted.",
    "CONVERSATION: Be calm, concise, professional, and human-sounding. Do not repeat 'let me know,' 'take your time,' the call purpose, or the same damage facts. When the representative is typing or thinking, say 'Okay' once and remain silent. After about 30 seconds of unexplained silence, say 'Just making sure we're still connected.' If another long silence follows, use that line once more after about 60 seconds. Do not narrate your internal process.",
    "LOOKUP: If you need an approved supplied fact, say 'Give me a second while I pull up that information.' Then use only the dynamic facts already supplied to this call. This call cannot freely browse, change the file, or retrieve unrelated clients.",
    "SECURITY: Never provide or request bank details, card numbers, Social Security numbers, passwords, PINs, login codes, driver's-license numbers, or unrelated personal identifiers. If required to continue, explain that Chance will follow up through an approved channel and end the call.",
    "NO WRITEBACK: You cannot update JobNimbus, send an email, send a Quo text, upload a document, create a task, or create a calendar event during this call. Never claim that any of those actions occurred. Gather facts for later human review only.",
    "CLOSE: Before ending, confirm only the critical result: claim/reference number, responsible contact, appointment/window or ETA, document destination/receipt, and carrier next step as applicable. Thank the representative and end the call."
  ].join("\n\n");
}

export function carrierFollowUpAnalysisSchema() {
  return [
    { type: "enum", name: "follow_up_outcome", description: "Primary verified outcome.", choices: ["completed", "partial", "no_answer", "voicemail", "wrong_destination", "blocked_missing_information", "disconnected", "no_result"] },
    { type: "string", name: "claim_number", description: "Carrier-confirmed claim or reference number. Empty if not confirmed." },
    { type: "string", name: "representative_name", description: "Name of the person who handled the call." },
    { type: "string", name: "representative_department", description: "Representative's carrier department or role." },
    { type: "string", name: "desk_adjuster_name", description: "Assigned desk adjuster only; never the PA or field inspector." },
    { type: "string", name: "desk_adjuster_phone", description: "Verified desk adjuster direct phone." },
    { type: "string", name: "desk_adjuster_email", description: "Verified desk adjuster email." },
    { type: "string", name: "field_inspector_name", description: "Current field inspector only; keep separate from desk adjuster." },
    { type: "string", name: "field_inspector_company", description: "Field inspector or ladder-assist company." },
    { type: "string", name: "field_inspector_phone", description: "Verified field inspector direct phone." },
    { type: "string", name: "field_inspector_email", description: "Verified field inspector email." },
    { type: "boolean", name: "appointment_confirmed", description: "True only when the supplied appointment was explicitly confirmed." },
    { type: "string", name: "appointment_date", description: "Confirmed inspection date." },
    { type: "string", name: "appointment_window", description: "Confirmed carrier arrival window." },
    { type: "string", name: "estimated_arrival_time", description: "Verified narrower day-of ETA. Empty if none." },
    { type: "string", name: "inspection_scope", description: "Exterior/interior/reinspection scope stated by carrier." },
    { type: "string", name: "access_requirements", description: "Verified access requirement." },
    { type: "boolean", name: "representation_recognized", description: "True only when the carrier confirms representation is associated with the claim." },
    { type: "string", name: "documents_received", description: "Documents the carrier explicitly confirmed receiving." },
    { type: "string", name: "document_submission", description: "Verified email, portal, fax, subject rule, or upload instruction." },
    { type: "string", name: "carrier_next_step", description: "Carrier's stated next action." },
    { type: "string", name: "follow_up_timeframe", description: "Carrier's stated follow-up timeframe." },
    { type: "string", name: "callback_phone", description: "Verified callback number for the responsible contact." },
    { type: "string", name: "blocking_reason", description: "What prevented completion. Empty when completed." },
    { type: "string", name: "proposed_change", description: "Any proposed appointment change. This is not an approved or completed schedule change." }
  ];
}

export function extractCarrierFollowUpResult(call = {}) {
  const analysis = call.call_analysis || call.callAnalysis || {};
  const data = analysis.custom_analysis_data || {};
  return {
    callId: call.call_id || call.callId || "",
    status: call.call_status || call.status || "",
    disconnectionReason: call.disconnection_reason || call.disconnectionReason || "",
    durationMs: Number(call.duration_ms || call.durationMs || 0),
    transcript: call.transcript || "",
    summary: analysis.call_summary || call.summary || "",
    successful: analysis.call_successful ?? call.successful ?? null,
    structured: Object.fromEntries(carrierFollowUpAnalysisSchema().map((field) => {
      const value = data[field.name];
      return [field.name, field.type === "boolean" ? value === true : String(value || "")];
    }))
  };
}

function normalizeQuestions(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map(clean).filter(Boolean);
}

function uniqueLines(lines) {
  return [...new Set(lines.map(clean).filter(Boolean))];
}

function firstName(value) {
  return clean(value).split(/\s+/)[0] || "there";
}

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
