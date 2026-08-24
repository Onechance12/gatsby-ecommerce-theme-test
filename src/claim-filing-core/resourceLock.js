const ACTIVE_CALL_STATUSES = new Set(["registered", "ongoing"]);
const ACTIVE_CALLBACK_STATUSES = new Set(["registered", "ongoing"]);
const COMPLETED_OUTCOMES = new Set(["claim_filed", "existing_claim_confirmed"]);

// Pure policy for the per-JobNimbus-contact claim-call resource. The bridge
// builds this snapshot from its durable ledger plus fresh Retell state while it
// holds the mutation mutex, then reserves the resource before contacting
// Retell. Exact replays are handled separately as idempotent duplicates.
export function evaluateClaimCallResource({
  attempts = [],
  unresolvedReservations = [],
  requestedGoal = "file_new_claim",
  retryOfCallId = ""
} = {}) {
  const retry = String(retryOfCallId || "").trim();
  const goal = String(requestedGoal || "").trim();

  if (unresolvedReservations.length) {
    const reservation = unresolvedReservations[0];
    return deny(
      "provider_outcome_unresolved",
      `A prior approved Retell provider window for this JobNimbus file is ${String(reservation.callStatus || "unresolved")}. Reconcile it before any later call.`
    );
  }

  const rows = [...attempts];
  const reconciliation = rows.find((row) => row.reconciliationRequired === true);
  if (reconciliation) {
    return deny(
      "resource_reconciliation_required",
      reconciliation.reason || "A prior claim call for this JobNimbus file cannot be reconciled to its durable approval reservation."
    );
  }

  const activeCall = rows.find((row) => ACTIVE_CALL_STATUSES.has(String(row.callStatus || "")));
  if (activeCall) {
    return deny(
      "claim_call_active",
      `Retell call ${activeCall.callId} for this JobNimbus file is still ${activeCall.callStatus}. Do not place another call.`
    );
  }

  const unresolvedStatus = rows.find((row) => String(row.callStatus || "") !== "ended");
  if (unresolvedStatus) {
    return deny(
      "claim_call_status_unresolved",
      `Retell call ${unresolvedStatus.callId || "(unknown)"} for this JobNimbus file has unresolved status ${unresolvedStatus.callStatus || "unknown"}. Reconcile it before another call.`
    );
  }

  const activeCallback = rows.find((row) => ACTIVE_CALLBACK_STATUSES.has(String(row.callbackStatus || "")));
  if (activeCallback) {
    return deny(
      "claim_callback_active",
      `The confirmed carrier callback for Retell call ${activeCallback.callId} is still ${activeCallback.callbackStatus}. Review that continuation instead of calling again.`
    );
  }

  const pendingCallback = rows.find((row) => row.callbackConfirmed === true && !row.callbackStatus);
  if (pendingCallback) {
    return deny(
      "claim_callback_pending",
      `Carrier callback confirmation is still pending for Retell call ${pendingCallback.callId}. Wait for or review the callback instead of calling again.`
    );
  }

  const completedClaim = rows.find((row) => (
    row.claimNumber || COMPLETED_OUTCOMES.has(String(row.outcome || ""))
  ));
  if (completedClaim) {
    return deny(
      "claim_already_captured",
      `Retell call ${completedClaim.callId} already captured or confirmed a claim. Review and write back that result instead of calling again.`
    );
  }

  if (goal === "file_new_claim" && rows.some((row) => String(row.goal || "") === "find_existing_claim")) {
    return deny(
      "unsafe_goal_escalation",
      "A prior existing-claim lookup does not prove that no claim exists. Continue with find_existing_claim or obtain manual verified no-claim evidence before any new-claim filing path."
    );
  }

  const latest = rows
    .filter((row) => String(row.callStatus || "") === "ended")
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))[0];

  if (!latest) {
    return retry
      ? deny("unexpected_retry", "retryOfCallId was supplied, but this JobNimbus file has no prior reconciled ended claim call.")
      : allow("first_attempt");
  }

  if (!retry) {
    return deny(
      "latest_call_id_required",
      `This JobNimbus file already has ended Retell call ${latest.callId}. Any later attempt must be separately prepared with retryOfCallId set to that latest call id.`
    );
  }
  if (retry !== String(latest.callId || "")) {
    return deny(
      "stale_retry_lineage",
      `retryOfCallId must equal the latest ended Retell call for this JobNimbus file (${latest.callId}).`
    );
  }

  const priorGoal = String(latest.goal || "");
  if (!safeGoalTransition(priorGoal, goal)) {
    return deny(
      "unsupported_goal_transition",
      `A later claim call cannot change from ${priorGoal || "unknown"} to ${goal || "unknown"}.`
    );
  }

  return allow("retry_of_latest_ended_call", latest.callId);
}

function safeGoalTransition(priorGoal, requestedGoal) {
  if (priorGoal === requestedGoal) return ["file_new_claim", "find_existing_claim"].includes(requestedGoal);
  return priorGoal === "file_new_claim" && requestedGoal === "find_existing_claim";
}

function allow(code, latestPriorCallId = "") {
  return { allowed: true, code, latestPriorCallId };
}

function deny(code, reason) {
  return { allowed: false, code, reason };
}
