// Read-only correlation helpers. No provider calls, file identifiers or customer
// data are retained here. Apply the SAME matcher to the target and conflicts.
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const HORIZONTAL_SPACE = " \\t\\u00a0\\u202f";
const SEPARATORS = `[${HORIZONTAL_SPACE}._/#-]*`;

export function createClaimIdentifierMatcher(value) {
  const content = String(value || "").replace(DASHES, "-")
    .replace(/[A-Z]/g, letter => letter.toLowerCase())
    // # joins tokens in claim identifiers, but in this bounded label it is a
    // delimiter. Do not strip arbitrary prefixes such as OTHER#ABC-123.
    .replace(/(?<![\p{L}\p{N}._/#-])claim(?:[ \t]+(?:number|no\.?))?[ \t]*#[ \t]*/gu, " ");
  const results = new Map();
  function inspect(normalized) {
    if (typeof normalized !== "string" || !/^[a-z0-9]{6,160}$/.test(normalized)) {
      return { matched: false, reason: "invalid_identifier", rejectedBoundaries: [] };
    }
    if (results.has(normalized)) return results.get(normalized);
    // Whole alphanumeric identifier, allowing only known formatting changes.
    // Never strip all punctuation from an entire email or perform fuzzy matching.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${[...normalized].join(SEPARATORS)}(?![\\p{L}\\p{N}])`, "gu");
    let found = false;
    const rejectedBoundaries = new Set();
    for (const match of content.matchAll(pattern)) {
      const before = content.slice(0, match.index);
      const after = content.slice(match.index + match[0].length);
      // Do not admit a suffix/prefix of a longer punctuated identifier.
      const prefix = /[\p{L}\p{N}][._/#-]+$/u.test(before);
      const suffix = /^[._/#-]+[\p{L}\p{N}]/u.test(after);
      if (prefix || suffix) {
        if (prefix) rejectedBoundaries.add("longer_identifier_prefix");
        if (suffix) rejectedBoundaries.add("longer_identifier_suffix");
        continue;
      }
      found = true;
      break;
    }
    const result = { matched: found,
      reason: found ? "matched" : rejectedBoundaries.size ? "longer_identifier_boundary" : "no_bounded_match",
      rejectedBoundaries: found ? [] : [...rejectedBoundaries] };
    results.set(normalized, result);
    return result;
  }
  return {
    has(normalized) { return inspect(normalized).matched; },
    explain(normalized) {
      const result = inspect(normalized);
      return { ...result, rejectedBoundaries: [...result.rejectedBoundaries] };
    }
  };
}

export function claimSearchVariants(value) {
  const original = String(value || "").trim();
  const folded = original.replace(DASHES, "-");
  const normalized = folded.replace(/[ \t\u00a0\u202f._/#-]/g, "");
  // Only variants of this exact file's identifier, never an arbitrary query.
  if (!/^[a-z0-9]{6,160}$/i.test(normalized)) return original ? [original] : [];
  return [...new Set([original, folded, normalized])];
}

export function gmailCorrelationDecision(correlation) {
  if (correlation.complete !== true) return "incomplete_correlation_index";
  if (correlation.conflictingFileIds.length || correlation.conflictingFileReference === true) return "conflicting_file_evidence";
  if (correlation.targetMatch !== true) return "missing_unique_target_evidence";
  return "matched";
}

export function emptyGmailWithheldReasonCounts() {
  return {
    incomplete_correlation_index: 0,
    conflicting_file_evidence: 0,
    missing_unique_target_evidence: 0
  };
}
