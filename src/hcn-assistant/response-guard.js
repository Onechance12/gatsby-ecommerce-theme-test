const OPAQUE_REFERENCE =
  /\b(?:subject|ref|value|principal|conversation|message|tenant)_[a-f0-9]{16,64}\b/gi;

const INTERNAL_CODE_LABELS = Object.freeze({
  need_paperwork_info: "Paperwork information needed",
  photo_file_estimate_needed: "Photo file estimate needed",
  ready_for_pa_review: "Ready for PA review",
  submitted_awaiting_confirmation: "Submitted, awaiting confirmation",
  source_partial: "Some source details were skipped",
  source_stale: "The source check is out of date",
  source_unavailable: "The source could not be checked"
});

const ABSENCE_PATTERN =
  /\b(?:no|none|nothing|zero|without any|(?:did|does|do|has|have|had)(?: not|n't) (?:find|show|locate|identify|see)|(?:found|shows?|sees?|located|identified) no)\b/i;
const QUALIFIED_PATTERN =
  /\b(?:could(?: not|n't) verify|cannot verify|unable to verify|not (?:checked|available|loaded)|unavailable|incomplete|check failed|could(?: not|n't) be checked)\b/i;
const CHANNEL_PATTERNS = Object.freeze({
  gmail: /\b(?:gmail|email|emails|emailed|message|messages|reply|replies)\b/i,
  quo: /\b(?:quo|call|calls|called|calling|text|texts|texted|voicemail|voicemails)\b/i
});
const JOBNIMBUS_HISTORY_PATTERN =
  /\b(?:job\s*nimbus\s+)?(?:notes?|tasks?|activities|activity\s+history|file\s+history)\b/i;

/**
 * Enforce a final employee-visible trust boundary on model wording.
 *
 * Opaque platform identifiers are never useful to an employee and are
 * redacted even when a provider model echoes them. An unavailable supporting
 * source can never be used as evidence that a call, text, or email did not
 * happen; unsupported absence claims are replaced with a deterministic gap
 * statement before chat persistence.
 */
export function guardHcnAssistantResponse({ message, sources = [] } = {}) {
  if (typeof message !== "string" || !message.trim()) {
    throw new TypeError("assistant message is invalid");
  }
  const sourceMap = new Map(
    (Array.isArray(sources) ? sources : [])
      .filter((source) => source && typeof source === "object")
      .map((source) => [
        String(source.key || "").toLowerCase(),
        {
          status: String(source.status || "").toLowerCase()
        }
      ])
  );
  const unsupportedChannels = Object.keys(CHANNEL_PATTERNS).filter((key) =>
    sourceMap.has(key)
    && !["fresh", "complete"].includes(sourceMap.get(key).status)
    && containsUnsupportedAbsenceClaim(message, CHANNEL_PATTERNS[key])
  );
  const jobNimbusHistory = sourceMap.get("jobnimbus");
  if (
    jobNimbusHistory
    && !["fresh", "complete"].includes(jobNimbusHistory.status)
    && containsUnsupportedAbsenceClaim(message, JOBNIMBUS_HISTORY_PATTERN)
  ) {
    return "The bounded JobNimbus history check cannot verify that no older notes, activities, or tasks exist. Current file facts and documents were evaluated separately. Retry or review a complete history before treating an absence as verified. Nothing was changed.";
  }

  if (unsupportedChannels.length > 0) {
    const labels = unsupportedChannels.map((key) =>
      key === "quo" ? "Quo calls or texts" : "Gmail messages"
    );
    return `I couldn't verify ${joinLabels(labels)} because ${
      labels.length === 1 ? "that source check did" : "those source checks did"
    } not complete. I won't treat unavailable information as proof that nothing happened. Review the sources that loaded or retry the file check. Nothing was changed.`;
  }

  return humanizeInternalCodes(
    message.replace(OPAQUE_REFERENCE, "internal reference")
  ).trim();
}

function containsUnsupportedAbsenceClaim(message, channelPattern) {
  return String(message)
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) =>
      channelPattern.test(sentence)
      && ABSENCE_PATTERN.test(sentence)
      && !QUALIFIED_PATTERN.test(sentence)
    );
}

function humanizeInternalCodes(message) {
  let result = message;
  for (const [code, label] of Object.entries(INTERNAL_CODE_LABELS)) {
    result = result.replace(new RegExp(`\\b${code}\\b`, "gi"), label);
  }
  return result;
}

function joinLabels(labels) {
  if (labels.length < 2) return labels[0] || "the requested source";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}
