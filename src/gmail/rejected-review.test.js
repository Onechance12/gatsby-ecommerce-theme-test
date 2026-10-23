import test from "node:test";
import assert from "node:assert/strict";
import { createRejectedGmailReferences, createRejectedReviewReport, rejectedMessageFingerprint,
  rejectedReviewMetadata, rejectedReviewBody, boundRejectedReviewForPacket } from "./rejected-review.js";

const binding = { subject: "synthetic-operator", fileId: "synthetic-file", mailbox: "owner@example.test", policySha256: "a".repeat(64) };
const message = { id: "message1", threadId: "thread1", from: "carrier@example.test", to: binding.mailbox,
  subject: "Synthetic claim", date: "Thu, 1 Oct 2026 10:00:00 -0500", internalDate: "1790866800000", labelIds: ["INBOX"],
  plainText: "Synthetic content, not action instructions.", htmlText: "Synthetic content.",
  attachments: [{ filename: "synthetic.pdf", mimeType: "application/pdf", size: 12, attachmentId: "PRIVATE-ATTACHMENT-ID", attachmentRef: "PRIVATE-REF" }] };
const decision = "missing_unique_target_evidence";
const candidate = { messageId: message.id, threadId: message.threadId,
  contentSha256: rejectedMessageFingerprint(message, "full synthetic content"), decision };

test("inspection references bind exact file, mailbox, principal, policy, message and expiry", () => {
  let now = 1000;
  const references = createRejectedGmailReferences({ secret: Buffer.alloc(32, 1), now: () => now, lifetimeMs: 50 });
  const ref = references.create(binding, candidate);
  assert.deepEqual(references.resolve(ref, binding), { v: 1, purpose: "rejected_email_inspection", binding,
    ...candidate, expiresAt: 1050 });
  for (const key of Object.keys(binding)) assert.throws(() => references.resolve(ref, { ...binding, [key]: "other" }), /invalid/);
  assert.throws(() => references.resolve(`${ref}x`, binding), /invalid/);
  assert.throws(() => createRejectedGmailReferences().resolve(ref, binding), /invalid/);
  now = 1050;
  assert.throws(() => references.resolve(ref, binding), /expired/);
});

test("references refuse arbitrary provider paths, matched decisions and unbound identities", () => {
  const references = createRejectedGmailReferences();
  for (const patch of [{ messageId: "../drafts" }, { threadId: "https://other" }, { decision: "matched" }, { contentSha256: "x" }]) {
    assert.equal(references.create(binding, { ...candidate, ...patch }), null);
  }
  assert.equal(references.create({ ...binding, mailbox: "" }, candidate), null);
  for (const value of [null, "", "a.b.c", "x".repeat(5000)]) assert.throws(() => references.resolve(value, binding));
});

test("fingerprints change with full content, source identity, labels and attachment metadata", () => {
  const fingerprint = rejectedMessageFingerprint(message, "full synthetic content");
  for (const patch of [{ id: "other" }, { threadId: "other" }, { labelIds: ["SENT"] }, { internalDate: "2" }, { attachments: [] }]) {
    assert.notEqual(rejectedMessageFingerprint({ ...message, ...patch }, "full synthetic content"), fingerprint);
  }
  assert.notEqual(rejectedMessageFingerprint(message, "changed late content"), fingerprint);
});

test("candidate report separates inspection from admission and preserves exclusion reasons", () => {
  const references = createRejectedGmailReferences();
  const report = createRejectedReviewReport({ mailbox: binding.mailbox, binding, references });
  report.record({ message, fullContent: "full synthetic content", auditRow: { candidateNumber: 2, disposition: "withheld", decision }, access: "reviewable" });
  report.record({ message, fullContent: "full synthetic content", auditRow: { candidateNumber: 3, disposition: "excluded_other_file", decision: "conflicting_file_evidence" }, access: "reviewable" });
  const result = report.snapshot();
  assert.equal(result.verifiedFileEvidence, false);
  assert.equal(result.authorizesAction, false);
  assert.equal(result.rejectedCount, 2);
  assert.equal(result.contentReviewAvailable, 2);
  assert.equal(result.candidates[0].message.id, message.id);
  assert.equal(result.candidates[1].disposition, "excluded_other_file");
  assert.equal(references.resolve(result.candidates[0].reviewRef, binding).messageId, message.id);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic content|PRIVATE-/);
  result.candidates[0].message.subject = "tampered";
  assert.equal(report.snapshot().candidates[0].message.subject, message.subject);
});

test("redaction and cap short-circuit all private metadata and reference creation", () => {
  const inaccessible = new Proxy({}, { get() { throw new Error("private metadata inspected"); } });
  const report = createRejectedReviewReport({ mailbox: binding.mailbox, binding,
    references: inaccessible, maxCandidates: 2 });
  for (const access of ["restricted_file_evidence", "incomplete_identity_index", "unknown_file_reference"]) {
    report.record({ message: inaccessible, auditRow: { candidateNumber: 1, disposition: "withheld", decision }, access });
  }
  report.recordOmitted();
  const result = report.snapshot();
  assert.equal(result.rejectedCount, 4);
  assert.equal(result.reportedCandidates, 2);
  assert.equal(result.omittedCandidates, 2);
  for (const row of result.candidates) {
    assert.equal(row.contentReviewAvailable, false);
    assert.equal(row.message, undefined);
    assert.equal(row.reviewRef, undefined);
  }
});

test("bounded inspection exposes text and attachment names, never download handles", () => {
  const result = rejectedReviewBody({ ...message, plainText: "x".repeat(65000) }, binding.mailbox);
  assert.equal(result.bodyTruncated, true);
  assert.equal(result.plainText.length, 64000);
  assert.equal(result.attachmentBodiesReviewed, false);
  assert.deepEqual(Object.keys(result.attachments[0]), ["filename", "mimeType", "size"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
  assert.equal(rejectedReviewMetadata({ ...message, subject: "x".repeat(2001) }, binding.mailbox).metadataTruncated, true);
  assert.equal(rejectedReviewMetadata({ ...message, labelIds: Array(101).fill("label") }, binding.mailbox).metadataTruncated, true);
});

test("combined file packet has one candidate/byte budget across search and threads", () => {
  const report = { rejectedCount: 3, candidates: [{ contentReviewAvailable: true }, { contentReviewAvailable: false }, { contentReviewAvailable: true }] };
  const budget = { candidates: 2, bytes: 1000 };
  const search = boundRejectedReviewForPacket(report, budget);
  const thread = boundRejectedReviewForPacket(report, budget);
  assert.equal(search.reportedCandidates, 2);
  assert.equal(search.contentReviewAvailable, 1);
  assert.equal(search.omittedCandidates, 1);
  assert.equal(thread.reportedCandidates, 0);
  assert.equal(thread.omittedCandidates, 3);
  assert.equal(thread.packetLimitReached, true);
  assert.equal(boundRejectedReviewForPacket(report, { candidates: 250, bytes: 1 }).reportedCandidates, 0);
});
