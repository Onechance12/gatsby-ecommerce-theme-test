import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCompanyRosterClient } from "./company-roster-client.js";
import { HCN_SESSION_COOKIE_NAME } from "../auth/hcn-console-http.js";

const TOKEN = "c".repeat(64);
const TENANT = "tenant_0123456789abcdef";
const COMMIT = "b".repeat(40);
const OWNER = "roster-fixture-owner";
const EMAIL = "roster@example.test";
const MAC_TOKEN = "fixture-mac-operator-token-1234567890";
const HP_TOKEN = "fixture-hp-operator-token-1234567890";
const LEGACY_TOKEN = "fixture-legacy-bridge-token-1234567890";

test("real HTTP company inventory is isolated, all-owner, paginated and provider-read-only", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-roster-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { mode: "normal", requests: [], writes: 0 };
  const users = [
    { jnid: OWNER, email: EMAIL, display_name: "Chance Fixture", is_active: true },
    ...Array.from({ length: 3 }, (_, i) => ({ jnid: `other-owner-${i}`, email: `other-${i}@example.test`, display_name: `Other Owner ${i}`, is_active: true }))
  ];
  const contacts = Array.from({ length: 300 }, (_, i) => ({
    jnid: `fixture-contact-${i}`, number: i + 1000, customer: "fixture-account",
    display_name: i < 5 ? "Five Property Fixture" : `Fixture Client ${i}`,
    address_line1: `${i} Fictional Road`, record_type_name: "Insurance", status_name: "Fixture Workflow",
    owners: i > 297 ? [] : [{ id: users[i % users.length].jnid }],
    is_active: i < 290, is_archived: i === 299,
    description: "PRIVATE NOTE NO ROSTER", email: "private@example.test", financial_total: 999999
  }));
  const jobs = [{ ...contacts[0], jnid: "fixture-job-0", related: [{ id: contacts[0].jnid }] }];
  const provider = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    state.requests.push({ method: req.method, path: url.pathname, search: url.search });
    if (req.method !== "GET") state.writes += 1;
    if (state.mode === "failure") return json(res, 500, { error: "PRIVATE_PROVIDER_SECRET" });
    if (url.pathname === "/account/users") return json(res, 200, { users, total: users.length });
    if (["/contacts", "/jobs"].includes(url.pathname)) {
      const all = url.pathname === "/contacts" ? contacts : jobs;
      const offset = Number(url.searchParams.get("from"));
      const size = Math.min(47, Number(url.searchParams.get("size")));
      const data = all.slice(state.mode === "repeated" && offset > 0 ? 0 : offset, state.mode === "repeated" && offset > 0 ? size : offset + size);
      return json(res, 200, { results: data, total: all.length });
    }
    return json(res, 404, { error: "unexpected route" });
  });
  await listen(provider);
  t.after(() => close(provider));
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const origin = await startBridge(t, root, provider.address().port, expiry);
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const sessionResponse = await fetch(`${origin}/hcn/api/v1/company-roster-session`, { headers });
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal((await sessionResponse.json()).identity.tenantId, TENANT);
  assert.equal(state.requests.length, 0, "status must not enumerate the provider");

  for (const token of [MAC_TOKEN, HP_TOKEN, LEGACY_TOKEN, "a".repeat(64)]) {
    for (const [method, route] of [["GET", "company-roster-session"], ["POST", "company-roster"]]) {
      const denied = await fetch(`${origin}/hcn/api/v1/${route}`, { method, headers: { ...headers, authorization: `Bearer ${token}` }, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(denied.status, 403, `${token.slice(0, 12)} ${route}`);
    }
  }
  for (const route of ["/ops/action-batch", "/jobnimbus/create-note", "/gmail/send", "/quo/send", "/claim-filing/call", "/hcn/api/v1/management-sweep", "/hcn/api/v1/file-review"]) {
    const denied = await fetch(`${origin}${route}`, { method: "POST", headers, body: "{}" });
    assert.equal(denied.status, 403, route);
  }
  for (const invalid of [null, [], { ownerId: OWNER }, { filter: "*" }, { tenantId: TENANT }, { includeNotes: true }]) {
    const rejected = await fetch(`${origin}/hcn/api/v1/company-roster`, { method: "POST", headers, body: JSON.stringify(invalid) });
    assert.equal(rejected.status, 400);
  }
  for (const changed of [
    { suffix: "?actor=somebody" },
    { headers: { ...headers, origin: "https://foreign.invalid" } },
    { headers: { ...headers, "content-type": "text/plain" } }
  ]) {
    const rejected = await fetch(`${origin}/hcn/api/v1/company-roster${changed.suffix || ""}`, { method: "POST", headers: changed.headers || headers, body: "{}" });
    assert.equal(rejected.status, 400);
  }
  const ambiguous = await fetch(`${origin}/hcn/api/v1/company-roster-session`, { headers: { ...headers, cookie: `${HCN_SESSION_COOKIE_NAME}=fake-session` } });
  assert.equal(ambiguous.status, 400);
  const tooLarge = await fetch(`${origin}/hcn/api/v1/company-roster`, { method: "POST", headers, body: JSON.stringify({ extra: "x".repeat(5000) }) });
  assert.equal(tooLarge.status, 413);
  assert.equal(state.requests.length, 0, "denied or malformed requests must not enumerate");

  const client = createCompanyRosterClient({
    profile: { schema: "hcn.company-roster-profile.v1", baseUrl: origin, expectedCommit: COMMIT, tenantId: TENANT, grantExpiresAt: expiry },
    credential: TOKEN, allowInsecureTestOrigin: true
  });
  const inventory = await client.readRoster();
  assert.equal(inventory.totals.contacts, 300);
  assert.equal(inventory.totals.jobs, 1);
  assert.equal(inventory.owners.length, 4, "not restricted to the three management-report adjusters");
  assert.equal(inventory.totals.unassigned, 2);
  assert.equal(inventory.coverage.contacts.pages, 8);
  assert.equal(inventory.rows.filter(r => r.clientName === "Five Property Fixture" && r.sourceKind === "contact").length, 5);
  for (const secret of ["PRIVATE NOTE", "private@example.test", "999999", "fixture-roster-provider-key", TOKEN]) {
    assert.equal(JSON.stringify(inventory).includes(secret), false);
  }
  assert.equal(state.writes, 0);
  assert.equal(state.requests.every(r => r.method === "GET" && ["/account/users", "/contacts", "/jobs"].includes(r.path)), true);
  assert.equal(state.requests.some(r => /filter=|actor=/.test(r.search)), false);

  state.mode = "repeated";
  const repeated = await fetch(`${origin}/hcn/api/v1/company-roster`, { method: "POST", headers, body: "{}" });
  assert.equal(repeated.status, 503);
  assert.equal(JSON.stringify(await repeated.json()).includes("rows"), false);
  state.mode = "failure";
  const failed = await fetch(`${origin}/hcn/api/v1/company-roster`, { method: "POST", headers, body: "{}" });
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(await failed.json()).includes("PRIVATE_PROVIDER_SECRET"), false);
  assert.equal(state.writes, 0);
  assert.equal((await readdir(root, { recursive: true })).some(f => /roster|inventory/.test(f)), false, "inventory must not persist on the server");

  const disabledOrigin = await startBridge(t, path.join(root, "disabled"), provider.address().port, expiry, { HCN_COMPANY_ROSTER_ENABLED: "false" });
  const before = state.requests.length;
  const disabled = await fetch(`${disabledOrigin}/hcn/api/v1/company-roster-session`, { headers });
  assert.equal(disabled.status, 401);
  const expiredOrigin = await startBridge(t, path.join(root, "expired"), provider.address().port, new Date(0).toISOString());
  const expired = await fetch(`${expiredOrigin}/hcn/api/v1/company-roster-session`, { headers });
  assert.equal(expired.status, 401);
  assert.equal(state.requests.length, before);
});

async function startBridge(t, root, providerPort, expiry, overrides = {}) {
  const reservation = createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    // Intentionally do not inherit provider secrets, effects or ambient auth.
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test", PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      HCN_SERVICE_NAME: "hcn-operations-platform", RENDER_GIT_COMMIT: COMMIT,
      HCN_OPERATIONS_ROOT: root, HCN_TENANT_ID: TENANT, HCN_REFERENCE_KEY: Buffer.alloc(32, 42).toString("base64url"),
      JOBNIMBUS_API_KEY: "fixture-roster-provider-key", JOBNIMBUS_API_BASE_URL: `http://127.0.0.1:${providerPort}`,
      CHANCE_GOOGLE_EMAIL: EMAIL, CHANCE_JOBNIMBUS_OWNER_ID: OWNER,
      CODEX_MAC_OPERATOR_TOKEN: MAC_TOKEN, CODEX_OPERATOR_TOKEN: HP_TOKEN, JOBNIMBUS_BRIDGE_TOKEN: LEGACY_TOKEN,
      HCN_MANAGEMENT_REPORT_TOKEN_SHA256: createHash("sha256").update("a".repeat(64)).digest("hex"),
      HCN_COMPANY_ROSTER_ENABLED: "true", HCN_COMPANY_ROSTER_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
      HCN_COMPANY_ROSTER_TENANT_ID: TENANT, HCN_COMPANY_ROSTER_EXPIRES_AT: expiry,
      BRIDGE_ALLOW_WRITES: "false", HCN_ACTION_EXECUTION_ENABLED: "false", ...overrides
    }
  });
  let output = "";
  child.stdout.on("data", c => { output += c; });
  child.stderr.on("data", c => { output += c; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`Fixture bridge exited: ${output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return `http://127.0.0.1:${port}`; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture bridge did not start: ${output}`);
}
async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
