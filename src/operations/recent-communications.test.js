import test from "node:test";
import assert from "node:assert/strict";
import { communicationsWindow, buildRecentCommunicationsReview } from "./recent-communications.js";

const ada = { id: "file-ada", number: "4101", name: "Ada Example", address: "100 Test St, Test TX", phone: "+12145550101", claimNumber: "AB-1234567", policyNumber: "POL-7654321", status: "Submitted Awaiting Confirmation" };
const bob = { id: "file-bob", number: "4102", name: "Bob Example", address: "102 Test St, Test TX", phone: "+12145550102", claimNumber: "AB-2222222" };
const coverage = { gmail: { complete: true }, quo: { complete: true } };
const mail = (id, atUtc, extra = {}) => ({ id, atUtc, channel: "gmail", type: "email", conversationId: "thread-a", direction: "incoming", text: "Claim AB-1234567", ...extra });

test("discovery defaults to seven exact days and rejects scope/effect injection", () => {
  const result = communicationsWindow({}, Date.parse("2026-10-20T17:00:00Z"));
  assert.equal(result.start, "2026-10-13T17:00:00.000Z");
  for (const input of [{ days: 31 }, { days: "7" }, { source: "company" }, { execute: true }, { mailbox: "other@test" }, { phone: "+12145550100" }, { query: "anything" }, { operatorScope: "company" }]) {
    assert.throws(() => communicationsWindow(input));
  }
});

test("unknown-number voicemail matches exact claim; unknown caller stays visible", () => {
  const result = buildRecentCommunicationsReview({ files: [ada], coverage, items: [
    { id: "AC1", channel: "quo", type: "voicemail", direction: "incoming", participants: ["+18005550199"], voicemail: "Calling about AB-1234567", atUtc: "2026-10-20T16:00:00Z" },
    { id: "AC2", channel: "quo", type: "missed_call", direction: "incoming", participants: ["+18005550200"], atUtc: "2026-10-20T16:10:00Z" }
  ] });
  assert.equal(result.effectsAuthorized, false);
  assert.equal(result.queue.find(i => i.id === "AC1").fileMatch.file.number, "4101");
  assert.equal(result.queue.find(i => i.id === "AC2").fileMatch.status, "unmatched");
});

test("shared carrier numbers, surname, partial claim and policy alone do not establish a file", () => {
  const files = [ada, { ...bob, adjusterPhone: "+18005550199" }];
  for (const text of ["Example", "AB-12345670", "POL-7654321"]) {
    const result = buildRecentCommunicationsReview({ files, coverage, items: [mail("m", "2026-10-20T16:00:00Z", { text, participants: ["+18005550199"] })] });
    assert.equal(result.queue[0].fileMatch.status, "unmatched", text);
  }
});

test("excluded and nonassigned file evidence is withheld, including mixed claims", () => {
  const excluded = { ...bob, number: "2628" };
  for (const text of ["AB-2222222", "AB-1234567 and AB-2222222"]) {
    const result = buildRecentCommunicationsReview({ files: [ada], inventory: [ada, excluded], coverage, items: [mail("m", "2026-10-20T16:00:00Z", { text })] });
    assert.equal(result.queue.length, 0);
    assert.equal(result.withheldOtherFileItems, 1);
    assert.doesNotMatch(JSON.stringify(result), /AB-2222222/);
  }
});

test("draft, sent contact, human reply, and automatic acknowledgment remain distinct", () => {
  const result = buildRecentCommunicationsReview({ files: [ada], coverage, items: [
    mail("incoming", "2026-10-15T10:00:00Z"),
    mail("draft", "2026-10-15T11:00:00Z", { direction: "draft" }),
    mail("sent", "2026-10-15T12:00:00Z", { direction: "outgoing" }),
    mail("auto", "2026-10-15T12:01:00Z", { automaticReply: true }),
    mail("human", "2026-10-16T12:00:00Z")
  ] });
  const item = result.queue.find(i => i.id === "incoming");
  assert.deepEqual(item.followThrough.laterDraftIds, ["draft"]);
  assert.deepEqual(item.followThrough.laterSentContactIds, ["sent"]);
  assert.deepEqual(item.followThrough.laterAutomaticReplyIds, ["auto"]);
  assert.deepEqual(item.followThrough.laterHumanEmailIds, ["human"]);
  assert.equal(item.followThrough.resolutionVerified, false);
});

test("partial source and output limits never become a clean sweep", () => {
  const result = buildRecentCommunicationsReview({ files: [ada], coverage: { gmail: { complete: false, status: "unavailable" }, quo: { complete: true } },
    items: [mail("a", "2026-10-15T10:00:00Z"), mail("b", "2026-10-15T11:00:00Z")], maxResults: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.omittedItems, 1);
});

test("delivery failures require review and do not count as human replies or acknowledgments", () => {
  const result = buildRecentCommunicationsReview({ files: [ada], coverage, items: [
    mail("sent", "2026-10-15T10:00:00Z", { direction: "outgoing" }),
    mail("bounce", "2026-10-15T11:00:00Z", { automaticReply: true, deliveryFailure: true })
  ] });
  const bounce = result.queue.find(item => item.id === "bounce");
  assert.equal(bounce.classification, "delivery_failure_review");
  assert.equal(bounce.reviewRequired, true);
  const sent = result.queue.find(item => item.id === "sent");
  assert.deepEqual(sent.followThrough.laterDeliveryFailureIds, ["bounce"]);
  assert.deepEqual(sent.followThrough.laterAutomaticReplyIds, []);
  assert.deepEqual(sent.followThrough.laterHumanEmailIds, []);
});

test("shared restricted homeowner phone is withheld without claim-specific proof", () => {
  const excluded = { ...bob, number: "2628", phone: "+18005550199" };
  const own = { ...ada, adjusterPhone: excluded.phone };
  const items = [{ id: "ACrestricted", channel: "quo", type: "voicemail", direction: "incoming", participants: [excluded.phone],
    voicemail: "Unidentified speech", atUtc: "2026-10-20T10:00:00Z" }];
  const result = buildRecentCommunicationsReview({ items, files: [own], inventory: [own, excluded], coverage });
  assert.equal(result.queue.length, 0);
  assert.equal(result.withheldOtherFileItems, 1);
  items[0].voicemail = "Calling about claim AB-1234567";
  assert.equal(buildRecentCommunicationsReview({ items, files: [own], inventory: [own, excluded], coverage }).queue[0].fileMatch.file.number, "4101");
});
