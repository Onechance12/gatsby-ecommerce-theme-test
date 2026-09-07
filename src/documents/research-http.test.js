import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RESEARCH_TOKEN = "fixture-research-token-separate-1234567890";
const RESEARCH_PROVIDER_KEY = "fixture-research-provider-key-1234567890";
const MAC_TOKEN = "fixture-mac-operator-token-separate-1234567890";
const LEGACY_TOKEN = "fixture-legacy-bridge-token-separate-1234567890";
const VOICE_TOKEN = "fixture-voice-token-separate-1234567890";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const PDF_HASH = createHash("sha256").update(PDF_BYTES).digest("hex");

function grantFixture() {
  return {
    enabled: true, grantId: "grant-fixture", companyId: "tenant-fixture",
    issuedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    excludedFileNumbers: ["2628"],
    limits: { pageSize: 10, maxPages: 3, maxDocuments: 30, maxOriginals: 2, maxBytesPerFile: 1024, maxTotalBytes: 2048 }
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function fixture(t, options = {}) {
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "document-research-http-"));
  const requests = [];
  const document = {
    customer: "tenant-fixture", jnid: "document-fixture", filename: "Carrier estimate.pdf",
    content_type: "application/pdf", size: PDF_BYTES.length, date_created: 1788600000,
    date_updated: 1788600001, is_active: true, is_archived: false, is_private: false,
    related: [{ id: "contact-fixture", type: "contact" }]
  };
  const contact = {
    customer: "tenant-fixture", jnid: "contact-fixture", number: 3001,
    is_active: true, is_archived: false, is_private: false, cf_string_1: "Fixture Carrier"
  };
  const provider = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization });
    if (req.method !== "GET" || req.headers.authorization !== `Bearer ${RESEARCH_PROVIDER_KEY}`) {
      res.writeHead(403).end();
      return;
    }
    let result;
    if (url.pathname === "/files") {
      const from = Number(url.searchParams.get("from"));
      const size = Number(url.searchParams.get("size"));
      result = { files: [document].slice(from, from + size), total: 1 };
    } else if (url.pathname === "/files/document-fixture") result = document;
    else if (url.pathname === "/contacts/contact-fixture") result = contact;
    else if (url.pathname === "/download/document-fixture") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": PDF_BYTES.length });
      res.end(PDF_BYTES);
      return;
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  const providerPort = await listen(provider);
  const port = await freePort();
  // Do not inherit credentials, NODE_OPTIONS, provider URLs, or storage paths.
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_ENV: "test", PORT: String(port), MEMORY_ROOT: memoryRoot,
    BRIDGE_ALLOW_WRITES: "false", ALLOW_GOOGLE_USER_AUTH: "false",
    ALLOW_RETELL_CALLS: "false", ALLOW_RETELL_CLAIM_CALLS: "false",
    ALLOW_CLIENT_COORDINATOR_CALLS: "false", ALLOW_CARRIER_FOLLOWUP_CALLS: "false",
    ALLOW_VOICE_CALLS: "false", ALLOW_GMAIL_SEND: "false", ALLOW_QUO_SEND: "false",
    ALLOW_LEGACY_CLIENT_MEMORY_WRITES: "false", REQUIRE_CHANCE_RUN_POLICY: "false",
    HCN_CONSOLE_ENABLED: "true", CODEX_MAC_OPERATOR_TOKEN: MAC_TOKEN,
    JOBNIMBUS_BRIDGE_TOKEN: LEGACY_TOKEN, VOICE_STREAM_TOKEN: VOICE_TOKEN,
    DOCUMENT_RESEARCH_TOKEN: RESEARCH_TOKEN,
    DOCUMENT_RESEARCH_JOBNIMBUS_API_KEY: RESEARCH_PROVIDER_KEY,
    DOCUMENT_RESEARCH_GRANT_JSON: JSON.stringify(grantFixture()),
    DOCUMENT_RESEARCH_ALLOW_LOOPBACK_TESTS: "true",
    DOCUMENT_RESEARCH_API_BASE_URL: `http://127.0.0.1:${providerPort}`,
    DOCUMENT_RESEARCH_FILE_BASE_URL: `http://127.0.0.1:${providerPort}/download`,
    ...options.env
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-6000); });
  child.on("exit", () => { exited = true; });
  const exit = once(child, "exit");
  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exit;
      clearTimeout(force);
    }
    await closeServer(provider);
    await rm(memoryRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (exited) assert.fail(`Synthetic research bridge exited before listening: ${output}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) });
      await response.text();
      if (response.ok) { ready = true; break; }
    } catch { /* A new fixture server is still binding its loopback port. */ }
    await delay(50);
  }
  assert(ready, `Synthetic research bridge did not become ready: ${output}`);
  async function request(method, route, { token = RESEARCH_TOKEN, body, rawBody, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined || rawBody !== undefined ? { body: rawBody ?? JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    for (const secret of [RESEARCH_TOKEN, RESEARCH_PROVIDER_KEY, MAC_TOKEN, LEGACY_TOKEN]) {
      assert(!text.includes(secret), `${method} ${route} exposed a credential`);
    }
    return { status: response.status, data, text };
  }
  return { request, requests, port, document, contact };
}

async function assertUpgradeDenied(port, route) {
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Research WebSocket upgrade was not rejected promptly."));
    }, 3000);
    socket.on("connect", () => socket.write([
      `GET ${route} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${RESEARCH_TOKEN}`, "Connection: Upgrade", "Upgrade: websocket",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: Zml4dHVyZS1yZXNlYXJjaA==", "", ""
    ].join("\r\n")));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") { clearTimeout(timer); reject(error); }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        assert(!/^HTTP\/1\.[01] 101\b/m.test(response), "Research identity acquired a WebSocket upgrade.");
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

test("research bearer is denied before public, browser, OAuth, unknown and operational dispatch", async (t) => {
  const api = await fixture(t);
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const registered = [...source.matchAll(/\["(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^"\n]*)",/g)]
    .map((match) => [match[1], match[2]])
    .filter(([, route]) => !route.startsWith("/document-research/"));
  const forbidden = [...registered,
    ["GET", "/health"], ["GET", "/api/v1/meta"], ["GET", "/openapi.json"],
    ["GET", "/openapi-chatgpt.json"], ["GET", "/privacy"], ["GET", "/handoff"],
    ["POST", "/handoff"], ["POST", "/handoff/chunk"], ["GET", "/voice/twiml"],
    ["GET", "/oauth/authorize"], ["GET", "/oauth/google/callback"], ["POST", "/oauth/token"],
    ["GET", "/hcn"], ["GET", "/hcn/"], ["GET", "/hcn/app.js"], ["GET", "/hcn/auth/login"],
    ["GET", "/auth/whoami"], ["GET", "/api/v1/session"], ["GET", "/unregistered-fixture-route"],
    ["POST", "/jobnimbus/search"], ["POST", "/jobnimbus/update-contact"],
    ["POST", "/jobnimbus/document-file"], ["POST", "/ops/action-batch"],
    ["POST", "/hcn/api/v1/action-plans/prepare"], ["POST", "/hcn/api/v1/action-plans/execute"],
    ["POST", "/gmail/search"], ["POST", "/gmail/draft"], ["POST", "/gmail/send"],
    ["POST", "/quo/history"], ["POST", "/quo/send"], ["POST", "/scheduling/availability"],
    ["POST", "/claim-filing/prepare"], ["POST", "/claim-filing/call"], ["POST", "/retell/inbound"],
    ["GET", "/document-research/inventory"], ["POST", "/document-research/session"],
    ["OPTIONS", "/document-research/original"], ["GET", "/document-research/session?profile=operator"]
  ];
  const unique = new Map(forbidden.map(([method, route]) => [`${method} ${route}`, [method, route]]));
  for (const [method, route] of unique.values()) {
    const result = await api.request(method, route, method === "POST" ? { rawBody: "{invalid-json" } : {});
    assert.equal(result.status, 403, `${method} ${route} must be denied before route/body handling`);
  }
  for (const route of ["/voice/twilio-stream", `/voice/twilio-stream?token=${VOICE_TOKEN}`, "/unregistered-fixture-route"]) {
    await assertUpgradeDenied(api.port, route);
  }
  assert.equal(api.requests.length, 0, "Denied research routes must make zero provider requests.");
});

test("ordinary Mac, legacy bridge, absent and invalid identities cannot borrow research access", async (t) => {
  const api = await fixture(t);
  for (const token of [MAC_TOKEN, LEGACY_TOKEN, "", "fixture-unknown-token-1234567890"]) {
    for (const [method, route, body] of [
      ["GET", "/document-research/session"],
      ["POST", "/document-research/inventory", {}],
      ["POST", "/document-research/original", { runId: "unknown", documentId: "document-fixture", fileId: "contact-fixture" }]
    ]) {
      const result = await api.request(method, route, { token, body });
      assert([401, 403].includes(result.status), `${method} ${route} accepted another identity (${result.status})`);
    }
  }
  assert.equal(api.requests.length, 0);
});

test("research inventory binds original PDF bytes to a fresh provider record and separate credential", async (t) => {
  const api = await fixture(t);
  const session = await api.request("GET", "/document-research/session");
  assert.equal(session.status, 200, session.text);
  assert.equal(session.data.ready, true);
  assert.equal(session.data.readOnly, true);
  assert.equal(session.data.effects, false);
  assert.equal(session.data.companyId, "tenant-fixture");
  assert.deepEqual(session.data.identity, { type: "document_research_token", subject: "codex-document-research" });
  assert.deepEqual(session.data.allowedRoutes, [
    "GET /document-research/session", "POST /document-research/inventory", "POST /document-research/original"
  ]);
  assert.deepEqual(session.data.excludedFileNumbers, ["2628"]);
  assert.equal(session.data.companyWideIndexOrSweep, false);
  assert.match(session.data.grant.sha256, /^[a-f0-9]{64}$/);
  assert(session.data.build && typeof session.data.build === "object", "Research session lacks build attestation.");
  assert.equal(api.requests.length, 0, "Session admission must not enumerate provider data.");

  const inventory = await api.request("POST", "/document-research/inventory", { body: {} });
  assert.equal(inventory.status, 200, inventory.text);
  assert.equal(inventory.data.complete, true);
  assert.equal(inventory.data.stopReason, "complete");
  assert.equal(inventory.data.nextCursor, null);
  assert.equal(inventory.data.declaredTotal, 1);
  assert.equal(inventory.data.snapshot.consistentSnapshot, false);
  assert.equal(inventory.data.documents.length, 1);
  const selected = inventory.data.documents[0];
  assert.equal(selected.documentId, "document-fixture");
  assert.equal(selected.fileId, "contact-fixture");
  assert.equal(selected.fileNumber, "3001");
  assert.equal(selected.classification, "estimate_scope_candidate");
  assert.equal(selected.sourceRole, "unverified");
  assert(!inventory.text.includes('"customer":'), "Raw provider envelope leaked through the research projection.");

  const beforeDenied = api.requests.length;
  for (const body of [
    { runId: "unknown", documentId: selected.documentId, fileId: selected.fileId },
    { runId: inventory.data.runId, documentId: "not-in-inventory", fileId: selected.fileId },
    { runId: inventory.data.runId, documentId: selected.documentId, fileId: "another-contact" }
  ]) {
    const denied = await api.request("POST", "/document-research/original", { body });
    assert([403, 409].includes(denied.status), denied.text);
  }
  assert.equal(api.requests.length, beforeDenied, "Unbound originals caused a provider read.");

  const original = await api.request("POST", "/document-research/original", {
    body: { runId: inventory.data.runId, documentId: selected.documentId, fileId: selected.fileId }
  });
  assert.equal(original.status, 200, original.text);
  assert.equal(original.data.runId, inventory.data.runId);
  assert.equal(original.data.documentId, selected.documentId);
  assert.equal(original.data.fileId, selected.fileId);
  assert.equal(original.data.revision, selected.revision);
  assert.equal(original.data.byteLength, PDF_BYTES.length);
  assert.equal(original.data.sha256, PDF_HASH);
  assert.deepEqual(Buffer.from(original.data.contentBase64, "base64"), PDF_BYTES);
  assert(api.requests.every((request) => request.method === "GET"));
  assert(api.requests.every((request) => request.authorization === `Bearer ${RESEARCH_PROVIDER_KEY}`));
  assert.equal(api.requests.filter((request) => request.path === "/files/document-fixture").length, 2,
    "Original retrieval must verify metadata before and after download.");
  assert.equal(api.requests.filter((request) => request.path === "/download/document-fixture").length, 1);
  assert(!api.requests.some((request) => request.path === "/contacts"), "Research exported a contact index.");
});

test("missing, malformed, disabled, revoked, expired and incomplete research configuration stays closed", async (t) => {
  const expired = {
    ...grantFixture(), issuedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    expiresAt: new Date(Date.now() - 86400000).toISOString()
  };
  const cases = [
    ["missing grant", { DOCUMENT_RESEARCH_GRANT_JSON: undefined }],
    ["malformed grant", { DOCUMENT_RESEARCH_GRANT_JSON: "{invalid-json" }],
    ["disabled grant", { DOCUMENT_RESEARCH_GRANT_JSON: JSON.stringify({ enabled: false }) }],
    ["revoked grant", { DOCUMENT_RESEARCH_GRANT_JSON: JSON.stringify({ ...grantFixture(), enabled: false }) }],
    ["expired grant", { DOCUMENT_RESEARCH_GRANT_JSON: JSON.stringify(expired) }],
    ["missing provider credential", { DOCUMENT_RESEARCH_JOBNIMBUS_API_KEY: undefined }],
    ["missing research credential", { DOCUMENT_RESEARCH_TOKEN: undefined }]
  ];
  for (const [label, env] of cases) {
    await t.test(label, async (subtest) => {
      const api = await fixture(subtest, { env });
      const session = await api.request("GET", "/document-research/session");
      if (session.status === 200) assert.equal(session.data.ready, false, label);
      else assert([401, 403, 503].includes(session.status), `${label}: ${session.status}`);
      for (const [route, body] of [
        ["/document-research/inventory", {}],
        ["/document-research/original", { runId: "unknown", documentId: "document-fixture", fileId: "contact-fixture" }]
      ]) {
        const result = await api.request("POST", route, { body });
        assert([401, 403, 503].includes(result.status), `${label}: ${route} admitted (${result.status})`);
      }
      assert.equal(api.requests.length, 0, `${label} dispatched to provider`);
    });
  }
});

test("research routes reject malformed bodies, mixed cookies and caller-controlled profiles before provider reads", async (t) => {
  const api = await fixture(t);
  const malformed = await api.request("POST", "/document-research/inventory", { rawBody: "{invalid-json" });
  assert.equal(malformed.status, 400);
  const mixed = await api.request("GET", "/document-research/session", {
    headers: { cookie: `__Host-hcn_session=${"a".repeat(43)}` }
  });
  assert.equal(mixed.status, 400);
  for (const authorization of [`Basic ${RESEARCH_TOKEN}`, `Bearer ${RESEARCH_TOKEN} extra`]) {
    const denied = await api.request("GET", "/document-research/session", { headers: { authorization } });
    assert.equal(denied.status, 401);
  }
  const oversized = await api.request("POST", "/document-research/inventory", { body: { cursor: "x".repeat(5000) } });
  assert.equal(oversized.status, 413);
  for (const body of [{ profile: "operator" }, { operatorScope: "company" }, { url: "https://example.test/private" }, { cursor: "tampered-cursor" }]) {
    const result = await api.request("POST", "/document-research/inventory", { body });
    assert([400, 403, 409].includes(result.status), `Unsafe inventory input was admitted (${result.status})`);
  }
  assert.equal(api.requests.length, 0);
});
