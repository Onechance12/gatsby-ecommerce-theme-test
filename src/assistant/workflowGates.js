export function evaluateWorkflowGates(review, overlayEntry = null) {
  const file = review.file;
  const evidenceText = buildEvidenceText(review, overlayEntry);
  const checks = [];

  addCheck(checks, "Claim number", Boolean(clean(file.claimNumber)), file.claimNumber || "");
  addCheck(checks, "Adjuster/contact destination", hasAdjusterDestination(file, evidenceText), adjusterEvidence(file, evidenceText));
  addCheck(checks, "LOR sent evidence", hasLorSentEvidence(evidenceText), findEvidence(evidenceText, LOR_SENT_PATTERNS));
  addCheck(checks, "Estimate/scope document", hasEstimateDocument(file), findDocument(file, ESTIMATE_DOC_PATTERNS)?.name || "");
  addCheck(checks, "Signed PA/TDI/contract document", hasRepresentationDocument(file), findDocument(file, REPRESENTATION_DOC_PATTERNS)?.name || "");

  const carrierContactStage = isCarrierContactStage(file);
  const blockers = carrierContactStage ? checks.filter((check) => check.status === "missing").map((check) => check.name) : [];
  const gate = {
    name: "Carrier/adjuster contact gate",
    purpose: "Do not mark a filed claim as follow-up/cleanup until carrier document delivery has evidence.",
    status: carrierContactStage ? (blockers.length ? "blocked" : "clear") : "informational",
    checks,
    blockers,
    nextRequiredAction: ""
  };

  if (carrierContactStage && clean(file.claimNumber) && hasAdjusterEmail(file) && !hasLorSentEvidence(evidenceText)) {
    gate.status = "blocked";
    gate.nextRequiredAction = "Send LOR to adjuster before treating the file as follow-up.";
  } else if (carrierContactStage && clean(file.claimNumber) && !hasAdjusterDestination(file, evidenceText)) {
    gate.status = "blocked";
    gate.nextRequiredAction = "Find carrier/adjuster LOR destination before treating the file as follow-up.";
  } else if (carrierContactStage && clean(file.claimNumber) && hasAdjusterDestination(file, evidenceText) && !hasLorSentEvidence(evidenceText)) {
    gate.status = "blocked";
    gate.nextRequiredAction = "Submit/upload LOR and required claim docs before treating the file as follow-up.";
  } else if (carrierContactStage && clean(file.claimNumber) && hasLorSentEvidence(evidenceText)) {
    gate.nextRequiredAction = "LOR appears sent; follow up for receipt, inspection, or adjuster status.";
  }

  return gate;
}

export function shouldSendLorToAdjuster(review, gate) {
  const file = review.file;
  return isCarrierContactStage(file) && hasAdjusterEmail(file) && !gate.checks.find((check) => check.name === "LOR sent evidence")?.evidence;
}

export function shouldFindLorDestination(review, gate) {
  const file = review.file;
  return isCarrierContactStage(file) && !hasAdjusterDestination(file, buildEvidenceText(review)) && !gate.checks.find((check) => check.name === "LOR sent evidence")?.evidence;
}

export function shouldSubmitCarrierDocs(review, gate) {
  const file = review.file;
  return isCarrierContactStage(file) &&
    hasAdjusterDestination(file, buildEvidenceText(review)) &&
    !hasAdjusterEmail(file) &&
    !gate.checks.find((check) => check.name === "LOR sent evidence")?.evidence;
}

export function lorEmailAction(review, title = "Send LOR to adjuster") {
  const file = review.file;
  return {
    channel: "gmail",
    action: "send_email",
    executable: false,
    title,
    to: file.adjuster?.email || "",
    subject: cleanClaimNumber(file.claimNumber),
    subjectRule: "Claim number only.",
    body: [
      "Good afternoon,",
      "",
      `Please see the attached LOR for ${file.customer}.`,
      "",
      `Claim #: ${cleanClaimNumber(file.claimNumber) || ""}`,
      file.policyNumber ? `Policy #: ${file.policyNumber}` : "",
      file.address ? `Property: ${file.address}` : "",
      file.dateOfLoss ? `Date of Loss: ${formatDateOfLoss(file.dateOfLoss)}` : "",
      "",
      "Thank you,",
      "Chance Pearson",
      "Wave Public Adjusting"
    ].filter((line) => line !== "").join("\n"),
    attachmentsNeeded: ["LOR"],
    afterSendJobNimbusNote: "LOR sent to adjuster. Next step is inspection/status follow-up."
  };
}

export function lorDestinationAction(review) {
  return {
    channel: "manual",
    action: "find_lor_destination",
    executable: false,
    title: "Find LOR destination",
    description: "Call carrier, check claim portal, or review recent carrier messages for the correct LOR/document delivery email before marking this file as follow-up."
  };
}

export function carrierDocsSubmissionAction(review) {
  const file = review.file;
  const evidenceText = buildEvidenceText(review);
  return {
    channel: "manual",
    action: "submit_carrier_documents",
    executable: false,
    title: "Submit/upload LOR and claim docs",
    description: "Use the known carrier document destination to send/upload LOR, PA/TDI/contract, estimate/scope, and required supporting documents before treating this file as follow-up.",
    destinationEvidence: adjusterEvidence(file, evidenceText),
    claimNumber: cleanClaimNumber(file.claimNumber),
    policyNumber: file.policyNumber || "",
    subjectRule: "If emailing insurance, use claim number only."
  };
}

function isFiledClaim(file) {
  return Boolean(clean(file.claimNumber)) || /submitted awaiting confirmation/i.test(file.status || "");
}

function isCarrierContactStage(file) {
  return /submitted awaiting confirmation/i.test(file.status || "");
}

function hasAdjusterEmail(file) {
  return EMAIL_PATTERN.test(file.adjuster?.email || "");
}

function hasAdjusterDestination(file, evidenceText) {
  return hasAdjusterEmail(file) ||
    Boolean(clean(file.adjuster?.phone)) ||
    /claims?@|fireclaims@|send (?:lor|docs|documents)|upload (?:lor|docs|documents)|document submission/i.test(evidenceText);
}

function adjusterEvidence(file, evidenceText) {
  if (hasAdjusterEmail(file)) return file.adjuster.email;
  if (clean(file.adjuster?.phone)) return file.adjuster.phone;
  return findEvidence(evidenceText, [/claims?@[^\s,;]+/i, /fireclaims@[^\s,;]+/i, /upload (?:lor|docs|documents)[^.]+/i]);
}

function hasLorSentEvidence(text) {
  return Boolean(findEvidence(text, LOR_SENT_PATTERNS));
}

function hasEstimateDocument(file) {
  return Boolean(findDocument(file, ESTIMATE_DOC_PATTERNS));
}

function hasRepresentationDocument(file) {
  return Boolean(findDocument(file, REPRESENTATION_DOC_PATTERNS));
}

function findDocument(file, patterns) {
  return (file.documents || []).find((document) => patterns.some((pattern) => pattern.test(document.name || "")));
}

function buildEvidenceText(review, overlayEntry = null) {
  const parts = [];
  for (const note of review.file.notes || []) parts.push(note.body || "");
  for (const document of review.file.documents || []) parts.push(document.name || "");
  for (const fact of overlayEntry?.facts || []) parts.push(fact);
  return parts.join("\n");
}

function addCheck(checks, name, ok, evidence) {
  checks.push({
    name,
    status: ok ? "ok" : "missing",
    evidence: clean(evidence)
  });
}

function findEvidence(text, patterns) {
  const cleanText = clean(text);
  for (const pattern of patterns) {
    const match = cleanText.match(pattern);
    if (match) return truncate(match[0], 160);
  }
  return "";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\bReference\s*#?\b/gi, "")
    .replace(/\bClaim\s*#?:?\s*/gi, "")
    .replace(/\s+#\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDateOfLoss(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

const LOR_SENT_PATTERNS = [
  /\b(?:sent|emailed|submitted|uploaded|resent)\s+(?:the\s+)?(?:lor|letter of representation)\b/i,
  /\b(?:lor|letter of representation)\s+(?:sent|emailed|submitted|uploaded|received|on file)\b/i,
  /\bi have submitted lor\b/i,
  /\bi have emailed lor\b/i,
  /\bcarrier receipt confirmation received\b/i
];

const ESTIMATE_DOC_PATTERNS = [
  /estimate/i,
  /scope/i,
  /final[_\s-]*draft/i,
  /deprec/i,
  /\.esx$/i
];

const REPRESENTATION_DOC_PATTERNS = [
  /\blor\b/i,
  /letter of representation/i,
  /\btdi\b/i,
  /fin535/i,
  /pa contract/i,
  /part b/i,
  /contract/i
];
