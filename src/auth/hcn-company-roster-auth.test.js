import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { routeAllowed } from "./google-user.js";
import { createCompanyRosterAuthenticator, COMPANY_ROSTER_ROUTES } from "./hcn-company-roster-auth.js";

const token = "c".repeat(64);
const env = {
  HCN_COMPANY_ROSTER_ENABLED: "true",
  HCN_COMPANY_ROSTER_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
  HCN_COMPANY_ROSTER_TENANT_ID: "tenant_0123456789abcdef",
  HCN_TENANT_ID: "tenant_0123456789abcdef",
  HCN_COMPANY_ROSTER_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString()
};

test("roster credential is explicitly activated, tenant-bound, isolated and expiring", () => {
  assert.equal(createCompanyRosterAuthenticator({})(token), null);
  assert.equal(createCompanyRosterAuthenticator({ ...env, HCN_COMPANY_ROSTER_ENABLED: "false" })(token), null);
  for (const change of [
    { HCN_COMPANY_ROSTER_TOKEN_SHA256: "not-a-digest" },
    { HCN_COMPANY_ROSTER_TENANT_ID: "tenant_fedcba9876543210" },
    { HCN_COMPANY_ROSTER_EXPIRES_AT: "never" },
    { HCN_TENANT_ID: "" }
  ]) assert.throws(() => createCompanyRosterAuthenticator({ ...env, ...change }), /grant/);
  for (const key of ["CODEX_OPERATOR_TOKEN", "CODEX_MAC_OPERATOR_TOKEN", "JOBNIMBUS_BRIDGE_TOKEN", "JOBNIMBUS_API_KEY", "HCN_JOBROLO_IMPORT_SHARED_SECRET", "QUO_API_KEY", "HCN_REFERENCE_KEY"]) {
    assert.throws(() => createCompanyRosterAuthenticator({ ...env, [key]: token }), /isolated/);
  }
  assert.throws(() => createCompanyRosterAuthenticator({ ...env, HCN_MANAGEMENT_REPORT_TOKEN_SHA256: env.HCN_COMPANY_ROSTER_TOKEN_SHA256 }), /isolated/);
  assert.throws(() => createCompanyRosterAuthenticator({ ...env, HCN_JOBROLO_ADDITIONAL_PROFILES_JSON: JSON.stringify({ profiles: [{ sharedSecret: token }] }) }), /isolated/);
  let now = Date.now();
  const auth = createCompanyRosterAuthenticator(env, { now: () => now });
  for (const wrong of [null, "", "d".repeat(64), token + " ", token.toUpperCase()]) assert.equal(auth(wrong), null);
  assert.equal(auth(token).tenantId, env.HCN_TENANT_ID);
  assert.equal(JSON.stringify(auth(token)).includes(token), false);
  now = Date.parse(env.HCN_COMPANY_ROSTER_EXPIRES_AT);
  assert.equal(auth(token), null);
});

test("only the new identity admits the two roster routes; no legacy wildcard or write scope", () => {
  const identity = createCompanyRosterAuthenticator(env)(token);
  for (const route of COMPANY_ROSTER_ROUTES) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(identity, method, pathname), true);
    for (const other of [
      { type: "bridge_token", role: "chance" },
      { type: "google", role: "chance" },
      { type: "hcn_browser_session", role: "manager" },
      { type: "hcn_browser_session", role: "chance" },
      { type: "hcn_management_report_token", role: "management_report_reader" },
      { type: "codex_operator_token", role: "codex_operator", subject: "codex-mac-operator" },
      { type: "codex_operator_token", role: "codex_operator", subject: "codex-hp-operator" },
      { ...identity, role: "chance" },
      { ...identity, scopes: [...identity.scopes, "approved_action:execute"] },
      { ...identity, grantExpiresAt: new Date(0).toISOString() }
    ]) assert.equal(routeAllowed(other, method, pathname), false);
  }
  for (const route of [
    "GET /api/v1/session", "GET /auth/whoami", "POST /jobnimbus/search",
    "POST /jobnimbus/review-file", "POST /jobnimbus/create-note", "POST /ops/action-batch",
    "POST /gmail/search", "POST /gmail/send", "POST /quo/history", "POST /quo/send",
    "POST /claim-filing/call", "POST /hcn/api/v1/management-sweep",
    "POST /hcn/api/v1/file-review", "POST /hcn/api/v1/assistant/turns",
    "POST /hcn/api/v1/action-plans/execute", "GET /hcn/api/v1/company-roster",
    "POST /hcn/api/v1/company-roster-session"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(identity, method, pathname), false, route);
  }
});
