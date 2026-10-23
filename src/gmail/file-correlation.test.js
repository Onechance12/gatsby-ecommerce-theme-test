import assert from "node:assert/strict";
import test from "node:test";
import {
  claimSearchVariants, createClaimIdentifierMatcher,
  emptyGmailWithheldReasonCounts, gmailCorrelationDecision
} from "./file-correlation.js";
test("claim correlation preserves exact identity across bounded formatting changes", () => {
  for (const content of [
    "Claim ABC-123", "Claim abc123", "Claim AB-C1-23", "Claim ABC 123",
    "Claim AB C1 23", "Claim ABC - 123", "Claim ABC\t123", "Claim ABC\u00a0123",
    "Claim ABC\u202f123", "Claim#ABC-123", "Claim # ABC123",
    "Claim No.#ABC123", "CLAIM NUMBER#ABC-123", "Re: Claim#ABC 123",
    "Claim ABC.123", "Claim ABC/123", "Claim ABC_123", "Claim ABC#123",
    ...["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\ufe58", "\ufe63", "\uff0d"]
      .map(dash => `Claim ABC${dash}123`)
  ]) {
    const matcher = createClaimIdentifierMatcher(content);
    assert.equal(matcher.has("abc123"), true, content);
    assert.equal(matcher.has("abc123"), true, `cached: ${content}`);
  }
});

test("claim correlation never admits substring, fuzzy, cross-line or arbitrary-prefix matches", () => {
  for (const content of [
    "XABC123", "ABC1234", "X-ABC-123", "ABC-123-4", "X--ABC123",
    "ABC123--X", "X\u2011ABC123", "ABC123\u2011X", "Other#ABC-123",
    "OtherClaim#ABC123", "Other-Claim#ABC123", "éABC123", "ABC123é",
    "ABC124", "ABC;123", "ABC:123", "ABC\n123", "ABC\r\n123",
    "ABC\u200b123", "Thank you. We received the update.", ""
  ]) assert.equal(createClaimIdentifierMatcher(content).has("abc123"), false, content);
  for (const value of ["", "a", "abc-123", "ABC123", "a".repeat(161), null, {}, ".*abc123"])
    assert.equal(createClaimIdentifierMatcher("ABC123").has(value), false);
  assert.equal(createClaimIdentifierMatcher("X-ABC123; separate claim ABC123").has("abc123"), true);
  assert.equal(createClaimIdentifierMatcher("AB\u212a123").has("abk123"), false, "Unicode lookalikes are not formatting changes");
});

test("target and foreign claim checks use the identical matcher", () => {
  for (const content of ["ABC123 and XYZ 987", "Claim#ABC123 and Claim#XYZ-987", "ABC\u2011123; XYZ\u2014987"]) {
    const matcher = createClaimIdentifierMatcher(content);
    assert.equal(matcher.has("abc123"), true);
    assert.equal(matcher.has("xyz987"), true);
  }
});

test("search variants are bounded exact-file derivations, not invented query fragments", () => {
  assert.deepEqual(claimSearchVariants("ABC-123"), ["ABC-123", "ABC123"]);
  assert.deepEqual(claimSearchVariants("ABC\u2011123"), ["ABC\u2011123", "ABC-123", "ABC123"]);
  assert.deepEqual(claimSearchVariants("ABC 123"), ["ABC 123", "ABC123"]);
  assert.deepEqual(claimSearchVariants("ABC123"), ["ABC123"]);
  assert.deepEqual(claimSearchVariants(""), []);
  assert.deepEqual(claimSearchVariants("ABC-123 from:anyone"), ["ABC-123 from:anyone"]);
});

test("diagnostics disclose only the first fixed failed correlation category", () => {
  const indexFailure = { complete: false };
  Object.defineProperty(indexFailure, "conflictingFileIds", { get() { throw new Error("later predicate inspected"); } });
  assert.equal(gmailCorrelationDecision(indexFailure), "incomplete_correlation_index");
  const conflict = { complete: true, conflictingFileIds: ["synthetic-private-id"] };
  Object.defineProperty(conflict, "targetMatch", { get() { throw new Error("later predicate inspected"); } });
  assert.equal(gmailCorrelationDecision(conflict), "conflicting_file_evidence");
  assert.equal(gmailCorrelationDecision({ complete: true, conflictingFileIds: [], conflictingFileReference: true }), "conflicting_file_evidence");
  assert.equal(gmailCorrelationDecision({ complete: true, conflictingFileIds: [], targetMatch: false }), "missing_unique_target_evidence");
  assert.equal(gmailCorrelationDecision({ complete: true, conflictingFileIds: [], targetMatch: true }), "matched");
  const first = emptyGmailWithheldReasonCounts();
  first.missing_unique_target_evidence += 1;
  assert.deepEqual(emptyGmailWithheldReasonCounts(), {
    incomplete_correlation_index: 0, conflicting_file_evidence: 0, missing_unique_target_evidence: 0
  });
  assert.doesNotMatch(JSON.stringify(first), /synthetic-private-id/);
});
test("claim explanation uses the same decision and reports longer-identifier boundaries without values", () => {
  for (const [text, reason, boundaries] of [
    ["Claim ABC-123.pdf", "longer_identifier_boundary", ["longer_identifier_suffix"]],
    ["OTHER#ABC123", "longer_identifier_boundary", ["longer_identifier_prefix"]],
    ["ABC123-EXTRA", "longer_identifier_boundary", ["longer_identifier_suffix"]],
    ["ABC\n123", "no_bounded_match", []],
    ["XABC123", "no_bounded_match", []],
    ["ABC-123 report.pdf", "matched", []],
    ["OTHER#ABC123 then claim ABC123", "matched", []]
  ]) {
    const matcher = createClaimIdentifierMatcher(text);
    const explanation = matcher.explain("abc123");
    assert.equal(matcher.has("abc123"), reason === "matched", text);
    assert.deepEqual(explanation, { matched: reason === "matched", reason, rejectedBoundaries: boundaries });
    explanation.rejectedBoundaries.push("tampered");
    assert.deepEqual(matcher.explain("abc123").rejectedBoundaries, boundaries);
    assert.doesNotMatch(JSON.stringify(matcher.explain("abc123")), /ABC|abc123|OTHER|\.pdf/);
  }
  assert.equal(createClaimIdentifierMatcher("arbitrary").explain("x").reason, "invalid_identifier");
});
