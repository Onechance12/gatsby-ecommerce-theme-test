import test from "node:test";
import assert from "node:assert/strict";
import { readRecentQuoActivity } from "./recent-activity.js";
import { communicationsWindow } from "../operations/recent-communications.js";
const window = communicationsWindow({}, Date.parse("2026-10-20T17:00:00Z"));
const lineNumber = "+19725550100", external = "+12145550199";
const call = extra => ({ id: "ACmissed", phoneNumberId: "PNowner", direction: "incoming", status: "completed", duration: 0,
  participants: [external], createdAt: "2026-10-20T16:00:00Z", ...extra });
function fixture(overrides = {}) {
  const requests = [];
  return { requests, readJson: async path => {
    requests.push(path);
    const url = new URL(path, "https://fixture.test");
    if (overrides[url.pathname]) return overrides[url.pathname](url);
    if (url.pathname === "/phone-numbers") return { data: [{ id: "PNowner", number: lineNumber }, { id: "PNother", number: "+19725550101" }] };
    if (url.pathname === "/conversations") { assert.deepEqual(url.searchParams.getAll("phoneNumbers"), ["PNowner"]); return { data: [{ id: "CN1", phoneNumberId: "PNowner", participants: [external], updatedAt: "2026-10-20T16:00:00Z" }] }; }
    if (url.pathname === "/calls") return { data: [call()] };
    if (url.pathname === "/messages") return { data: [] };
    if (url.pathname === "/call-voicemails/ACmissed") return { data: { id: "VM1", status: "completed", transcript: "Calling about claim AB-1234567." } };
    throw new Error("Unexpected fixture request");
  } };
}

test("own-line unknown caller and completed-zero-duration missed call retrieve actual voicemail", async () => {
  const provider = fixture();
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.equal(result.items[0].type, "voicemail");
  assert.match(result.items[0].voicemail, /AB-1234567/);
  assert.ok(provider.requests.includes("/call-voicemails/ACmissed"));
  assert.equal(result.coverage.companyLinesScanned, false);
  assert.equal(result.coverage.complete, true);
});

test("a different line's conversation is withheld before reading its calls", async () => {
  const provider = fixture({ "/conversations": () => ({ data: [{ id: "CNother", phoneNumberId: "PNother", participants: [external] }] }) });
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.equal(result.items.length, 0);
  assert.equal(provider.requests.some(path => path.startsWith("/calls")), false);
  assert.ok(result.coverage.limitationCodes.includes("invalid_conversation_scope"));
});

test("pending voicemail remains visible and incomplete, not no voicemail", async () => {
  const provider = fixture({ "/call-voicemails/ACmissed": () => ({ data: { status: "in-progress", transcript: null } }),
    "/call-transcripts/ACmissed": () => ({ data: { status: "in-progress", callId: "ACmissed", dialogue: [] } }) });
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.equal(result.items[0].voicemailStatus, "in-progress");
  assert.equal(result.coverage.complete, false);
});

test("wrong-call transcript and wrong-participant activity cannot be disclosed", async () => {
  const provider = fixture({ "/calls": () => ({ data: [call({ id: "ACanswer", duration: 60, answeredBy: "US1" }), call({ id: "ACwrong", participants: ["+12145550999"] })] }),
    "/call-voicemails/ACanswer": () => { const error = new Error("not found"); error.statusCode = 404; throw error; },
    "/call-transcripts/ACanswer": () => ({ data: { callId: "ACother", status: "completed", dialogue: [{ content: "PRIVATE WRONG CALL" }] } }) });
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.equal(result.items.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE WRONG CALL|ACwrong/);
  assert.equal(result.coverage.complete, false);
});

test("repeated conversation page never claims complete", async () => {
  const provider = fixture({ "/conversations": () => ({ data: [], nextPageToken: "repeat" }) });
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.ok(result.coverage.limitationCodes.includes("repeated_page_token"));
  assert.equal(result.coverage.complete, false);
});

test("malformed message text is withheld and media-only messages disclose their review gap", async () => {
  const provider = fixture({ "/calls": () => ({ data: [] }), "/messages": () => ({ data: [
    { id: "Mbad", phoneNumberId: "PNowner", direction: "incoming", status: "delivered", from: external, to: [lineNumber], createdAt: "2026-10-20T16:00:00Z", content: { private: "not text" } },
    { id: "Mphoto", phoneNumberId: "PNowner", direction: "incoming", status: "delivered", from: external, to: [lineNumber], createdAt: "2026-10-20T16:01:00Z", content: "", media: [{ mimeType: "image/jpeg" }] }
  ] }) });
  const result = await readRecentQuoActivity({ ...provider, lineNumber, window });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].attachmentCount, 1);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.limitationCodes.includes("message_attachments_not_reviewed"));
  assert.doesNotMatch(JSON.stringify(result), /not text|Mbad/);
});
