export const CLIENT_COORDINATOR_MODES = [
  "appointment_confirmation",
  "missing_document_request",
  "status_update",
  "client_check_in"
];

export const CLIENT_COORDINATOR_REMINDER_TOPICS = [
  "process_timing",
  "titan_role",
  "part_b_scope"
];

export function buildClientCoordinatorConversation(input = {}) {
  const mode = String(input.mode || "appointment_confirmation").trim().toLowerCase();
  if (!CLIENT_COORDINATOR_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${CLIENT_COORDINATOR_MODES.join(", ")}`);
  }

  const firstName = clean(input.firstName) || "there";
  const opening = `Hey ${firstName}, this is Chance's AI assistant. How are you doing today?`;
  const reminderTopics = normalizeReminderTopics(input.reminderTopics);
  const reminderGuidance = reminderTopics
    .map((topic) => clean(input.reminderRules?.[topic]))
    .filter(Boolean)
    .join("\n");
  const approvedContext = clean(input.approvedContext).slice(0, 1600) || "No additional context is approved for discussion.";

  let purpose;
  let fallbackText;
  let accessRequirement = "No access requirement is part of this call.";

  if (mode === "appointment_confirmation") {
    const date = requireText(input.appointmentDate, "appointmentDate");
    const window = requireText(input.appointmentWindow, "appointmentWindow");
    accessRequirement = input.interiorAccessRequired === false
      ? "Interior access is not required for this appointment."
      : "Interior access is required. Confirm that the homeowner or another adult can provide access.";
    purpose = `So I'm calling because we have an adjuster appointment scheduled ${date}, between ${window}. Will you or another adult be available to meet Chance and the adjuster?`;
    fallbackText = `Hi ${firstName}, this is Chance's assistant. We have an adjuster appointment scheduled ${date}, between ${window}. Will you or another adult be available${input.interiorAccessRequired === false ? "" : " to provide interior access"}?`;
  } else if (mode === "missing_document_request") {
    const documentNeeded = requireText(input.documentNeeded, "documentNeeded");
    purpose = `So I'm calling because we still need ${documentNeeded}. Do you have a copy you can text or email to us?`;
    fallbackText = `Hi ${firstName}, this is Chance's assistant. Could you please send us ${documentNeeded} when you get a chance? You can text or email it to us.`;
  } else if (mode === "status_update") {
    const statusUpdate = requireText(input.statusUpdate, "statusUpdate");
    purpose = `So I'm calling to give you a quick update: ${statusUpdate}`;
    fallbackText = `Hi ${firstName}, this is Chance's assistant. Quick update: ${statusUpdate}`;
  } else {
    const checkInReason = clean(input.checkInReason) || "I wanted to check in, see how you are doing, and find out whether you have any questions for us.";
    purpose = `So I'm calling because ${checkInReason}`;
    fallbackText = `Hi ${firstName}, this is Chance's assistant. I tried to reach you for a quick check-in. No rush; we can follow up by text or phone.`;
  }

  return {
    mode,
    opening,
    purpose,
    fallbackText,
    accessRequirement,
    approvedContext,
    reminderTopics,
    reminderGuidance: reminderGuidance || "No Three Client Reminder topic is approved for this call."
  };
}

export function buildClientCoordinatorLlmConfig() {
  return {
    general_prompt: renderClientCoordinatorPrompt(),
    begin_message: "",
    general_tools: [
      {
        type: "end_call",
        name: "end_call",
        description: "End the call after the approved objective is complete, the client asks to stop, voicemail answers, or a safety boundary is reached.",
        speak_after_execution: false
      }
    ]
  };
}

export function renderClientCoordinatorPrompt() {
  return [
    "=== CHANCE CLIENT COORDINATOR ===",
    "You are Chance Pearson's AI client-coordination assistant for existing property-claim clients. You are not Chance, Andrea, the homeowner, an insurance adjuster, or an attorney. Never impersonate Andrea. If asked, clearly confirm that you are an AI assistant.",
    "This call has exactly one approved purpose. Do not broaden it, negotiate coverage, give legal or policy advice, discuss settlement strategy, promise approval, promise payment, or make a coverage determination. Never claim to have checked JobNimbus, Gmail, Quo, or a document during the live call.",
    "PRIVACY: Do not reveal the property, carrier, claim, policy, damage, or appointment details until the intended client is reasonably confirmed. If someone else answers, ask only for {{homeownerFirstName}}. If it is a wrong number, apologize, use end_call, and disclose nothing else.",
    "OPENING: Wait for a person to say hello. Then say exactly: {{coordinatorOpening}} Listen to the answer and respond naturally in one short sentence. For a positive answer, say something like 'I'm glad to hear that.' For a difficult answer, acknowledge it with something like 'I'm sorry to hear that.' Do not sound scripted, overdo small talk, or skip their answer. Then say exactly: {{coordinatorPurpose}}",
    "APPROVED PURPOSE: {{coordinatorMode}}. Complete only that purpose. Access rule: {{appointmentAccessRequirement}}",
    "APPROVED CONTEXT: {{coordinatorApprovedContext}} This context is a ceiling, not a script. Use it only to answer a directly related question. If the answer is not in the approved context, say you do not want to give the wrong answer and that Chance or Andrea will follow up.",
    "THREE CLIENT REMINDERS: Only the following reminder topics are approved for this call: {{coordinatorReminderTopics}}. Internal guidance: {{coordinatorReminderGuidance}} Use a reminder conversationally only when it fits the client's question or concern. Never recite all reminders mechanically. Never blame an individual carrier representative or guarantee an outcome.",
    "CONVERSATION STYLE: Be warm, patient, brief, and human-sounding. Acknowledge grief, illness, frustration, or inconvenience without probing. Do not repeat the same question or say filler such as 'let me know when you are ready' over and over. During silence, wait. A short 'Okay' is enough when the client is thinking.",
    "APPOINTMENTS: You may confirm the supplied date, arrival window, and access need. If the client is unavailable, gather alternative availability but do not promise or create a new appointment. Do not invent an arrival time or inspector ETA.",
    "DOCUMENTS: You may request only the document named in the approved purpose. Do not ask for passwords, payment data, Social Security numbers, bank information, login codes, or unrelated identity documents.",
    "ESCALATION: Capture the client's question or concern accurately. Route coverage, deductible, contract, payment, cancellation, complaint, legal, emergency, and claim-strategy questions to Chance or Andrea. If there is an active emergency or threat to safety, tell the client to contact emergency services or the appropriate emergency provider, then end the call.",
    "OUTBOUND SAFETY: This call cannot send a text or email, update JobNimbus, schedule an event, or create a task. Never claim one of those actions happened. If the client asks for written follow-up, acknowledge the request and capture it for review.",
    "OPT OUT: If the client asks not to receive automated calls, apologizes that the timing is bad, or asks to stop, acknowledge it, do not persuade them, capture the request, and end the call.",
    "VOICEMAIL/AUTOMATION: Do not leave a voicemail and do not speak to an automated system. Use end_call. A separately approved Quo text may be considered after the result is reviewed.",
    "CLOSE: Once the objective is complete, summarize only the commitment or confirmation actually made. Thank the client, say Chance or Andrea will follow up if needed, and use end_call."
  ].join("\n\n");
}

export function clientCoordinatorAnalysisSchema() {
  return [
    {
      type: "enum",
      name: "contact_outcome",
      description: "How the call ended.",
      choices: ["connected", "voicemail_or_automated", "no_answer", "wrong_number", "disconnected", "other"]
    },
    {
      type: "enum",
      name: "objective_completed",
      description: "Whether the approved call objective was completed.",
      choices: ["yes", "partial", "no"]
    },
    { type: "boolean", name: "appointment_confirmed", description: "True only if the client confirmed the supplied appointment date/window." },
    { type: "boolean", name: "interior_access_confirmed", description: "True only if the client confirmed that an adult can provide required interior access." },
    { type: "string", name: "alternative_availability", description: "Alternative dates or times the client offered. Empty if none." },
    { type: "string", name: "document_commitment", description: "What document the client agreed to send, by what channel, and when. Empty if none." },
    { type: "string", name: "client_questions", description: "Concise list of questions the client asked that need review. Empty if none." },
    { type: "string", name: "client_concerns", description: "Concise client concerns, complaints, hardship, or expectation issues. Empty if none." },
    {
      type: "enum",
      name: "preferred_contact_method",
      description: "The contact method the client explicitly preferred.",
      choices: ["text", "phone", "email", "unspecified"]
    },
    { type: "boolean", name: "written_follow_up_requested", description: "True only when the client requested a text or email follow-up." },
    { type: "boolean", name: "opt_out_requested", description: "True when the client asked not to receive automated calls or asked that calls stop." },
    { type: "string", name: "reminders_used", description: "Comma-separated reminder topics actually discussed. Empty if none." },
    { type: "string", name: "follow_up_needed", description: "Exact human follow-up needed from Chance or Andrea. Empty when none." }
  ];
}

export function extractClientCoordinatorResult(call = {}) {
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
    structured: {
      contactOutcome: data.contact_outcome || "",
      objectiveCompleted: data.objective_completed || "",
      appointmentConfirmed: data.appointment_confirmed === true,
      interiorAccessConfirmed: data.interior_access_confirmed === true,
      alternativeAvailability: data.alternative_availability || "",
      documentCommitment: data.document_commitment || "",
      clientQuestions: data.client_questions || "",
      clientConcerns: data.client_concerns || "",
      preferredContactMethod: data.preferred_contact_method || "unspecified",
      writtenFollowUpRequested: data.written_follow_up_requested === true,
      optOutRequested: data.opt_out_requested === true,
      remindersUsed: data.reminders_used || "",
      followUpNeeded: data.follow_up_needed || ""
    }
  };
}

function normalizeReminderTopics(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item || "").trim().toLowerCase()))]
    .filter((item) => CLIENT_COORDINATOR_REMINDER_TOPICS.includes(item));
}

function requireText(value, name) {
  const text = clean(value);
  if (!text) throw new Error(`${name} is required for this client-coordinator mode`);
  return text;
}

function clean(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
