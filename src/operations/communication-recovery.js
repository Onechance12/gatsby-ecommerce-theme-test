const SCHEDULING_PATTERN = /\b(?:appointment|inspection|inspect(?:or|ion)?|schedule|scheduling|reschedule|arrival|eta|meet(?:ing)?|availability|access|reinspection|apprais(?:al|er))\b/i;
const ETA_UPDATE_PATTERN = /\b(?:adjuster|inspector|appraiser)\b.{0,100}\b(?:arriv(?:e|al|ing)|eta|show(?:ing)? up|be (?:here|there)|(?:at|around) \d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i;
const CALLBACK_PATTERN = /\b(?:call(?:ed|ing)?|call back|callback|return (?:my|the) call|trying to (?:reach|contact)|voicemail|missed call|left (?:a )?message)\b/i;
const CLAIM_PATTERN = /\b(?:claim|policy|loss|carrier|adjuster|insurance|scope|estimate|payment|check|letter of representation|\blor\b)\b/i;

export function buildCommunicationRecoveryQueue(items = [], files = []) {
  const preparedFiles = files.map(prepareFile);
  const surnameCounts = countBy(preparedFiles, (file) => file.lastName);
  const newestAt = Math.max(0, ...items.map((item) => Date.parse(String(item.atUtc || item.at || ""))).filter(Number.isFinite));
  const queue = items
    .map((item) => recoverItem(item, preparedFiles, surnameCounts, newestAt))
    .sort((a, b) => b.priority - a.priority || String(b.atUtc).localeCompare(String(a.atUtc)));

  return {
    total: queue.length,
    matched: queue.filter((item) => item.match).length,
    unmatched: queue.filter((item) => !item.match).length,
    appointmentCandidates: queue.filter((item) => ["appointment_eta_update", "appointment_scheduling"].includes(item.classification)).length,
    callbackCandidates: queue.filter((item) => item.classification === "callback_required").length,
    queue
  };
}

function recoverItem(item, files, surnameCounts, newestAt) {
  const text = communicationText(item);
  const scored = files
    .map((file) => scoreFile(text, item, file, surnameCounts))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];
  const decisive = best && best.score >= 50 && (!runnerUp || best.score - runnerUp.score >= 15);
  const classification = classify(item, text);
  const priority = communicationPriority(item, classification, decisive ? best.score : 0, newestAt);

  return {
    ...item,
    classification,
    priority,
    match: decisive ? {
      confidence: best.score >= 90 ? "high" : "medium",
      score: best.score,
      reasons: best.reasons,
      file: best.file.source
    } : null,
    possibleMatches: decisive ? [] : scored.slice(0, 3).map((candidate) => ({
      score: candidate.score,
      reasons: candidate.reasons,
      file: candidate.file.source
    })),
    reviewRequired: !decisive || ["appointment_eta_update", "appointment_scheduling", "callback_required"].includes(classification)
  };
}

function scoreFile(text, item, file, surnameCounts) {
  let score = 0;
  const reasons = [];
  const compactText = alnum(text);
  const phoneText = digits(`${item.participant || ""} ${text}`);
  const add = (points, reason) => { score += points; reasons.push(reason); };

  if (file.claimNumber && compactText.includes(file.claimNumber)) add(120, "claim number");
  if (file.policyNumber && compactText.includes(file.policyNumber)) add(105, "policy number");
  if (file.phone && phoneText.includes(file.phone)) add(95, "phone number");
  if (file.adjusterPhone && phoneText.includes(file.adjusterPhone)) add(90, "adjuster phone");
  if (file.number && numberToken(text, file.number)) add(85, "JobNimbus number");
  if (file.addressLine && normalizeText(text).includes(file.addressLine)) add(80, "property address");
  if (file.fullName && normalizeText(text).includes(file.fullName)) add(70, "insured name");
  if (file.email && normalizeText(text).includes(file.email)) add(65, "insured email");
  if (file.lastName && surnameCounts.get(file.lastName) === 1 && wordToken(text, file.lastName)) add(35, "unique insured surname");

  return { score, reasons, file };
}

function classify(item, text) {
  if (ETA_UPDATE_PATTERN.test(text)) return "appointment_eta_update";
  if (SCHEDULING_PATTERN.test(text)) return "appointment_scheduling";
  if (CALLBACK_PATTERN.test(text) || item.type === "missed_call" || item.type === "voicemail") return "callback_required";
  if (CLAIM_PATTERN.test(text)) return "claim_follow_up";
  return "general_inbound";
}

function communicationPriority(item, classification, matchScore, newestAt) {
  let priority = classification === "appointment_eta_update" ? 130
    : classification === "appointment_scheduling" ? 100
    : classification === "callback_required" ? 80
      : classification === "claim_follow_up" ? 55
        : 30;
  if (item.type === "voicemail") priority += 15;
  if (item.type === "missed_call") priority += 10;
  if (!matchScore) priority += 8;
  if (matchScore >= 90) priority += 5;
  const at = Date.parse(String(item.atUtc || item.at || ""));
  const ageHours = Number.isFinite(at) && newestAt > 0 ? Math.max(0, (newestAt - at) / 3600000) : Infinity;
  if (ageHours <= 24) priority += 20;
  else if (ageHours <= 72) priority += 10;
  return priority;
}

function prepareFile(file = {}) {
  const fullName = normalizeText(file.name);
  const nameParts = fullName.split(" ").filter(Boolean);
  return {
    source: file,
    number: String(file.number || "").trim(),
    fullName,
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
    addressLine: normalizeText(String(file.address || "").split(",")[0]),
    phone: digits(file.phone).slice(-10),
    adjusterPhone: digits(file.adjusterPhone).slice(-10),
    email: normalizeText(file.email),
    claimNumber: alnum(file.claimNumber),
    policyNumber: alnum(file.policyNumber)
  };
}

function communicationText(item = {}) {
  return [
    item.from,
    item.to,
    item.subject,
    item.snippet,
    item.text,
    item.transcript,
    item.voicemail,
    item.participant,
    item.line
  ].filter(Boolean).join(" ");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9@.+# -]+/g, " ").replace(/\s+/g, " ").trim();
}

function alnum(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function numberToken(text, number) {
  return new RegExp(`(?:#|job(?:nimbus)?\\s*(?:#|number)?\\s*)${escapeRegex(number)}\\b`, "i").test(String(text || ""));
}

function wordToken(text, word) {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(String(text || ""));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countBy(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = selector(row);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
