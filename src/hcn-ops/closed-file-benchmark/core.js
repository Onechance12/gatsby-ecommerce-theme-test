/**
 * Pure, read-only closed-file benchmark projection.
 *
 * This module accepts fresh JobNimbus contact/activity records that were
 * already fetched by the server. It performs no I/O, persists nothing, and
 * has no write, send, call, upload, model, Brain, or Jobrolo capability.
 */

export const CLOSED_FILE_BENCHMARK_SCHEMA_VERSION =
  "hcn.closed-file-benchmark.v1";

const DAY_MS = 86_400_000;
const MAX_NOTE_CHARS = 700;
const MAX_EVIDENCE_PER_FILE = 12;
const MONEY_KEYWORDS =
  /\b(?:acv|amount|approved|award|carrier|check|collected|contract|depreciation|estimate|fee|invoice|paid|payment|payout|rcv|recoverable|revenue|settlement|supplement|total)\b/i;
const OUTCOME_TERMS =
  /\b(?:approved|award|carrier payment|check(?:s)? (?:issued|received)|collected|paid|payment received|payout|settled|settlement received)\b/i;
const NEGATIVE_AMOUNT_CONTEXT =
  /\b(?:deductible|premium|coverage limit|policy limit|mortgage balance)\b/i;
const TERMINAL_STATUS =
  /\b(?:closed|complete|completed|collected|finished|paid|resolved|settled)\b/i;
const NEGATIVE_TERMINAL_STATUS =
  /\b(?:cancelled|canceled|declined|denied|duplicate|lost|no contract|test|withdrawn)\b/i;

export function buildClosedFileBenchmark({
  generatedAt,
  rangeStart,
  contacts,
  activityBundles,
  limit = 20
}) {
  const generated = timestamp(generatedAt);
  const start = timestamp(rangeStart);
  if (Date.parse(start) >= Date.parse(generated)) {
    throw new TypeError("rangeStart must be before generatedAt");
  }
  if (!Array.isArray(contacts) || !Array.isArray(activityBundles)) {
    throw new TypeError("contacts and activityBundles must be arrays");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError("limit must be an integer from 1 to 50");
  }

  const bundles = new Map();
  for (const bundle of activityBundles) {
    const id = providerId(bundle?.providerFileId);
    if (bundles.has(id)) throw new TypeError("duplicate activity bundle");
    if (bundle?.complete !== true || !Array.isArray(bundle.activities)) {
      throw new TypeError("activity bundle must be complete");
    }
    bundles.set(id, bundle.activities);
  }

  const eligible = [];
  const exclusions = {
    nonInsurance: 0,
    notClosed: 0,
    outsideRange: 0,
    negativeOutcome: 0,
    missingActivityBundle: 0
  };

  for (const contact of contacts) {
    if (!isPlainObject(contact)) throw new TypeError("invalid contact");
    if (!isInsuranceFile(contact)) {
      exclusions.nonInsurance += 1;
      continue;
    }
    if (!isClosedFile(contact)) {
      exclusions.notClosed += 1;
      continue;
    }
    const status = text(field(contact, ["status_name", "statusName", "status"]), 120);
    if (NEGATIVE_TERMINAL_STATUS.test(status)) {
      exclusions.negativeOutcome += 1;
      continue;
    }
    const closedAt = contactCloseTime(contact);
    if (
      !closedAt
      || Date.parse(closedAt) < Date.parse(start)
      || Date.parse(closedAt) > Date.parse(generated)
    ) {
      exclusions.outsideRange += 1;
      continue;
    }
    const id = providerId(field(contact, ["jnid", "id", "contact_id", "contactId"]));
    const activities = bundles.get(id);
    if (!activities) {
      exclusions.missingActivityBundle += 1;
      continue;
    }
    eligible.push(projectFile(contact, activities, { closedAt }));
  }

  const outcomeRanked = [...eligible].sort(compareOutcome);
  const repeatabilityRanked = [...eligible].sort(compareRepeatability);
  const outcomeRankById = rankMap(outcomeRanked);
  const repeatabilityRankById = rankMap(repeatabilityRanked);
  const candidates = outcomeRanked.slice(0, limit).map((item) => ({
    ...item,
    rankings: {
      outcome: outcomeRankById.get(item.providerFileId),
      repeatability: repeatabilityRankById.get(item.providerFileId)
    }
  }));

  return {
    schemaVersion: CLOSED_FILE_BENCHMARK_SCHEMA_VERSION,
    generatedAt: generated,
    range: {
      start,
      end: generated,
      closeDateBasis:
        "Explicit closed/status-change timestamp when available; otherwise the last JobNimbus update is a labeled close-date proxy."
    },
    criteria: {
      outcome:
        "Strong paid, payment, settlement, award, or collected evidence ranks ahead of estimate-only dollar mentions.",
      repeatability:
        "Documented workflow milestones and steady activity improve repeatability; appraisal-dependent and very long-cycle files are discounted.",
      caution:
        "A dollar amount is not reported as paid unless its source text contains a strong outcome term."
    },
    summary: {
      contactCount: contacts.length,
      eligibleClosedFileCount: eligible.length,
      returnedCandidateCount: candidates.length,
      activityRecordCount: eligible.reduce(
        (total, file) => total + file.workflow.activityCount,
        0
      )
    },
    candidates,
    repeatabilityLeaders: repeatabilityRanked.slice(0, Math.min(limit, 10)).map((item) => ({
      providerFileId: item.providerFileId,
      jobNumber: item.jobNumber,
      displayName: item.displayName,
      score: item.repeatabilityScore,
      outcomeRank: outcomeRankById.get(item.providerFileId),
      repeatabilityRank: repeatabilityRankById.get(item.providerFileId)
    })),
    exclusions
  };
}

export function isClosedBenchmarkContact(contact, { generatedAt, rangeStart } = {}) {
  if (!isPlainObject(contact) || !isInsuranceFile(contact) || !isClosedFile(contact)) {
    return false;
  }
  const status = text(field(contact, ["status_name", "statusName", "status"]), 120);
  if (NEGATIVE_TERMINAL_STATUS.test(status)) return false;
  const closedAt = contactCloseTime(contact);
  const end = timestamp(generatedAt);
  const start = timestamp(rangeStart);
  return Boolean(
    closedAt
    && Date.parse(closedAt) >= Date.parse(start)
    && Date.parse(closedAt) <= Date.parse(end)
  );
}

function projectFile(contact, activities, { closedAt }) {
  const providerFileId = providerId(field(contact, ["jnid", "id", "contact_id", "contactId"]));
  const jobNumber = text(
    field(contact, ["number", "recid", "job_number", "jobNumber", "file_number", "fileNumber"]),
    64
  );
  const displayName = contactDisplayName(contact);
  const status = text(field(contact, ["status_name", "statusName", "status"]), 120) || "Closed";
  const openedAt = providerTimestamp(
    field(contact, ["date_created", "created_at", "createdAt"])
  );
  const closeBasis = explicitCloseTime(contact)
    ? "explicit_closed_or_status_change"
    : "last_update_proxy";
  const normalizedActivities = activities
    .map(normalizeActivity)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const contactEvidence = financialContactEvidence(contact);
  const activityEvidence = normalizedActivities.flatMap(financialActivityEvidence);
  const evidence = [...contactEvidence, ...activityEvidence]
    .sort(compareFinancialEvidence)
    .slice(0, MAX_EVIDENCE_PER_FILE);
  const strongEvidence = evidence.filter((item) => item.strength === "strong");
  const supportEvidence = evidence.filter((item) => item.strength === "supporting");
  const paidEvidence = strongEvidence.filter((item) => item.category === "payment");
  const awardEvidence = strongEvidence.filter((item) =>
    item.category === "appraisal_outcome" || item.category === "settlement_or_award"
  );
  const verifiedPaidAmount = maximumAmount(paidEvidence);
  const verifiedAwardAmount = maximumAmount(awardEvidence);
  const verifiedOutcomeAmount = maximumAmount(strongEvidence);
  const mentionedAmount = maximumAmount(evidence);
  const milestones = workflowMilestones(normalizedActivities);
  const gapDays = maximumActivityGapDays(normalizedActivities, openedAt, closedAt);
  const cycleDays = openedAt
    ? Math.max(0, Math.round((Date.parse(closedAt) - Date.parse(openedAt)) / DAY_MS))
    : null;
  const appraisalDependent = milestones.some((item) => item.code === "appraisal");
  const outcomeScore = calculateOutcomeScore({
    verifiedOutcomeAmount,
    strongEvidenceCount: strongEvidence.length,
    supportingEvidenceCount: supportEvidence.length,
    milestoneCount: milestones.length
  });
  const repeatabilityScore = calculateRepeatabilityScore({
    outcomeScore,
    milestones,
    gapDays,
    cycleDays,
    appraisalDependent,
    activityCount: normalizedActivities.length
  });

  return {
    providerFileId,
    jobNumber,
    displayName,
    status,
    owners: ownerNames(contact),
    openedAt: openedAt || "",
    closedAt,
    closeDateBasis: closeBasis,
    financial: {
      verifiedPaidAmount,
      verifiedAwardAmount,
      verifiedOutcomeAmount,
      mentionedAmount,
      confidence: verifiedOutcomeAmount > 0
        ? strongEvidence.length > 1 ? "high" : "medium"
        : mentionedAmount > 0 ? "estimate_or_supporting_only" : "none",
      strongEvidenceCount: strongEvidence.length,
      supportingEvidenceCount: supportEvidence.length,
      evidence
    },
    workflow: {
      activityCount: normalizedActivities.length,
      milestoneCount: milestones.length,
      milestones,
      cycleDays,
      maximumActivityGapDays: gapDays,
      appraisalDependent
    },
    outcomeScore,
    repeatabilityScore
  };
}

function financialContactEvidence(contact) {
  const results = [];
  for (const [key, value] of Object.entries(contact)) {
    if (!MONEY_KEYWORDS.test(String(key))) continue;
    if (!["string", "number"].includes(typeof value)) continue;
    const sourceText = `${String(key).replace(/[_-]+/g, " ")}: ${typeof value === "number" ? `$${value}` : String(value)}`;
    results.push(...financialEvidenceForText(sourceText, {
      source: "jobnimbus_contact_field",
      at: providerTimestamp(field(contact, ["date_updated", "updated_at", "updatedAt"])) || ""
    }));
  }
  return results;
}

function financialActivityEvidence(activity) {
  if (!MONEY_KEYWORDS.test(activity.text) && !OUTCOME_TERMS.test(activity.text)) {
    return [];
  }
  return financialEvidenceForText(activity.text, {
    source: "jobnimbus_activity",
    at: activity.at
  });
}

function financialEvidenceForText(value, { source, at }) {
  const textValue = String(value || "");
  const mentions = moneyMentions(textValue);
  const evidence = mentions.map((mention) => {
    const context = moneyMentionContext(textValue, mention);
    const classification = classifyFinancialMention(context);
    return {
      source,
      at,
      category: classification.category,
      strength: classification.strength,
      amounts: [mention.amount],
      excerpt: redactExcerpt(context.excerpt)
    };
  });
  const strongestByAmount = new Map();
  for (const item of evidence) {
    const key = String(item.amounts[0]);
    const prior = strongestByAmount.get(key);
    if (!prior || evidenceStrength(item.strength) > evidenceStrength(prior.strength)) {
      strongestByAmount.set(key, item);
    }
  }
  return [...strongestByAmount.values()];
}

function classifyFinancialMention(context) {
  const before = context.before.toLowerCase();
  const after = context.after.toLowerCase();
  const nearby = `${before} ${after}`;
  const immediateBefore = before.slice(-110);
  const immediateAfter = after.slice(0, 90);
  const immediate = `${immediateBefore} ${immediateAfter}`;

  if (
    /\b(?:no payment due|no additional (?:payment|funds?)|not payable|not approved|cannot be (?:approved|granted)|can't be (?:approved|granted)|denied|rejected)\b/.test(nearby)
    || /\b(?:cannot|can't|could not|couldn't)\s+(?:add|approve|pay|grant)\b/.test(immediate)
    || /^\s*(?:still|remains?|remaining|outstanding)\s+(?:due|owed)\b/.test(immediateAfter)
    || (!context.mention.hadDollar && /^.{0,35}\bfor (?:your )?reference\b/.test(immediateAfter))
  ) {
    return { category: "unclassified_amount", strength: "context_only" };
  }

  const nearestLabel = nearestFinancialLabel(immediateBefore);
  const directEstimate = /\b(?:estimated damages|vendor estimate|carrier estimate|proposed estimate|final invoice|quote|out[- ]of[- ]pocket)\s*(?:rcv|acv|amount|total)?\s*[:=-]?\s*$/.test(immediateBefore);
  const dueBefore = /\b(?:remaining|outstanding)\s+(?:payment|settlement)?\s*(?:due|owed)?\s*[:=-]?\s*$/.test(immediateBefore);
  const prospective = /\b(?:want(?:s|ed)?|would like|looking to|hop(?:e|es|ing)|target(?:ing)?|seek(?:s|ing)?|need(?:s|ed)?|request(?:s|ed|ing)?|proposed|pending)\b.{0,70}$/.test(immediateBefore);
  const completedPayment = /\b(?:total )?payment(?:s)? (?:made|received|issued|sent|mailed|added|completed)|\bpayment(?:s)? (?:has been |have been |was |were )?(?:received|issued|sent|mailed|added|completed)|\b(?:paid|collected|payout)\b|\bcheck(?:s)? (?:received|issued|mailed|picked up)|\brevenue\s*:?\s*$/.test(immediate)
    || /^.{0,45}\b(?:payment added|paid|collected|check (?:received|issued|mailed|picked up))\b/.test(immediateAfter);
  const completedAward = /\b(?:notice of award|appraisal award|award (?:was |has been )?(?:signed|received|issued|completed)|(?:signed|received|issued|completed)(?: the)? (?:appraisal )?award|signed award|award total|total award)\b/.test(nearby)
    || /\b(?:award|settlement)\s*(?:is|was|of|for|:|-)?\s*$/.test(immediateBefore);
  const approvedOutcome = /\b(?:carrier(?:'s)? approved|approved (?:amount|estimate|scope|total)|settled|settlement received)\b/.test(nearby);

  if (dueBefore) return { category: "unclassified_amount", strength: "context_only" };
  if (prospective && !completedPayment && !completedAward && !approvedOutcome) {
    return { category: "unclassified_amount", strength: "context_only" };
  }
  if (nearestLabel?.kind === "context") {
    return { category: "deductible_or_limit", strength: "context_only" };
  }
  if (directEstimate || nearestLabel?.kind === "estimate_specific") {
    return { category: "estimate_or_scope", strength: "supporting" };
  }
  if (nearestLabel?.kind === "payment") {
    return prospective && !completedPayment
      ? { category: "unclassified_amount", strength: "context_only" }
      : { category: "payment", strength: "strong" };
  }
  if (nearestLabel?.kind === "award") {
    return {
      category: /\bappraisal\b/.test(nearby) ? "appraisal_outcome" : "settlement_or_award",
      strength: prospective && !completedAward && !approvedOutcome ? "supporting" : "strong"
    };
  }
  if (nearestLabel?.kind === "estimate") {
    if (completedAward || approvedOutcome) {
      return {
        category: /\bappraisal\b/.test(nearby) ? "appraisal_outcome" : "settlement_or_award",
        strength: "strong"
      };
    }
    return { category: "estimate_or_scope", strength: "supporting" };
  }
  if (completedPayment) return { category: "payment", strength: "strong" };
  if (completedAward || approvedOutcome) {
    return {
      category: /\bappraisal\b/.test(nearby) ? "appraisal_outcome" : "settlement_or_award",
      strength: "strong"
    };
  }
  if (/\bsupplement\b/.test(immediate)) {
    return { category: "supplement", strength: "supporting" };
  }
  if (/\b(?:estimate|estimated|rcv|acv|recoverable depreciation|depreciation)\b/.test(immediate)) {
    return { category: "estimate_or_scope", strength: "supporting" };
  }
  if (/\b(?:fee|invoice|revenue|contract)\b/.test(immediate)) {
    return { category: "company_fee_or_invoice", strength: "supporting" };
  }
  if (NEGATIVE_AMOUNT_CONTEXT.test(immediate)) {
    return { category: "deductible_or_limit", strength: "context_only" };
  }
  return { category: "unclassified_amount", strength: "context_only" };
}

function nearestFinancialLabel(value) {
  const source = String(value || "");
  const definitions = [
    ["context", /\b(?:deductible|premium|coverage limit|policy limit|mortgage balance|non[- ]recoverable depreciation|recoverable depreciation|depreciation)\b/g],
    ["estimate_specific", /\b(?:estimated damages|vendor estimate|carrier estimate|proposed estimate|final invoice|quote|out[- ]of[- ]pocket)\b/g],
    ["payment", /\b(?:supplemental actual cash value payment|net payment|prior payments?|payments?|paid|checks?|collected|payout|revenue)\b/g],
    ["award", /\b(?:appraisal award|award|settlement)\b/g],
    ["estimate", /\b(?:replacement cost value|actual cash value|estimate|rcv|acv|supplement|contract|invoice|fee|benefits?)\b/g]
  ];
  let nearest = null;
  for (const [kind, pattern] of definitions) {
    for (const match of source.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (!nearest || end > nearest.end) nearest = { kind, end };
    }
  }
  return nearest;
}

function normalizeActivity(activity) {
  if (!isPlainObject(activity)) return null;
  const at = providerTimestamp(
    field(activity, ["date_created", "created_at", "createdAt", "occurred_at", "occurredAt", "date_updated"])
  );
  if (!at) return null;
  const body = [
    field(activity, ["record_type_name", "recordTypeName", "type"]),
    field(activity, ["status_name", "statusName", "status", "state"]),
    field(activity, ["title", "subject", "label"]),
    field(activity, ["note", "description", "body"])
  ].map((item) => String(item || "").trim()).filter(Boolean).join(" | ");
  return { at, text: body.slice(0, 10_000) };
}

function workflowMilestones(activities) {
  const definitions = [
    ["claim_filed", /\bclaim\b.{0,40}\b(?:filed|submitted)\b/i],
    ["lor_sent", /\b(?:lor|letter of representation)\b.{0,50}\b(?:sent|submitted|emailed)\b/i],
    ["inspection", /\b(?:adjuster )?inspection\b.{0,50}\b(?:complete|completed|held|performed|scheduled)\b/i],
    ["estimate", /\b(?:estimate|scope)\b.{0,50}\b(?:complete|completed|prepared|reviewed|sent|submitted)\b/i],
    ["supplement", /\bsupplement\b.{0,50}\b(?:approved|paid|prepared|sent|submitted)\b/i],
    ["appraisal", /(?:\bappraisal\b.{0,50}\b(?:award|completed|demanded|filed|invoked|panel|requested|signed|submitted)\b|\b(?:award|completed|demanded|filed|invoked|requested|signed|submitted)\b.{0,50}\bappraisal\b)/i],
    ["settlement", /\b(?:approved|award|settled|settlement)\b/i],
    ["payment", /\b(?:check received|collected|paid|payment received)\b/i]
  ];
  return definitions.flatMap(([code, pattern]) => {
    const match = activities.find((activity) => pattern.test(activity.text));
    return match ? [{ code, firstAt: match.at }] : [];
  });
}

function maximumActivityGapDays(activities, openedAt, closedAt) {
  const points = [openedAt, ...activities.map((item) => item.at), closedAt]
    .filter(Boolean)
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let maximum = 0;
  for (let index = 1; index < points.length; index += 1) {
    maximum = Math.max(maximum, Math.round((points[index] - points[index - 1]) / DAY_MS));
  }
  return maximum;
}

function calculateOutcomeScore({
  verifiedOutcomeAmount,
  strongEvidenceCount,
  supportingEvidenceCount,
  milestoneCount
}) {
  const amountScore = verifiedOutcomeAmount > 0
    ? Math.round(Math.log10(verifiedOutcomeAmount + 1) * 100)
    : 0;
  return amountScore
    + Math.min(strongEvidenceCount, 5) * 25
    + Math.min(supportingEvidenceCount, 5) * 5
    + Math.min(milestoneCount, 8) * 3;
}

function calculateRepeatabilityScore({
  outcomeScore,
  milestones,
  gapDays,
  cycleDays,
  appraisalDependent,
  activityCount
}) {
  const milestoneCodes = new Set(milestones.map((item) => item.code));
  const standardMilestones = [
    "claim_filed",
    "lor_sent",
    "inspection",
    "estimate",
    "supplement",
    "settlement",
    "payment"
  ].filter((code) => milestoneCodes.has(code)).length;
  const gapPenalty = Math.min(80, Math.max(0, gapDays - 30));
  const cyclePenalty = cycleDays === null
    ? 20
    : Math.min(80, Math.max(0, cycleDays - 365) / 10);
  const appraisalPenalty = appraisalDependent ? 35 : 0;
  return Math.round(
    outcomeScore * 0.35
    + standardMilestones * 18
    + Math.min(activityCount, 40)
    - gapPenalty
    - cyclePenalty
    - appraisalPenalty
  );
}

function compareOutcome(left, right) {
  return right.financial.verifiedOutcomeAmount - left.financial.verifiedOutcomeAmount
    || right.financial.strongEvidenceCount - left.financial.strongEvidenceCount
    || right.outcomeScore - left.outcomeScore
    || right.repeatabilityScore - left.repeatabilityScore
    || left.jobNumber.localeCompare(right.jobNumber);
}

function compareRepeatability(left, right) {
  return right.repeatabilityScore - left.repeatabilityScore
    || right.outcomeScore - left.outcomeScore
    || left.jobNumber.localeCompare(right.jobNumber);
}

function compareFinancialEvidence(left, right) {
  return evidenceStrength(right.strength) - evidenceStrength(left.strength)
    || maximumAmount([right]) - maximumAmount([left])
    || Date.parse(right.at || 0) - Date.parse(left.at || 0);
}

function evidenceStrength(value) {
  return value === "strong" ? 3 : value === "supporting" ? 2 : 1;
}

function maximumAmount(evidence) {
  return evidence.reduce(
    (maximum, item) => Math.max(maximum, ...(item.amounts || [0])),
    0
  );
}

function moneyMentions(value) {
  const source = String(value || "");
  const mentions = [];
  const seen = new Set();
  const add = (raw, start, end, { hadDollar = false, multiplier = 1 } = {}) => {
    const amount = Number(String(raw).replace(/,/g, "")) * multiplier;
    if (!Number.isFinite(amount) || amount < 1 || amount > 100_000_000) return;
    const key = `${start}:${end}:${amount}`;
    if (seen.has(key)) return;
    seen.add(key);
    mentions.push({ amount, start, end, hadDollar });
  };

  for (const match of source.matchAll(/\$\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,9})(?:\.\d{1,2})?)\s*([kK])?(?![\d,])/g)) {
    const raw = match[1];
    const start = match.index + match[0].lastIndexOf(raw);
    add(raw, start, start + raw.length, {
      hadDollar: true,
      multiplier: match[2] ? 1000 : 1
    });
  }

  const labelPattern = /\b(?:acv|amount|approved|award|benefits?|check|collected|contract|deductible|depreciation|estimate|fee|invoice|paid|payment|payout|rcv|revenue|settlement|supplement|total)\b[^\d$]{0,24}\$?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9})(?:\.\d{1,2})?|[0-9]{1,7}\.\d{1,2})\s*([kK])?(?![\d,])/gi;
  for (const match of source.matchAll(labelPattern)) {
    const raw = match[1];
    const start = match.index + match[0].lastIndexOf(raw);
    add(raw, start, start + raw.length, {
      hadDollar: match[0].includes("$"),
      multiplier: match[2] ? 1000 : 1
    });
  }

  return mentions.sort((left, right) => left.start - right.start).slice(0, 30);
}

function moneyMentionContext(source, mention) {
  const before = source.slice(Math.max(0, mention.start - 190), mention.start);
  const after = source.slice(mention.end, Math.min(source.length, mention.end + 120));
  return {
    before,
    after,
    mention,
    excerpt: `${before}${source.slice(mention.start, mention.end)}${after}`
  };
}

function redactExcerpt(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, "[phone redacted]")
    .replace(/\b(claim|policy)\s*(?:#|number|no\.?)?\s*[:=-]?\s*[A-Z0-9-]{5,}\b/gi, "$1 [identifier redacted]")
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.' -]{2,50}\s+(?:st|street|rd|road|dr|drive|ave|avenue|ln|lane|ct|court|cir|circle|way|blvd|boulevard|trl|trail|pkwy|parkway)\b/gi, "[address redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_CHARS);
}

function contactCloseTime(contact) {
  return explicitCloseTime(contact)
    || providerTimestamp(field(contact, ["date_updated", "updated_at", "updatedAt"]));
}

function explicitCloseTime(contact) {
  return providerTimestamp(field(contact, [
    "date_closed",
    "closed_at",
    "closedAt",
    "date_status_change",
    "status_changed_at",
    "statusChangedAt"
  ]));
}

function isClosedFile(contact) {
  if (["is_closed", "isClosed", "closed"].some((key) => contact[key] === true)) return true;
  if (["is_active", "isActive", "active"].some((key) => contact[key] === false)) return true;
  if (["is_archived", "isArchived", "archived"].some((key) => contact[key] === true)) return true;
  return TERMINAL_STATUS.test(text(field(contact, ["status_name", "statusName", "status"]), 120));
}

function isInsuranceFile(contact) {
  return String(field(contact, [
    "record_type_name",
    "recordTypeName",
    "file_type_name",
    "fileTypeName"
  ]) || "").trim().toLowerCase() === "insurance";
}

function ownerNames(contact) {
  const owners = Array.isArray(contact.owners) ? contact.owners : [];
  return [...new Set(owners.map((owner) => {
    if (!isPlainObject(owner)) return "";
    return text(
      field(owner, ["display_name", "displayName", "name"]),
      100
    ) || [owner.first_name, owner.last_name].filter(Boolean).join(" ").slice(0, 100);
  }).filter(Boolean))].sort();
}

function contactDisplayName(contact) {
  return text(field(contact, ["display_name", "displayName", "name"]), 120)
    || [
      text(field(contact, ["first_name", "firstName"]), 60),
      text(field(contact, ["last_name", "lastName"]), 60)
    ].filter(Boolean).join(" ")
    || "Unnamed file";
}

function rankMap(items) {
  return new Map(items.map((item, index) => [item.providerFileId, index + 1]));
}

function providerTimestamp(value) {
  if (value === undefined || value === null || value === "") return "";
  let date;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    date = new Date(number > 10_000_000_000 ? number : number * 1000);
  } else {
    date = new Date(String(value));
  }
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function timestamp(value) {
  const result = providerTimestamp(value);
  if (!result) throw new TypeError("invalid timestamp");
  return result;
}

function providerId(value) {
  const result = String(value || "");
  if (!result || result.length > 512 || /[\s\x00-\x1f\x7f]/.test(result)) {
    throw new TypeError("invalid provider id");
  }
  return result;
}

function text(value, maximum) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function field(record, names) {
  if (!isPlainObject(record)) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
