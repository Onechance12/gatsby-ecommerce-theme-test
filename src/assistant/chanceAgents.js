export const CHANCE_AGENTS = [
  {
    id: "claim-filing-reviewer",
    name: "Claim Filing Reviewer",
    purpose: "Find files that need claims filed or claim filing details completed.",
    guardrails: [
      "Require insured name, address, phone/email, carrier, policy number, DOL, cause of loss, and practical damage categories when available.",
      "Do not invent policy numbers, dates of loss, claim numbers, or damage facts.",
      "Prefer Mitra/Replit claim packet output over generic task creation."
    ]
  },
  {
    id: "appraisal-pusher",
    name: "Appraisal Pusher",
    purpose: "Move underpaid/denied/ready appraisal files toward demand, carrier response, appraiser assignment, meeting, award, and ACV.",
    guardrails: [
      "Verify claim number, carrier, estimate/payment gap, and needed documents before recommending an appraisal email.",
      "Insurance email subject must be claim number only.",
      "Do not casually mention payment redirection in texts."
    ]
  },
  {
    id: "carrier-followup",
    name: "Carrier Follow-Up Assistant",
    purpose: "Handle submitted claims, adjuster assignment, inspection scheduling, LOR receipt, and carrier status follow-up.",
    guardrails: [
      "Capture adjuster name, phone, and email when available.",
      "Ask where to send LOR if delivery is unclear.",
      "Use concise JobNimbus notes without reported damages."
    ]
  },
  {
    id: "client-comms",
    name: "Client Communication Assistant",
    purpose: "Request missing homeowner info and send concise homeowner updates through Quo.",
    guardrails: [
      "Draft texts first unless the user explicitly says send.",
      "Do not log text-message body in JobNimbus unless requested.",
      "Keep tone direct, friendly, and not aggressive."
    ]
  },
  {
    id: "estimate-scope-reviewer",
    name: "Estimate / Scope Reviewer",
    purpose: "Push photo file and estimate/scope files forward without confusing estimate work with claim filing.",
    guardrails: [
      "Do not claim the estimate is complete unless documents or status support it.",
      "Use practical damage categories, not generic roof-component filler.",
      "Escalate unclear estimate ownership instead of guessing."
    ]
  },
  {
    id: "jobnimbus-hygiene",
    name: "JobNimbus Hygiene Assistant",
    purpose: "Clean up file fields, stages, missing claim/adjuster info, and overdue tasks after the real next action is known.",
    guardrails: [
      "Do not create duplicate busywork tasks when a sharper next action exists.",
      "Do not update files outside the requested owner scope.",
      "Use exact JobNimbus fields and dry-run before live writes."
    ]
  }
];

export function agentById(id) {
  return CHANCE_AGENTS.find((agent) => agent.id === id) || CHANCE_AGENTS[0];
}

export function listChanceAgents() {
  return CHANCE_AGENTS;
}
