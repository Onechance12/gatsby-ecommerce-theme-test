import { randomUUID } from "node:crypto";
import { gmailCorrelationDecision } from "./file-correlation.js";

// This is a reason-only view of an existing decision, not an admission path or
// a lookup capability. Never copy provider messages or arbitrary object keys.
export const GMAIL_AUDIT_LOCATIONS = Object.freeze([
  "from", "to", "cc", "bcc", "subject", "date", "plain_body", "html_body",
  "snippet", "attachment_name", "combined_content"
]);
const EVIDENCE_KINDS = Object.freeze([
  "client_email_header", "claim_identifier", "policy_identifier", "property",
  "file_reference"
]);
const ADMISSION_BASES = Object.freeze([
  "unique_client_email_header", "unique_claim_identifier", "policy_property",
  "exact_file_reference_with_policy_binding"
]);
const CLAIM_CHECK_REASONS = Object.freeze([
  "matched", "invalid_identifier", "longer_identifier_boundary", "no_bounded_match"
]);
const BOUNDARY_REJECTIONS = Object.freeze(["longer_identifier_prefix", "longer_identifier_suffix"]);
export const GMAIL_AUDIT_MAX_CANDIDATES = 250;

function fixedValues(value, allowed) {
  return Array.isArray(value) ? allowed.filter(item => value.includes(item)) : [];
}

function evidenceRows(value) {
  if (!Array.isArray(value)) return [];
  return EVIDENCE_KINDS.flatMap(kind => {
    const rows = value.filter(row => row?.kind === kind);
    if (!rows.length) return [];
    return [{ kind, locations: fixedValues(rows.flatMap(row => (
      Array.isArray(row.locations) ? row.locations : []
    )), GMAIL_AUDIT_LOCATIONS) }];
  });
}

export function createGmailCorrelationAudit() {
  const auditId = randomUUID();
  const observedAt = new Date().toISOString();
  const rows = [];
  let scannedCandidates = 0;
  return {
    record(correlation, { excludedOtherFile = false } = {}) {
      const candidateNumber = ++scannedCandidates;
      if (rows.length >= GMAIL_AUDIT_MAX_CANDIDATES) return;
      const decision = gmailCorrelationDecision(correlation);
      const canExclude = decision === "conflicting_file_evidence"
        && excludedOtherFile === true && correlation.targetMatch === false;
      const row = {
        candidateNumber,
        disposition: decision === "matched" ? "matched"
          : canExclude ? "excluded_other_file" : "withheld",
        decision
      };
      // Preserve the first-failure disclosure boundary. Incomplete index
      // evidence must not expose later predicates or partially collected traces.
      if (decision !== "incomplete_correlation_index") {
        const trace = correlation.audit;
        row.evidenceTraceAvailable = Boolean(trace);
        if (trace) {
          row.target = {
            match: correlation.targetMatch === true,
            uniqueClientEmail: trace.uniqueClientEmail === true,
            uniqueClaim: trace.uniqueClaim === true,
            policyPropertyBindingAvailable: trace.policyPropertyBindingAvailable === true,
            matchedBy: fixedValues(trace.matchedBy, ADMISSION_BASES),
            observations: evidenceRows(trace.target)
          };
          if (CLAIM_CHECK_REASONS.includes(trace.claimCheck?.reason)) {
            row.target.claimCheck = {
              matched: trace.claimCheck.matched === true,
              reason: trace.claimCheck.reason,
              rejectedBoundaries: BOUNDARY_REJECTIONS.flatMap(reason => {
                const matches = (Array.isArray(trace.claimCheck.rejectedBoundaries) ? trace.claimCheck.rejectedBoundaries : [])
                  .filter(item => item?.reason === reason);
                return matches.length ? [{ reason, locations: fixedValues(matches.flatMap(item => (
                  Array.isArray(item.locations) ? item.locations : []
                )), GMAIL_AUDIT_LOCATIONS) }] : [];
              })
            };
          }
          row.conflicts = evidenceRows(trace.conflicts);
        }
      }
      rows.push(row);
      return structuredClone(row);
    },
    snapshot() {
      return {
        schemaVersion: 1,
        auditId,
        observedAt,
        readOnly: true,
        changesAdmission: false,
        evidenceValuesRedacted: true,
        candidateNumbersAreResponseLocal: true,
        maxCandidates: GMAIL_AUDIT_MAX_CANDIDATES,
        scannedCandidates,
        reportedCandidates: rows.length,
        omittedCandidates: scannedCandidates - rows.length,
        rows: structuredClone(rows)
      };
    }
  };
}
