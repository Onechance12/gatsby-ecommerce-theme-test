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

const TOKEN = "fixture-communications-mac-token-1234567890";
const HP_TOKEN = "fixture-communications-hp-token-1234567890";
const OWNER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LINE = "+12025550101", OTHER = "+12025550102";

test("new route is default-off, Mac-only and POST-only; old broad routes stay unchanged", () => {
  const original = process.env.ALLOW_OPERATOR_COMMUNICATION_SWEEP;
  const mac = { type: "codex_operator_token", role: "codex_operator", subject: "codex-mac-operator" };
  try {
    delete process.env.ALLOW_OPERATOR_COMMUNICATION_SWEEP;
    assert.equal(routeAllowed(mac, "POST", "/ops/recent-communications"), false);
    process.env.ALLOW_OPERATOR_COMMUNICATION_SWEEP = "true";
    assert.equal(routeAllowed(mac, "POST", "/ops/recent-communications"), true);
    assert.equal(routeAllowed(mac, "GET", "/ops/recent-communications"), false);
    assert.equal(routeAllowed(mac, "POST", "/ops/recover-scheduling-communications"), false);
    for (const identity of [null, { ...mac, subject: "codex-hp-operator" }, { type: "bridge_token", role: "chance" },
      { type: "google_oauth", role: "administrator" }, { type: "hcn_browser_session", role: "chance" }]) {
      assert.equal(routeAllowed(identity, "POST", "/ops/recent-communications"), false);
    }
  } finally {
    if (original === undefined) delete process.env.ALLOW_OPERATOR_COMMUNICATION_SWEEP;
    else process.env.ALLOW_OPERATOR_COMMUNICATION_SWEEP = original;
  }
});

async function fixture(t, enabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), "communications-sweep-synthetic-"));
  const state = { providerEffects: 0, requests: [] };
  const contact = (number, claim, owners = [{ id: OWNER }]) => ({
    jnid: `synthetic-contact-${number}`, number, record_type_name: "Insurance", display_name: `Synthetic Client ${number}`,
    owners, is_active: true, is_closed: false, is_archived: false, is_deleted: false,
    status_name: "Submitted Awaiting Confirmation", mobile_phone: number === 990001 ? OTHER : "+12025550999",
    cf_string_2: claim, address_line1: `${number} Test Street`, city: "Test", state_text: "TX", zip: "75000"
  });
  const contacts = [contact(990001, "AB-1234567"), contact(2628, "ZZ-9999999")];
  const stamp = Date.now() - 3600000;
  const messages = [
    { id: "mail1", threadId: "thread1", labelIds: ["INBOX"], internalDate: String(stamp), payload: {
      mimeType: "text/plain", headers: [{ name: "From", value: "adjuster@example.test" }, { name: "To", value: "owner@example.test" }, { name: "Subject", value: "AB-1234567" }],
      body: { data: Buffer.from("Please call about claim AB-1234567.").toString("base64url") }
    } },
    { id: "excluded", threadId: "thread2", labelIds: ["INBOX"], internalDate: String(stamp), payload: {
      mimeType: "text/plain", headers: [{ name: "From", value: "adjuster@example.test" }, { name: "Subject", value: "ZZ-9999999" }],
      body: { data: Buffer.from("EXCLUDED PRIVATE BODY claim ZZ-9999999").toString("base64url") }
    } }
  ];
  const provider = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.method !== "GET" && url.pathname !== "/oauth-token") state.providerEffects += 1;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (state.quoUnavailable && url.pathname.startsWith("/quo/")) return json(503, { error: "synthetic unavailable" });
    if (url.pathname === "/oauth-token") return json(200, { access_token: "fixture-access-token", expires_in: 3600 });
    if (url.pathname === "/jn/contacts") return json(200, { contacts, count: contacts.length });
    if (url.pathname === "/gmail/v1/users/me/profile") return json(200, { emailAddress: state.wrongMailbox ? "other@example.test" : "owner@example.test" });
    if (url.pathname === "/gmail/v1/users/me/messages") return json(200, { messages: messages.map(row => ({ id: row.id, threadId: row.threadId })) });
    const message = messages.find(row => url.pathname === `/gmail/v1/users/me/messages/${row.id}`);
    if (message) return json(200, message);
    if (url.pathname === "/quo/phone-numbers") return json(200, { data: [{ id: "PNown", number: LINE }, { id: "PNother", number: "+12025550103" }] });
    if (url.pathname === "/quo/conversations") {
      assert.deepEqual(url.searchParams.getAll("phoneNumbers"), ["PNown"]);
      return json(200, { data: [{ id: "CN1", phoneNumberId: "PNown", participants: [OTHER], updatedAt: new Date(stamp).toISOString() }] });
    }
    if (url.pathname === "/quo/calls") return json(200, { data: [{ id: "AC1", phoneNumberId: "PNown", participants: [OTHER], direction: "incoming", status: "missed", duration: 0, createdAt: new Date(stamp).toISOString() }] });
    if (url.pathname === "/quo/messages") return json(200, { data: [] });
    if (url.pathname === "/quo/call-voicemails/AC1") return json(200, { data: { id: "VM1", status: "completed", transcript: "Calling about claim AB-1234567. Please return my call." } });
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
    QUO_API_KEY: "fixture-key", QUO_API_BASE_URL: `${base}/quo`, QUO_DEFAULT_FROM_NUMBER: LINE,
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture", GOOGLE_REFRESH_TOKEN: "fixture", GOOGLE_TOKEN_URL: `${base}/oauth-token`,
    GMAIL_API_BASE_URL: base, CHANCE_GOOGLE_EMAIL: "owner@example.test", ALLOW_GOOGLE_USER_AUTH: "false",
    MEMORY_ROOT: root, BRIDGE_DATA_DIR: root, BRIDGE_ALLOW_WRITES: "false", REQUIRE_CHANCE_RUN_POLICY: "true",
    CHANCE_OPERATOR_RUN_MANIFEST_JSON: JSON.stringify(manifest), ALLOW_OPERATOR_COMMUNICATION_SWEEP: enabled ? "true" : "false"
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs += String(chunk); }); child.stderr.on("data", chunk => { logs += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  return { state, request: async (body, token = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${port}/ops/recent-communications`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } };
}

test("HTTP sweep discovers voicemail and general email, matches one file, withholds #2628, and causes no effects", async t => {
  const f = await fixture(t);
  const response = await f.request({ days: 7 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.effectsAuthorized, false);
  assert.equal(response.body.queue.some(row => row.type === "voicemail" && row.fileMatch.file?.number === "990001"), true, JSON.stringify(response.body));
  assert.equal(response.body.queue.some(row => row.channel === "gmail"), true);
  assert.equal(response.body.withheldOtherFileItems, 1);
  assert.doesNotMatch(JSON.stringify(response.body), /EXCLUDED PRIVATE BODY|ZZ-9999999/);
  assert.equal(f.state.providerEffects, 0);
});

test("HTTP input/identity denial precedes provider reads and cannot request another mailbox or broad legacy scope", async t => {
  const f = await fixture(t);
  for (const input of [{ execute: true }, { mailbox: "other@example.test" }, { lineNumber: OTHER }, { query: "all" }, { days: 31 }]) {
    const response = await f.request(input);
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  for (const token of [HP_TOKEN, "fixture-shared-token"]) assert.equal((await f.request({}, token)).status, 403);
  assert.equal(f.state.requests.length, 0);
});

test("HTTP source-only query does not read the other communication provider", async t => {
  const f = await fixture(t);
  const response = await f.request({ source: "quo", days: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.coverage.gmail.status, "not_requested");
  assert.equal(f.state.requests.some(path => path.includes("/gmail/")), false);
});

test("HTTP route stays unavailable when the reviewed read gate is off", async t => {
  const f = await fixture(t, false);
  assert.equal((await f.request({})).status, 403);
  assert.equal(f.state.requests.length, 0);
});

test("one provider failure preserves the other source and never claims a complete sweep", async t => {
  const f = await fixture(t);
  f.state.quoUnavailable = true;
  const response = await f.request({});
  assert.equal(response.status, 200);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.coverage.quo.status, "unavailable");
  assert.equal(response.body.queue.some(row => row.channel === "gmail"), true);
  assert.equal(f.state.providerEffects, 0);
});

test("wrong mailbox is reported unavailable without reading that mailbox's messages", async t => {
  const f = await fixture(t);
  f.state.wrongMailbox = true;
  const response = await f.request({ source: "gmail" });
  assert.equal(response.status, 200);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.coverage.gmail.status, "unavailable");
  assert.equal(f.state.requests.some(request => request.includes("/messages")), false);
  assert.equal(f.state.requests.some(request => request.includes("/quo/")), false);
});
