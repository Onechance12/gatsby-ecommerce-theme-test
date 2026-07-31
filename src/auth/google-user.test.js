import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_OPERATOR_ALLOWED_ROUTES,
  HCN_BROWSER_ASSIGNED_ACTION_ROUTES,
  HCN_BROWSER_ALLOWED_ROUTES,
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
  jobNimbusOwnerId: "chance-owner",
  googleSubject: "google-subject-1"
}, {
  email: "andrea@wavepa.com",
  name: "Andrea Ramirez",
  role: "client_coordinator",
  googleSubject: "google-subject-1"
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
  assert.equal(identity.jobNimbusScope, "assigned");
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

test("an override preserves omitted trusted default employee bindings", () => {
  const configured = parseWaveUsers(JSON.stringify([{
    email: "chance@wavepa.com",
    role: "chance",
    googleSubject: "pinned-google-subject"
  }]), [{
    email: "chance@wavepa.com",
    name: "Chance Pearson",
    role: "chance",
    jobNimbusOwnerId: "chance-owner",
    jobNimbusScope: "assigned",
    quoLineId: "chance-quo-line"
  }]);
  assert.deepEqual(
    {
      name: configured.get("chance@wavepa.com").name,
      jobNimbusOwnerId:
        configured.get("chance@wavepa.com").jobNimbusOwnerId,
      jobNimbusScope:
        configured.get("chance@wavepa.com").jobNimbusScope,
      quoLineId: configured.get("chance@wavepa.com").quoLineId
    },
    {
      name: "Chance Pearson",
      jobNimbusOwnerId: "chance-owner",
      jobNimbusScope: "assigned",
      quoLineId: "chance-quo-line"
    }
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

test("an explicit Google subject pin is enforced", async () => {
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

test("a configured unpinned employee can be securely pinned on first use", async () => {
  const configured = parseWaveUsers("", [{
    email: "andrea@wavepa.com",
    name: "Andrea Ramirez",
    role: "client_coordinator",
    jobNimbusOwnerId: "andrea-owner"
  }]);
  const existingUser = configured.get("andrea@wavepa.com");
  let resolverCandidate;

  const identity = await authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: configured,
    resolveUser: async (candidate) => {
      resolverCandidate = candidate;
      const pinnedUser = {
        ...candidate.existingUser,
        googleSubject: candidate.subject
      };
      configured.set(candidate.email, pinnedUser);
      return pinnedUser;
    },
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  });

  assert.equal(resolverCandidate.email, "andrea@wavepa.com");
  assert.equal(resolverCandidate.subject, "google-subject-1");
  assert.equal(resolverCandidate.hostedDomain, "wavepa.com");
  assert.equal(resolverCandidate.existingUser, existingUser);
  assert.equal(identity.subject, "google-subject-1");
  assert.equal(identity.role, "client_coordinator");
});

test("a configured unpinned employee is denied when first-use pinning is refused", async () => {
  const configured = parseWaveUsers("", [{
    email: "andrea@wavepa.com",
    role: "client_coordinator"
  }]);

  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: configured,
    resolveUser: async () => null,
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  }), /not approved/i);

  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: configured,
    resolveUser: async ({ existingUser }) => existingUser,
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  }), /not approved/i);
});

test("a disabled configured employee is denied without invoking first-use resolution", async () => {
  const configured = parseWaveUsers("", [{
    email: "andrea@wavepa.com",
    role: "client_coordinator",
    enabled: false
  }]);
  let resolverCalled = false;

  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: configured,
    resolveUser: async () => {
      resolverCalled = true;
      return null;
    },
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  }), /not approved/i);
  assert.equal(resolverCalled, false);
});

test("a pinned subject mismatch is denied without invoking first-use resolution", async () => {
  const configured = parseWaveUsers("", [{
    email: "andrea@wavepa.com",
    role: "client_coordinator",
    googleSubject: "different-google-subject"
  }]);
  let resolverCalled = false;

  await assert.rejects(() => authenticateGoogleAccessToken({
    token: "access-token",
    clientId,
    allowedDomain: "wavepa.com",
    users: configured,
    resolveUser: async () => {
      resolverCalled = true;
      return null;
    },
    fetchImpl: fixtureFetch({
      email: "andrea@wavepa.com",
      roleDomain: "wavepa.com"
    })
  }), /not approved/i);
  assert.equal(resolverCalled, false);
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
    resolveUser: async ({ email, name, subject }) => {
      const user = { email, name, role: "onboarding", enabled: true, jobNimbusOwnerId: "owner-1", jobNimbusScope: "company", quoLineId: "", googleSubject: subject };
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
  assert.equal(routeAllowed(employee, "POST", "/claim-filing/call"), false);
  for (const role of [
    "administrator",
    "employee",
    "onboarding",
    "client_coordinator",
    "manager"
  ]) {
    assert.equal(
      routeAllowed(
        { type: "google_oauth", role },
        "POST",
        "/brain/context"
      ),
      false,
      `${role} must not cross into Chance Brain`
    );
    assert.equal(
      routeAllowed(
        { type: "google_oauth", role },
        "POST",
        "/memory/file-actions"
      ),
      false,
      `${role} must not read Chance client memory`
    );
  }
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
    "GET /hcn/connect/google/start",
    "POST /hcn/api/v1/connectors/status",
    "POST /hcn/api/v1/connectors/google/disconnect",
    "POST /hcn/api/v1/connectors/quo-line",
    "POST /hcn/api/v1/work-center",
    "POST /hcn/api/v1/management-sweep",
    "POST /hcn/api/v1/file-review",
    "POST /hcn/api/v1/assistant/turns",
    "POST /hcn/api/v1/action-plans/prepare",
    "POST /hcn/api/v1/action-plans/list",
    "POST /hcn/api/v1/action-plans/detail",
    "POST /hcn/api/v1/action-plans/execute",
    "POST /hcn/api/v1/action-plans/invalidate",
    "POST /hcn/api/v1/action-receipts/list",
    "POST /hcn/api/v1/action-receipts/detail",
    "POST /hcn/api/v1/team/invitations/list",
    "POST /hcn/api/v1/team/invitations/prepare",
    "POST /hcn/api/v1/team/invitations/create",
    "POST /hcn/api/v1/team/invitations/revoke"
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

  assert.deepEqual([...HCN_BROWSER_ASSIGNED_ACTION_ROUTES].sort(), [
    "POST /hcn/api/v1/action-plans/detail",
    "POST /hcn/api/v1/action-plans/execute",
    "POST /hcn/api/v1/action-plans/invalidate",
    "POST /hcn/api/v1/action-plans/list",
    "POST /hcn/api/v1/action-plans/prepare",
    "POST /hcn/api/v1/action-receipts/detail",
    "POST /hcn/api/v1/action-receipts/list"
  ]);
  assert.equal(HCN_BROWSER_ALLOWED_ROUTES.size, 22);

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
    assert.equal(
      routeAllowed(otherBrowser, "POST", "/hcn/api/v1/connectors/status"),
      true,
      role
    );
    assert.equal(
      routeAllowed(otherBrowser, "POST", "/hcn/api/v1/work-center"),
      role !== "onboarding",
      role
    );
    assert.equal(
      routeAllowed(otherBrowser, "POST", "/hcn/api/v1/file-review"),
      role !== "onboarding",
      role
    );
    assert.equal(
      routeAllowed(otherBrowser, "POST", "/hcn/api/v1/assistant/turns"),
      role !== "onboarding",
      role
    );
    for (const pathname of [
      "/hcn/api/v1/team/invitations/list",
      "/hcn/api/v1/team/invitations/prepare",
      "/hcn/api/v1/team/invitations/create",
      "/hcn/api/v1/team/invitations/revoke"
    ]) {
      assert.equal(
        routeAllowed(otherBrowser, "POST", pathname),
        false,
        `${role} ${pathname}`
      );
    }
    assert.equal(
      routeAllowed(otherBrowser, "POST", "/hcn/api/v1/management-sweep"),
      role === "administrator" || role === "manager",
      role
    );
    assert.equal(
      routeAllowed(
        otherBrowser,
        "POST",
        "/hcn/api/v1/action-plans/execute"
      ),
      role !== "onboarding",
      role
    );
  }

  for (const otherIdentity of [
    { type: "bridge_token", role: "chance" },
    { type: "codex_operator_token", role: "codex_operator" }
  ]) {
    assert.equal(routeAllowed(otherIdentity, "POST", "/hcn/api/v1/work-center"), false);
    assert.equal(routeAllowed(otherIdentity, "POST", "/hcn/api/v1/file-review"), false);
    assert.equal(routeAllowed(otherIdentity, "POST", "/hcn/api/v1/assistant/turns"), false);
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
