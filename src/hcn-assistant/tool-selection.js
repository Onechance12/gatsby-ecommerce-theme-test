const EXACT_FILE_TOOL_INTENTS = Object.freeze([
  Object.freeze({
    tools: Object.freeze([
      "read_file_document_catalog",
      "read_file_document"
    ]),
    intent: /(?:\b(?:read|review|open|show|find|check|inspect|analy[sz]e|summarize|pull\s+up|look\s+at)\b[\s\S]{0,80}\b(?:attachment|attachments|document|documents|policy|declaration|declarations|dec\s*page|estimate|scope|settlement|letter\s+of\s+representation|lor)\b)|(?:\b(?:what\s+does|what(?:'s|\s+is)\s+in)\b[\s\S]{0,60}\b(?:document|policy|declaration|dec\s*page|estimate|scope|settlement|lor)\b)|(?:\b(?:document|policy|declaration|dec\s*page|estimate|scope|settlement|lor)\b[\s\S]{0,60}\b(?:say|show|contain|include)\b)/i,
    negated: /\b(?:do\s+not|don['’]?t|dont|no\s+need\s+to|without|skip|avoid)\b[\s\S]{0,80}\b(?:attachment|attachments|document|documents|policy|declaration|declarations|dec\s*page|estimate|scope|settlement|letter\s+of\s+representation|lor)\b/i
  }),
  Object.freeze({
    tools: Object.freeze(["read_file_photo_catalog"]),
    intent: /\b(?:read|review|open|show|find|check|inspect|analy[sz]e|pull\s+up|look\s+at)\b[\s\S]{0,80}\b(?:photo|photos|image|images|picture|pictures)\b/i,
    negated: /\b(?:do\s+not|don['’]?t|dont|no\s+need\s+to|without|skip|avoid)\b[\s\S]{0,80}\b(?:photo|photos|image|images|picture|pictures)\b/i
  }),
  Object.freeze({
    tools: Object.freeze(["research_file_hail_dates"]),
    intent: /(?:\b(?:research|find|check|show|review|analy[sz]e|look\s+up)\b[\s\S]{0,80}\b(?:hail|storm|weather|date\s+of\s+loss|dol)\b)|(?:\b(?:what|when)\b[\s\S]{0,60}\b(?:date\s+of\s+loss|hail|storm)\b)/i,
    negated: /\b(?:do\s+not|don['’]?t|dont|no\s+need\s+to|without|skip|avoid)\b[\s\S]{0,80}\b(?:hail|storm|weather|date\s+of\s+loss|dol)\b/i
  }),
  Object.freeze({
    tools: Object.freeze(["read_calendar_day"]),
    intent: /(?:\b(?:check|show|review|open|read|find|look\s+at)\b[\s\S]{0,80}\b(?:calendar|schedule|appointment|availability)\b)|(?:\b(?:when|what\s+time)\b[\s\S]{0,60}\b(?:appointment|inspection|schedule)\b)/i,
    negated: /\b(?:do\s+not|don['’]?t|dont|no\s+need\s+to|without|skip|avoid)\b[\s\S]{0,80}\b(?:calendar|schedule|appointment|availability)\b/i
  })
]);

const SWEEP_TOOL_NAMES = Object.freeze([
  "run_management_sweep",
  "read_closed_file_benchmark"
]);

/**
 * Select only the read tools explicitly requested for the current exact-file
 * turn. A mention of a document or appointment is not authority to retrieve
 * more provider evidence, and a negated request always remains closed.
 */
export function hcnAssistantAvailableToolNames({
  prompt,
  conversationKind
} = {}) {
  const text = String(prompt || "");
  if (conversationKind === "general") {
    return Object.freeze([]);
  }
  if (conversationKind === "sweep") {
    return SWEEP_TOOL_NAMES;
  }
  if (conversationKind !== "file") {
    return Object.freeze([]);
  }
  const selected = [];
  for (const rule of EXACT_FILE_TOOL_INTENTS) {
    if (rule.negated.test(text) || !rule.intent.test(text)) continue;
    for (const name of rule.tools) {
      if (!selected.includes(name)) selected.push(name);
    }
  }
  return Object.freeze(selected);
}
