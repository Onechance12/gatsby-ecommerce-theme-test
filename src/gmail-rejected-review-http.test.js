import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeAllowed } from "./auth/google-user.js";
import { CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS, CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES, CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID } from "./operations/thresher-policy.js";

const TOKEN = "fixture-rejected-review-mac-token-1234567890", HP_TOKEN = "fixture-rejected-review-hp-token-1234567890";
const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const query = "#990001";

test("rejected-original route is default-off, assigned Mac-only and POST-only", () => {
  const old = process.env.ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW;
  const mac = { type: "codex_operator_token", role: "codex_operator", subject: "codex-mac-operator" };
  try {
    delete process.env.ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW;
    assert.equal(routeAllowed(mac, "POST", "/gmail/rejected-review"), false);
    process.env.ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW = "true";
    assert.equal(routeAllowed(mac, "POST", "/gmail/rejected-review"), true);
    assert.equal(routeAllowed(mac, "GET", "/gmail/rejected-review"), false);
    for (const identity of [null, { ...mac, subject: "codex-hp-operator" }, { type: "bridge_token", role: "chance" },
      { type: "google_oauth", role: "administrator" }, { type: "hcn_browser_session", role: "chance" }]) {
      assert.equal(routeAllowed(identity, "POST", "/gmail/rejected-review"), false);
    }
  } finally {
    if (old === undefined) delete process.env.ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW;
    else process.env.ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW = old;
  }
});

async function fixture(t, { enabled = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "gmail-rejected-synthetic-"));
  const state = { providerEffects: 0, requests: [], wrongMailbox: false };
  const contact = (number, claim, owner = OWNER) => ({
    jnid: `synthetic-contact-${number}`, number, record_type_name: "Insurance", display_name: `Synthetic Client ${number}`,
    owners: [{ id: owner }], is_active: true, is_closed: false, is_archived: false, is_deleted: false,
    status_name: "Submitted Awaiting Confirmation", cf_string_2: claim,
    address_line1: `${number} Test Street`, city: "Test", state_text: "TX", zip: "75000"
  });
  const contacts = [contact(990001, "AB-1234567"), contact(990002, "CD-7654321"),
    contact(990003, "EF-9876543", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), contact(2628, "ZZ-9999999")];
  const mail = (id, body, subject = id) => ({ id, threadId: "thread1", labelIds: ["INBOX"], internalDate: String(Date.now()),
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "adjuster@example.test" }, { name: "To", value: "owner@example.test" },
      { name: "Subject", value: subject }], body: { data: Buffer.from(body).toString("base64url") } } });
  const messages = [
    mail("matched", "Claim AB-1234567 is under review."),
    mail("missing", "Please call me about our previous discussion."),
    mail("mixed", "Current AB-1234567 update. Quoted old CD-7654321 claim."),
    mail("other", "This only concerns CD-7654321."),
    mail("foreign", "Current AB-1234567 plus EF-9876543 FOREIGN-PRIVATE.", "FOREIGN-PRIVATE"),
    mail("excluded", "AB-1234567 plus ZZ-9999999 EXCLUDED-PRIVATE.", "EXCLUDED-PRIVATE"),
    mail("unknown", "See https://app.jobnimbus.com/contact/unknown-private-id UNKNOWN-PRIVATE.", "UNKNOWN-PRIVATE")
  ];
  const provider = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method !== "GET" && url.pathname !== "/oauth-token") state.providerEffects++;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth-token") return json(200, { access_token: "fixture-access-token", expires_in: 3600 });
    if (url.pathname === "/jn/contacts") return json(200, { contacts, count: contacts.length });
    const current = contacts.find(row => url.pathname === `/jn/contacts/${row.jnid}`);
    if (current) return json(200, current);
    if (["/jn/activities", "/jn/tasks", "/jn/files"].includes(url.pathname)) return json(200, { results: [], count: 0 });
    if (url.pathname === "/gmail/v1/users/me/profile") return json(200, { emailAddress: state.wrongMailbox ? "other@example.test" : "owner@example.test" });
    if (url.pathname === "/gmail/v1/users/me/messages") return json(200, { messages: messages.map(row => ({ id: row.id, threadId: row.threadId })) });
    const message = messages.find(row => url.pathname === `/gmail/v1/users/me/messages/${row.id}`);
    if (message) return json(200, state.wrongMessageIdentity ? { ...message, id: "substituted" } : message);
    if (url.pathname === "/gmail/v1/users/me/threads/thread1") return json(200, { id: "thread1", messages });
    return json(404, { error: "synthetic not found" });
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${provider.address().port}`;
  const manifest = { schemaVersion: 2, id: CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID, operatorScope: "assigned", assignmentMode: "live_assigned", assignmentOwnerId: OWNER,
    expiresAt: "2099-01-01T00:00:00.000Z", excludedFileNumbers: ["2628"], allowedActionTypes: [...CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES], allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS] };
  const child = spawn(process.execPath, ["src/server.js"], { cwd: process.cwd(), env: {
    PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), CODEX_MAC_OPERATOR_TOKEN: TOKEN,
    CODEX_OPERATOR_TOKEN: HP_TOKEN, JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token",
    CHANCE_JOBNIMBUS_OWNER_ID: OWNER, JOBNIMBUS_API_KEY: "fixture-key", JOBNIMBUS_API_BASE_URL: `${base}/jn`,
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture", GOOGLE_REFRESH_TOKEN: "fixture", GOOGLE_TOKEN_URL: `${base}/oauth-token`,
    GMAIL_API_BASE_URL: base, CHANCE_GOOGLE_EMAIL: "owner@example.test", ALLOW_GOOGLE_USER_AUTH: "false",
    MEMORY_ROOT: root, BRIDGE_DATA_DIR: root, BRIDGE_ALLOW_WRITES: "false", REQUIRE_CHANCE_RUN_POLICY: "true",
    CHANCE_OPERATOR_RUN_MANIFEST_JSON: JSON.stringify(manifest), ALLOW_OPERATOR_GMAIL_REJECTION_REVIEW: enabled ? "true" : "false"
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs += String(chunk); }); child.stderr.on("data", chunk => { logs += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  return { state, contacts, messages, request: async (route, body, token = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } };
}

const complete = { fileQuery: query, completeReview: true };
const candidateFor = (result, id) => result.body.rejectedReview.candidates.find(row => row.message?.id === id);

test("complete search and thread show why each rejected candidate was excluded without admitting it", async t => {
  const f = await fixture(t);
  for (const [route, input] of [["/gmail/search", complete], ["/gmail/thread", { ...complete, threadId: "thread1" }]]) {
    const result = await f.request(route, input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.messages.map(row => row.id), ["matched"]);
    assert.equal(result.body.rejectedReview.rejectedCount, 6);
    assert.equal(result.body.rejectedReview.contentReviewAvailable, 3);
    assert.equal(candidateFor(result, "missing").decision, "missing_unique_target_evidence");
    assert.equal(candidateFor(result, "mixed").decision, "conflicting_file_evidence");
    assert.equal(candidateFor(result, "other").decision, "conflicting_file_evidence");
    assert.equal(result.body.coverage.complete, false);
    assert.doesNotMatch(JSON.stringify(result.body), /FOREIGN-PRIVATE|EXCLUDED-PRIVATE|UNKNOWN-PRIVATE|unknown-private-id|EF-9876543|ZZ-9999999/);
    for (const row of result.body.rejectedReview.candidates.filter(row => !row.contentReviewAvailable)) {
      assert.equal(row.reviewRef, undefined); assert.equal(row.message, undefined);
    }
    const read = await f.request("/gmail/rejected-review", { fileQuery: query, reviewRef: candidateFor(result, "mixed").reviewRef });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.verifiedFileEvidence, false);
    assert.equal(read.body.authorizesAction, false);
    assert.match(read.body.message.plainText, /AB-1234567.*CD-7654321/);
    assert.equal(read.body.message.attachmentBodiesReviewed, false);
  }
  assert.equal(f.state.providerEffects, 0);
});

test("reference cannot open a different file, changed content, identity or forbidden parameters", async t => {
  const f = await fixture(t);
  const result = await f.request("/gmail/search", complete);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const input = { fileQuery: query, reviewRef: candidateFor(result, "missing").reviewRef };
  assert.equal((await f.request("/gmail/rejected-review", { ...input, fileQuery: "#990002" })).status, 403);
  assert.equal((await f.request("/gmail/rejected-review", { ...input, reviewRef: `${input.reviewRef}x` })).status, 403);
  for (const patch of [{ messageId: "matched" }, { execute: true }, { mailbox: "other@example.test" }]) {
    assert.equal((await f.request("/gmail/rejected-review", { ...input, ...patch })).status, 400);
  }
  for (const token of [HP_TOKEN, "fixture-shared-token"]) assert.equal((await f.request("/gmail/rejected-review", input, token)).status, 403);
  f.messages.find(row => row.id === "missing").payload.body.data = Buffer.from("changed content").toString("base64url");
  assert.equal((await f.request("/gmail/rejected-review", input)).status, 403);
  f.state.wrongMessageIdentity = true;
  assert.equal((await f.request("/gmail/rejected-review", input)).status, 403);
  assert.equal(f.state.providerEffects, 0);
});

test("wrong mailbox prevents message reads and disabled gate preserves existing reason-only review", async t => {
  const f = await fixture(t);
  f.state.wrongMailbox = true;
  const response = await f.request("/gmail/search", complete);
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(f.state.requests.some(row => row.includes("/messages")), false);
  const off = await fixture(t, { enabled: false });
  assert.equal((await off.request("/gmail/rejected-review", { fileQuery: query, reviewRef: "synthetic.reference" })).status, 403);
  assert.equal((await off.request("/gmail/search", { ...complete, includeRejectedReview: true })).status, 403);
  assert.equal(off.state.requests.length, 0);
  const legacy = await off.request("/gmail/search", { ...complete, includeCorrelationAudit: true });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.rejectedReview, undefined);
  assert.equal(legacy.body.correlationAudit.rows.length, 7);
  assert.deepEqual(legacy.body.messages.map(row => row.id), ["matched"]);
});

test("fresh inspection rechecks excluded or reassigned candidates, without disclosing content", async t => {
  const f = await fixture(t);
  const result = await f.request("/gmail/search", complete);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const input = { fileQuery: query, reviewRef: candidateFor(result, "mixed").reviewRef };
  f.contacts.find(row => row.number === 990002).owners = [{ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }];
  const read = await f.request("/gmail/rejected-review", input);
  assert.equal(read.status, 403, JSON.stringify(read.body));
  assert.doesNotMatch(JSON.stringify(read.body), /Quoted old|CD-7654321/);
  assert.equal(f.state.providerEffects, 0);
});

test("the full exact-file packet retains search and thread rejections, not as action evidence", async t => {
  const f = await fixture(t);
  const response = await f.request("/ops/review-chance-files", { query, limit: 1,
    includeCompleteJobNimbusEvidence: true, includeCompleteCommunicationEvidence: true,
    includeGmail: true, includeQuo: false });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const gmail = response.body.packets[0].gmail;
  assert.equal(gmail.status, "fresh", JSON.stringify(gmail));
  assert.equal(gmail.rejectedReview.rejectedCount, 6);
  assert.equal(gmail.correlationAudit.rows.length, 7);
  assert.equal(gmail.threads[0].rejectedReview.rejectedCount, 6);
  assert.equal(gmail.coverage.providerScanComplete, false);
  assert.deepEqual(gmail.messages.map(row => row.id), ["matched"]);
  assert.doesNotMatch(JSON.stringify(response.body), /FOREIGN-PRIVATE|EXCLUDED-PRIVATE|UNKNOWN-PRIVATE/);
  assert.equal(f.state.providerEffects, 0);
});

test("current target reassignment denies inspection before Gmail content reads", async t => {
  const f = await fixture(t);
  const result = await f.request("/gmail/search", complete);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const input = { fileQuery: query, reviewRef: candidateFor(result, "missing").reviewRef };
  f.contacts[0].is_closed = true;
  const requestCount = f.state.requests.length;
  const read = await f.request("/gmail/rejected-review", input);
  assert.equal(read.status, 403, JSON.stringify(read.body));
  assert.equal(f.state.requests.slice(requestCount).some(row => row.includes("/gmail/")), false);
});

test("thread candidate caps report omitted rejections rather than hiding them", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 244; index++) f.messages.push({ ...f.messages[1], id: `overflow-${index}` });
  const response = await f.request("/gmail/thread", { ...complete, threadId: "thread1" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.correlationAudit.scannedCandidates, 251);
  assert.equal(response.body.rejectedReview.rejectedCount, 250);
  assert.equal(response.body.rejectedReview.reportedCandidates, 249);
  assert.equal(response.body.rejectedReview.omittedCandidates, 1);
  assert.equal(response.body.coverage.complete, false);
});

test("an incomplete identity predicate yields only the first failure, no rejected metadata", async t => {
  const f = await fixture(t);
  f.contacts[1].email = { invalid: "PRIVATE-INCOMPLETE" };
  const response = await f.request("/gmail/search", complete);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.messages.length, 0);
  for (const row of response.body.rejectedReview.candidates) {
    assert.equal(row.decision, "incomplete_correlation_index");
    assert.equal(row.access, "incomplete_identity_index");
    assert.equal(row.message, undefined);
    assert.equal(row.reviewRef, undefined);
  }
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE-INCOMPLETE|FOREIGN-PRIVATE|EXCLUDED-PRIVATE/);
});
