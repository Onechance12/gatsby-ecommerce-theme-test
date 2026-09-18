import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { routeAllowed } from "./google-user.js";
import { createManagementReportAuthenticator, isManagementReportIdentity, MANAGEMENT_REPORT_ROUTES } from "./hcn-management-report-auth.js";

const token = "a".repeat(64);
const env = { HCN_MANAGEMENT_REPORT_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") };

test("report identity is disabled by default, isolated, and exact", () => {
  assert.equal(createManagementReportAuthenticator({})(token), null);
  assert.throws(() => createManagementReportAuthenticator({ HCN_MANAGEMENT_REPORT_TOKEN_SHA256: "wrong" }), /digest/);
  for (const key of ["CODEX_OPERATOR_TOKEN", "CODEX_MAC_OPERATOR_TOKEN", "JOBNIMBUS_BRIDGE_TOKEN"]) {
    assert.throws(() => createManagementReportAuthenticator({ ...env, [key]: token }), /isolated/);
  }
  const auth = createManagementReportAuthenticator(env);
  for (const bad of [null, "", token.slice(1), "b".repeat(64), token + " "]) assert.equal(auth(bad), null);
  assert.equal(isManagementReportIdentity(auth(token)), true);
  assert.equal(JSON.stringify(auth(token)).includes(token), false);
});

test("report credential admits exactly two routes and no operational effects", () => {
  const identity = createManagementReportAuthenticator(env)(token);
  for (const route of MANAGEMENT_REPORT_ROUTES) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(identity, method, pathname), true);
    for (const altered of [
      { ...identity, subject: "codex-hp-operator" },
      { ...identity, role: "chance" },
      { ...identity, scopes: [] },
      { ...identity, scopes: [...identity.scopes, "approval_batches:prepare_execute"] }
    ]) assert.equal(routeAllowed(altered, method, pathname), false);
  }
  for (const route of [
    "GET /auth/whoami", "GET /api/v1/session", "POST /jobnimbus/search",
    "POST /jobnimbus/review-file", "POST /jobnimbus/create-note",
    "POST /ops/action-batch", "POST /claim-filing/call", "POST /gmail/send",
    "POST /gmail/search", "POST /quo/history", "POST /quo/send",
    "POST /hcn/api/v1/closed-file-benchmark", "POST /hcn/api/v1/assistant/turns",
    "POST /hcn/api/v1/action-plans/execute", "GET /hcn/api/v1/management-sweep",
    "POST /hcn/api/v1/management-report-session"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(identity, method, pathname), false, route);
  }
  for (const other of [
    {type:"bridge_token",role:"chance"},
    {type:"hcn_browser_session",role:"manager"},
    {type:"codex_operator_token",role:"codex_operator",subject:"codex-mac-operator"}
  ]) assert.equal(routeAllowed(other,"GET","/hcn/api/v1/management-report-session"), false);
});
