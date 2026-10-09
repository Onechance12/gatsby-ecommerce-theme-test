const SHA256 = /^[a-f0-9]{64}$/;

// A claim is a resource boundary, not a lifetime ban on new correspondence.
// Only completed draft creations can permit a different, freshly approved
// intent. Gmail delivery and every other outbound channel keep their original
// source lock. No ledger history is removed or made replayable by this rule.
export function findOutboundReservationConflict(rows, {
  channel, approvalDigest, sourceKeyHash = "", contentDigest = "",
  legacyApprovalDigest = "", reviewedDraftReservationIds = null
}) {
  return rows.find((row) => {
    if (row.channel !== channel || row.status === "verified_not_applied") return false;
    if (row.approvalDigest === approvalDigest) return true;
    if (channel === "gmail_draft" && legacyApprovalDigest
      && row.approvalDigest === legacyApprovalDigest) return true;
    if (!sourceKeyHash || row.sourceKeyHash !== sourceKeyHash) return false;
    if (channel !== "gmail_draft") return true;
    if (row.status !== "completed" || typeof row.externalId !== "string"
      || !row.externalId.trim() || !SHA256.test(contentDigest)) return true;
    // A newly completed reservation can appear between the provider-copy
    // review and this serialized reservation. It must be reviewed first,
    // even when its content differs; do not create two overlapping copies.
    if (!Array.isArray(reviewedDraftReservationIds) || typeof row.id !== "string"
      || !row.id || !reviewedDraftReservationIds.includes(row.id)) return true;
    // Legacy completed rows have no content fingerprint. Their exact original
    // approval is still checked above; provider draft reuse is checked by the
    // caller before a new intent can be planned. Unknown legacy rows stay shut.
    if (!Object.hasOwn(row, "contentDigest")) return false;
    if (!SHA256.test(row.contentDigest)) return true;
    return row.contentDigest === contentDigest;
  }) || null;
}
