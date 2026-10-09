import assert from "node:assert/strict";
import test from "node:test";
import { findOutboundReservationConflict } from "./reservation-policy.js";

const oldContent = "a".repeat(64);
const newContent = "b".repeat(64);
const scope = "c".repeat(64);
const current = {
  channel: "gmail_draft", approvalDigest: "new-approval", sourceKeyHash: scope,
  contentDigest: newContent, legacyApprovalDigest: "new-intent-legacy-digest",
  reviewedDraftReservationIds: ["old-reservation"]
};
const completed = {
  id: "old-reservation", channel: "gmail_draft", approvalDigest: "old-approval",
  sourceKeyHash: scope, status: "completed", externalId: "old-draft", contentDigest: oldContent
};

test("a completed draft permits a different approved content revision without changing history", () => {
  const rows = [structuredClone(completed)];
  const before = structuredClone(rows);
  assert.equal(findOutboundReservationConflict(rows, current), null);
  assert.deepEqual(rows, before);
});

test("identical draft content stays blocked even with another approval, recipient-thread attempt or ordering", () => {
  assert.equal(findOutboundReservationConflict([completed], { ...current, contentDigest: oldContent }), completed);
  assert.equal(findOutboundReservationConflict([completed, { ...completed, contentDigest: newContent }], current)?.contentDigest, newContent);
  assert.equal(findOutboundReservationConflict([{ ...completed, contentDigest: newContent }, completed], current)?.contentDigest, newContent);
});

test("current and legacy exact approvals remain single-use after the plan-version transition", () => {
  assert.equal(findOutboundReservationConflict([completed], { ...current, approvalDigest: "old-approval" }), completed);
  const legacy = { ...completed };
  delete legacy.contentDigest;
  assert.equal(findOutboundReservationConflict([legacy], { ...current, legacyApprovalDigest: "old-approval" }), legacy);
  assert.equal(findOutboundReservationConflict([legacy], current), null);
});

test("an unreviewed completed reservation blocks overlapping new draft creation", () => {
  const newlyCompleted = { ...completed, id: "concurrent-completed-reservation" };
  assert.equal(findOutboundReservationConflict([completed, newlyCompleted], current), newlyCompleted);
  for (const reviewedDraftReservationIds of [null, [], ["another-reservation"]]) {
    assert.equal(findOutboundReservationConflict([completed], {
      ...current, reviewedDraftReservationIds
    }), completed);
  }
  assert.equal(findOutboundReservationConflict([completed, newlyCompleted], {
    ...current, reviewedDraftReservationIds: [completed.id, newlyCompleted.id]
  }), null);
});

test("every unresolved draft outcome blocks new wording on that claim", () => {
  for (const status of ["in_progress", "readback_pending", "failed_requires_review", "failed", "unknown", "", "completed_pending_verification"]) {
    for (const withDigest of [true, false]) {
      const row = { ...completed, status };
      if (!withDigest) delete row.contentDigest;
      assert.equal(findOutboundReservationConflict([row], current), row, status);
    }
  }
});

test("incomplete or corrupt completed draft receipts are not treated as permission", () => {
  for (const changes of [{ externalId: "" }, { externalId: null }, { contentDigest: "" }, { contentDigest: null }, { contentDigest: "bad" }]) {
    const row = { ...completed, ...changes };
    assert.equal(findOutboundReservationConflict([row], current), row);
  }
  assert.equal(findOutboundReservationConflict([completed], { ...current, contentDigest: "" }), completed);
});

test("only reconciled not-applied reservations are reusable; another unresolved row still blocks", () => {
  const notApplied = { ...completed, approvalDigest: current.approvalDigest, status: "verified_not_applied" };
  assert.equal(findOutboundReservationConflict([notApplied], current), null);
  const unresolved = { ...completed, status: "in_progress" };
  assert.equal(findOutboundReservationConflict([notApplied, unresolved], current), unresolved);
});

test("Gmail sends and Quo retain source locks regardless of completed status or content changes", () => {
  for (const channel of ["gmail", "quo"]) {
    const row = { ...completed, channel };
    assert.equal(findOutboundReservationConflict([row], { ...current, channel }), row);
  }
});

test("other channels and other claim resources neither grant nor block this draft intent", () => {
  assert.equal(findOutboundReservationConflict([
    { ...completed, channel: "gmail" }, { ...completed, sourceKeyHash: "d".repeat(64) }
  ], current), null);
});
