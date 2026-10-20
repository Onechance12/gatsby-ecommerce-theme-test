import test from "node:test";
import assert from "node:assert/strict";
import { readRecentGmailActivity } from "./recent-activity.js";
import { communicationsWindow } from "../operations/recent-communications.js";
const window = communicationsWindow({}, Date.parse("2026-10-20T17:00:00Z"));
const compact = row => row.fixture;
const message = (id, labelIds, extra = {}) => ({ id, threadId: "thread", internalDate: String(Date.parse("2026-10-15T10:00:00Z")), labelIds,
  fixture: { from: "carrier@example.test", to: "owner@example.test", subject: "Claim", plainText: "Reply", attachments: [] }, ...extra });

test("mailbox is verified before discovery and scheduling words are not required", async () => {
  const requests = [];
  const rows = [message("incoming", ["INBOX"]), message("sent", ["SENT"]), message("draft", ["DRAFT"]), message("auto", ["INBOX"], { payload: { headers: [{ name: "Auto-Submitted", value: "auto-replied" }] } })];
  const result = await readRecentGmailActivity({ window, mailbox: "owner@example.test", compact, readJson: async path => {
    requests.push(path);
    if (path.endsWith("/profile")) return { emailAddress: "owner@example.test" };
    if (path.includes("/messages?")) { assert.doesNotMatch(new URL(path, "https://test").searchParams.get("q"), /inspection|schedule/); return { messages: rows.map(r => ({ id: r.id, threadId: r.threadId })) }; }
    return rows.find(row => path.includes(`/messages/${row.id}?`));
  } });
  assert.deepEqual(result.items.map(row => row.direction), ["incoming", "outgoing", "draft", "incoming"]);
  assert.equal(result.items[3].automaticReply, true);
  assert.equal(result.coverage.complete, true);
  assert.equal(requests[0], "/gmail/v1/users/me/profile");
});

test("wrong mailbox cannot read messages", async () => {
  const requests = [];
  await assert.rejects(readRecentGmailActivity({ window, mailbox: "owner@example.test", compact, readJson: async path => { requests.push(path); return { emailAddress: "someone-else@example.test" }; } }), /binding failed/);
  assert.equal(requests.length, 1);
});

test("repeated pagination and mismatched provider IDs are incomplete", async () => {
  const result = await readRecentGmailActivity({ window, mailbox: "owner@example.test", compact, readJson: async path => {
    if (path.endsWith("/profile")) return { emailAddress: "owner@example.test" };
    if (path.includes("/messages?")) return { messages: [{ id: "x", threadId: "thread" }], nextPageToken: "repeat" };
    return message("wrong", ["INBOX"]);
  } });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.limitationCodes.includes("message_identity_mismatch"));
  assert.ok(result.coverage.limitationCodes.includes("repeated_page_token"));
});

test("bounced email is not a human response or a successful acknowledgment", async () => {
  const row = message("bounce", ["INBOX"]);
  row.fixture.subject = "Undeliverable: claim documents";
  const result = await readRecentGmailActivity({ window, mailbox: "owner@example.test", compact, readJson: async path => {
    if (path.endsWith("/profile")) return { emailAddress: "owner@example.test" };
    if (path.includes("/messages?")) return { messages: [{ id: row.id, threadId: row.threadId }] };
    return row;
  } });
  assert.equal(result.items[0].deliveryFailure, true);
  assert.equal(result.items[0].automaticReply, true);
});
