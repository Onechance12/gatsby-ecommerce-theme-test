import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_OPERATOR_ALLOWED_ROUTES,
  HCN_BROWSER_ALLOWED_ROUTES,
  HCN_BROWSER_CHANCE_ONLY_ROUTES,
  authenticateGoogleAccessToken,
  hcnConsoleChanceUserConfigured,
  hcnConsoleSessionMatchesApprovedUser,
  parseWaveUsers,
  routeAllowed
} from "./google-user.js";

const clientId = "fixture.apps.googleusercontent.com";
const users = parseWaveUsers("", [{
  email: "cpearson@wavepa.com",
  name: "Chance Pearson",
  role: "chance",
  jobNimbusOwnerId: "chance-owner"
}, {
  email: "andrea@wavepa.com",
  name: "Andrea Ramirez",
  role: "client_coordinator"
}]);

test("valid Google token maps an explicitly approved employee", async () => {
  const identity = await authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users,
    fetchImpl: fixtureFetch({ email: "andrea@wavepa.com", roleDomain: "wavepa.com" })
  });
  assert.equal(identity.role, "client_coordinator");
  assert.equal(identity.email, "andrea@wavepa.com");
  assert.equal(identity.jobNimbusScope, "company");
  assert.equal(identity.googleAccessToken, "access-token");
});

test("approved users preserve a strictly validated immutable Google subject", () => {
  const pinned = parseWaveUsers(JSON.stringify([{
    email: "chance@wavepa.com",
    role: "chance",
    subject: "google-subject-1"
  }]), [{
    email: "chance@wavepa.com",
    role: "chance",
    googleSubject: "default-google-subject"
  }]);
  assert.equal(
    pinned.get("chance@wavepa.com").googleSubject,
    "google-subject-1"
  );
  assert.equal(
    hcnConsoleChanceUserConfigured(pinned, "chance@wavepa.com"),
    true
  );

  const inherited = parseWaveUsers(JSON.stringify([{
    email: "chance@wavepa.com",
    role: "chance",
    name: "Chance"
  }]), [{
    email: "chance@wavepa.com",
    role: "chance",
    googleSubject: "default-google-subject"
  }]);
  assert.equal(
    inherited.get("chance@wavepa.com").googleSubject,
    "default-google-subject"
  );
});

test("invalid or conflicting configured Google subjects fail closed", () => {
  for (const invalid of [
    " subject-with-space",
    "subject/with/slash",
    "x".repeat(256)
  ]) {
    assert.throws(() => parseWaveUsers(JSON.stringify([{
      email: "chance@wavepa.com",
      role: "chance",
      googleSubject: invalid
    }])), /Google subject is invalid/);
  }
  assert.throws(() => parseWaveUsers(JSON.stringify([{
    email: "chance@wavepa.com",
    role: "chance",
    googleSubject: "first-subject",
    subject: "different-subject"
  }])), /aliases do not match/);
  assert.equal(
    hcnConsoleChanceUserConfigured(
      parseWaveUsers("", [{
        email: "chance@wavepa.com",
        role: "chance"
      }]),
      "chance@wavepa.com"
    ),
    false
  );
});

test("an existing HCN session is invalid after its configured subject pin changes", () => {
  const session = {
    role: "chance",
    googleSubject: "original-google-subject"
  };
  assert.equal(hcnConsoleSessionMatchesApprovedUser(session, {
    role: "chance",
    enabled: true,
    googleSubject: "original-google-subject"
  }), true);
  assert.equal(hcnConsoleSessionMatchesApprovedUser(session, {
    role: "chance",
    enabled: true,
    googleSubject: "rotated-google-subject"
  }), false);
  assert.equal(hcnConsoleSessionMatchesApprovedUser(session, {
    role: "chance",
    enabled: false,
    googleSubject: "original-google-subject"
  }), false);
});

test("an explicit Google subject pin is enforced without changing unpinned GPT users", async () => {
  const pinned = parseWaveUsers("", [{
    email: "andrea@wavepa.com",
    role: "client_coordinator",
    googleSubject: "different-google-subject"
  }]);
  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: pinned,
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  }), /not approved/i);
});

test("token issued to another OAuth client is rejected", async () => {
  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users,
    fetchImpl: fixtureFetch({ audience: "other-client", email: "andrea@wavepa.com", roleDomain: "wavepa.com" })
  }), /different application/i);
});

test("unapproved employee and non-Workspace account are rejected", async () => {
  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users,
    fetchImpl: fixtureFetch({ email: "unknown@wavepa.com", roleDomain: "wavepa.com" })
  }), /not approved/i);
  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users,
    fetchImpl: fixtureFetch({ email: "andrea@gmail.com", roleDomain: "" })
  }), /outside the approved Workspace domain/i);
});

test("verified Workspace employee can be resolved for first-use onboarding", async () => {
  const autoUsers = parseWaveUsers("");
  const identity = await authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: autoUsers,
    resolveUser: async ({ email, name }) => {
      const user = { email, name, role: "onboarding", enabled: true, jobNimbusOwnerId: "owner-1", jobNimbusScope: "company", quoLineId: "" };
      autoUsers.set(email, user);
      return user;
    },
    fetchImpl: fixtureFetch({ email: "newemployee@wavepa.com", roleDomain: "wavepa.com" })
  });
  assert.equal(identity.role, "onboarding");
  assert.equal(identity.jobNimbusOwnerId, "owner-1");
  assert.equal(routeAllowed(identity, "POST", "/auth/quo-line"), true);
  assert.equal(routeAllowed(identity, "POST", "/jobnimbus/search"), false);
});

test("coordinator routes are read-focused while Google roles cannot use HCN browser data routes", () => {
  const coordinator = { type: "google_oauth", role: "client_coordinator" };
  const chance = { type: "google_oauth", role: "chance" };
  const employee = { type: "google_oauth", role: "employee" };
  assert.equal(routeAllowed(coordinator, "POST", "/gmail/search"), true);
  assert.equal(routeAllowed(coordinator, "POST", "/auth/quo-line"), true);
  assert.equal(routeAllowed(coordinator, "POST", "/claim-filing/call"), false);
  assert.equal(routeAllowed(coordinator, "POST", "/quo/send"), false);
  assert.equal(routeAllowed(chance, "POST", "/claim-filing/call"), true);
  assert.equal(routeAllowed(employee, "POST", "/claim-filing/call"), true);
  for (const role of [
    "chance",
    "administrator",
    "employee",
    "onboarding",
    "client_coordinator",
    "manager"
  ]) {
    assert.equal(
      routeAllowed({ type: "google_oauth", role }, "POST", "/hcn/api/v1/work-center"),
      false,
      role
    );
    assert.equal(
      routeAllowed({ type: "google_oauth", role }, "POST", "/hcn/api/v1/file-review"),
      false,
      role
    );
  }
});

test("dedicated Codex operator is a fail-closed non-Google role", () => {
  const operator = { type: "codex_operator_token", role: "codex_operator" };
  const spoofedGoogleOperator = { type: "google_oauth", role: "codex_operator" };

  for (const route of [
    "GET /auth/whoami",
    "GET /api/v1/session",
    "POST /ops/start-session",
    "POST /ops/review-chance-files",
    "POST /ops/action-batch",
    "POST /scheduling/availability",
    "POST /jobnimbus/search",
    "POST /jobnimbus/review-file",
    "POST /jobnimbus/document-text",
    "POST /jobnimbus/document-review",
    "POST /jobnimbus/document-file",
    "POST /gmail/search",
    "POST /gmail/thread",
    "POST /gmail/attachment-review",
    "POST /quo/numbers",
    "POST /quo/history",
    "POST /quo/transcript"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(CODEX_OPERATOR_ALLOWED_ROUTES.has(route), true);
    assert.equal(routeAllowed(operator, method, pathname), true, route);
  }
  assert.equal(CODEX_OPERATOR_ALLOWED_ROUTES.size, 17);

  for (const route of [
    "POST /auth/quo-line",
    "POST /brain/context",
    "POST /memory/persistence-check",
    "POST /jobnimbus/upload-file",
    "POST /jobnimbus/update-contact",
    "POST /jobnimbus/update-status",
    "POST /jobnimbus/process-update",
    "POST /jobnimbus/create-note",
    "POST /jobnimbus/create-task",
    "POST /jobnimbus/update-task",
    "POST /jobnimbus/create-calendar-event",
    "POST /jobnimbus/update-calendar-event",
    "POST /claim-filing/call",
    "POST /claim-filing/prepare",
    "POST /claim-filing/result",
    "POST /claim-filing/writeback",
    "POST /retell/client-coordinator-call",
    "POST /retell/carrier-follow-up-call",
    "POST /retell/carrier-follow-up-call-result",
    "POST /retell/homeowner-call",
    "POST /voice/outbound-call",
    "POST /gmail/draft",
    "POST /gmail/send",
    "POST /quo/send",
    "POST /artifacts/list",
    "POST /handoff/pending"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(CODEX_OPERATOR_ALLOWED_ROUTES.has(route), false);
    assert.equal(routeAllowed(operator, method, pathname), false, route);
  }

  assert.equal(routeAllowed(spoofedGoogleOperator, "POST", "/ops/action-batch"), false);
  assert.equal(routeAllowed({ type: "codex_operator_token", role: "chance" }, "POST", "/ops/action-batch"), false);
});

test("shared bridge token preserves legacy routes but cannot read scoped session metadata", () => {
  const shared = { type: "bridge_token", role: "chance" };
  assert.equal(
    routeAllowed(shared, "GET", "/api/v1/session"),
    false,
    "the legacy wildcard token must not receive a misleading least-privilege session descriptor"
  );
  for (const route of [
    "POST /jobnimbus/upload-file",
    "POST /jobnimbus/update-contact",
    "POST /claim-filing/call",
    "POST /gmail/send",
    "POST /quo/send",
    "POST /artifacts/list"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(shared, method, pathname), true, route);
  }
});

test("HCN browser sessions receive only the reviewed console surface", () => {
  const browser = { type: "hcn_browser_session", role: "chance" };
  for (const route of [
    "GET /api/v1/session",
    "GET /hcn/auth/session",
    "POST /hcn/auth/logout",
    "POST /hcn/api/v1/work-center",
    "POST /hcn/api/v1/file-review"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(browser, method, pathname), true, route);
  }
  for (const route of [
    "GET /auth/whoami",
    "POST /ops/review-chance-files",
    "POST /ops/action-batch",
    "POST /jobnimbus/search",
    "POST /jobnimbus/update-contact",
    "POST /gmail/send",
    "POST /quo/send",
    "POST /claim-filing/call"
  ]) {
    const [method, pathname] = route.split(" ");
    assert.equal(routeAllowed(browser, method, pathname), false, route);
  }
  assert.equal(
    routeAllowed({ type: "hcn_browser_session", role: "unsupported" }, "GET", "/api/v1/session"),
    false
  );

  assert.deepEqual([...HCN_BROWSER_CHANCE_ONLY_ROUTES].sort(), [
    "POST /hcn/api/v1/file-review",
    "POST /hcn/api/v1/work-center"
  ]);
  assert.equal(HCN_BROWSER_ALLOWED_ROUTES.size, 5);

  for (const role of [
    "administrator",
    "employee",
    "onboarding",
    "client_coordinator",
    "manager"
  ]) {
    const otherBrowser = { type: "hcn_browser_session", role };
    assert.equal(routeAllowed(otherBrowser, "GET", "/api/v1/session"), true, role);
    assert.equal(routeAllowed(otherBrowser, "GET", "/hcn/auth/session"), true, role);
    assert.equal(routeAllowed(otherBrowser, "POST", "/hcn/auth/logout"), true, role);
    assert.equal(routeAllowed(otherBrowser, "POST", "/hcn/api/v1/work-center"), false, role);
    assert.equal(routeAllowed(otherBrowser, "POST", "/hcn/api/v1/file-review"), false, role);
  }

  for (const otherIdentity of [
    { type: "bridge_token", role: "chance" },
    { type: "codex_operator_token", role: "codex_operator" }
  ]) {
    assert.equal(routeAllowed(otherIdentity, "POST", "/hcn/api/v1/work-center"), false);
    assert.equal(routeAllowed(otherIdentity, "POST", "/hcn/api/v1/file-review"), false);
  }
});

function fixtureFetch({ audience = clientId, email, roleDomain }) {
  return async (url) => {
    const href = String(url);
    if (href.includes("tokeninfo")) {
      return jsonResponse({
        audience,
        expires_in: 3600,
        user_id: "google-subject-1",
        email,
        verified_email: true,
        scope: "openid email https://www.googleapis.com/auth/gmail.readonly"
      });
    }
    return jsonResponse({
      sub: "google-subject-1",
      email,
      email_verified: true,
      hd: roleDomain,
      name: email === "andrea@wavepa.com" ? "Andrea Ramirez" : "Unknown"
    });
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
