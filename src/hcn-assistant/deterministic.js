const JOB_NUMBER_REQUEST =
  /\b(?:file|job|jobnimbus|jn)\s*(?:#|number|no\.?)?\s*(\d{2,12})\b/i;
const MAX_LINE_TEXT = 140;
const MAX_MESSAGE_CHARACTERS = 15_000;

/**
 * Extract the one numeric JobNimbus number accepted by the deterministic
 * exact-file status route. Ambiguous or malformed requests fail closed.
 */
export function extractDeterministicJobNumber(prompt) {
  const value = boundedText(prompt, 4_000, "prompt");
  const matches = [...value.matchAll(new RegExp(
    JOB_NUMBER_REQUEST.source,
    `${JOB_NUMBER_REQUEST.flags}g`
  ))];
  if (
    matches.length !== 1
    || !/^\d{2,12}$/.test(matches[0][1])
  ) {
    return null;
  }
  return matches[0][1];
}

export function formatDeterministicWorkCenter(workCenter) {
  const page = plainObject(workCenter?.page, "work center page");
  const files = boundedArray(workCenter?.files, 50, "work center files");
  const total = boundedInteger(page.total, 0, 5_000, "work center total");
  const lines = [
    `You have ${total} assigned file${total === 1 ? "" : "s"} in JobNimbus.`
  ];
  if (files.length === 0) {
    lines.push("There are no files on this page.");
  } else {
    lines.push("");
    for (const file of files.slice(0, 25)) {
      const item = plainObject(file, "work center file");
      const number = safeLine(item.jobNumber, "File");
      const name = safeLine(item.displayName, "Assigned file");
      const status = humanCode(item.statusCode);
      const stage = humanCode(item.stageCode);
      const attention = boundedArray(
        item.attentionCodes ?? [],
        16,
        "attention codes"
      );
      const suffix = attention.length
        ? ` — needs attention: ${attention.map(humanCode).join(", ")}`
        : "";
      lines.push(
        `- ${number} · ${name} · ${status} / ${stage}${suffix}`
      );
    }
    if (files.length > 25 || page.hasMore === true) {
      lines.push("");
      lines.push(
        "More assigned files are available in Work My Files."
      );
    }
  }
  lines.push("");
  lines.push("Fresh source: JobNimbus. Nothing was changed.");
  return boundedMessage(lines.join("\n"));
}

export function formatDeterministicManagementSweep(sweep) {
  const adjusters = boundedArray(
    sweep?.adjusters,
    10,
    "management sweep adjusters"
  );
  const checkedAt = safeTimestamp(sweep?.checkedAt);
  const lines = [
    "Longest verified JobNimbus activity gaps by adjuster:",
    ""
  ];
  for (const group of adjusters) {
    const adjuster = plainObject(group, "management sweep adjuster");
    const name = safeLine(adjuster.name, "Configured adjuster");
    const items = boundedArray(
      adjuster.items,
      10,
      "management sweep items"
    );
    lines.push(`${name} (${items.length} shown)`);
    if (items.length === 0) {
      lines.push("- No eligible files were returned.");
    } else {
      for (const rawItem of items) {
        const item = plainObject(rawItem, "management sweep item");
        const display = plainObject(
          item.display,
          "management sweep display"
        );
        const gaps = plainObject(
          item.gaps,
          "management sweep gaps"
        );
        const operational = plainObject(
          gaps.operationalActivity,
          "operational activity gap"
        );
        const gapDays = boundedInteger(
          operational.days,
          0,
          100_000,
          "operational activity days"
        );
        const number = safeLine(display.jobNumber, "File");
        const fileName = safeLine(display.name, "Assigned file");
        const stage = humanCode(item.stageCode);
        lines.push(
          `- ${number} · ${fileName} · ${gapDays} day`
          + `${gapDays === 1 ? "" : "s"} · ${stage}`
        );
      }
    }
    lines.push("");
  }
  lines.push(
    "This report measures verified JobNimbus activity only; Gmail, Quo, and calendar communication coverage were not evaluated."
  );
  if (checkedAt) lines.push(`Checked ${checkedAt}.`);
  lines.push("Nothing was changed.");
  return boundedMessage(lines.join("\n"));
}

export function formatDeterministicFileStatus(fileReview) {
  const file = plainObject(fileReview?.file, "file review");
  const number = safeLine(file.jobNumber, "File");
  const name = safeLine(file.displayName, "Assigned file");
  const status = humanCode(file.statusCode);
  const stage = humanCode(file.stageCode);
  const updatedAt = safeTimestamp(file.updatedAt);
  const missing = plainObject(file.missing ?? {}, "missing facts");
  const missingFacts = [];
  if (missing.claimNumber === true) missingFacts.push("claim number");
  if (missing.policyNumber === true) missingFacts.push("policy number");
  if (missing.dateOfLoss === true) missingFacts.push("date of loss");
  if (missing.adjuster === true) missingFacts.push("adjuster");
  const priorityCount = boundedArray(
    fileReview?.lanes?.priority ?? [],
    20,
    "priority lane"
  ).length;
  const todayCount = boundedArray(
    fileReview?.lanes?.today ?? [],
    20,
    "today lane"
  ).length;
  const lines = [
    `${number} · ${name}`,
    `Status: ${status}`,
    `Stage: ${stage}`,
    `Last JobNimbus update: ${updatedAt || "not available"}`,
    `Priority items: ${priorityCount}`,
    `Due today: ${todayCount}`,
    `Missing key facts: ${missingFacts.length
      ? missingFacts.join(", ")
      : "none shown"}`
  ];
  if (fileReview?.evidenceStatus !== "complete") {
    lines.push(
      "Evidence is partial; one or more supporting sources were unavailable or incomplete."
    );
  }
  lines.push("Nothing was changed.");
  return boundedMessage(lines.join("\n"));
}

export function formatCodexEscalation(reasonCodes) {
  const reasons = boundedArray(
    reasonCodes,
    12,
    "reason codes"
  );
  const reasonSet = new Set(reasons);
  let blockedStep =
    "That request needs the protected operator workflow.";
  if (reasonSet.has("unsupported_live_call")) {
    blockedStep =
      "Live calls use a separate, approval-gated operator workflow.";
  } else if (reasonSet.has("unsupported_upload")) {
    blockedStep =
      "Uploads use a separate, approval-gated operator workflow.";
  } else if (reasonSet.has("unsupported_delete")) {
    blockedStep =
      "Deletes use a separate, approval-gated operator workflow.";
  } else if (reasonSet.has("unsupported_financial_action")) {
    blockedStep =
      "Payments and other financial actions require a separate protected workflow.";
  } else if (reasonSet.has("unsupported_legal_action")) {
    blockedStep =
      "That legal step requires qualified human review outside Ask Thresher.";
  } else if (reasonSet.has("missing_required_evidence")) {
    blockedStep =
      "The required fresh evidence is missing, so Ask Thresher stopped instead of guessing.";
  } else if (reasonSet.has("explicit_codex_request")) {
    blockedStep =
      "That request belongs in the approved Codex operator workflow.";
  }
  return boundedMessage(
    `${blockedStep} Nothing was changed, sent, called, uploaded, deleted, or paid.`
  );
}

function safeLine(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE_TEXT);
  return normalized || fallback;
}

function humanCode(value) {
  const normalized = safeLine(value, "Not specified")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return "Not specified";
  return normalized.replace(
    /\b[a-z]/g,
    (letter) => letter.toUpperCase()
  );
}

function safeTimestamp(value) {
  if (typeof value !== "string") return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString();
}

function boundedText(value, maximum, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function plainObject(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedMessage(value) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_MESSAGE_CHARACTERS
  ) {
    throw new TypeError("deterministic assistant message is invalid");
  }
  return value.trim();
}
