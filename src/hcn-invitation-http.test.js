import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHcnIdentityPinStore
} from "./auth/hcn-identity-pin-store.js";

test("HCN invitation HTTP flow is Chance-only, exact-email, one-shot, and revocable", async (t) => {
  let staleEmployeeActive = true;
  let jobNimbusUserReads = 0;
  const identities = {
    "chance-token": {
      sub: "google-chance",
      email: "cpearson@wavepa.com",
      name: "Chance Pearson",
      hd: "wavepa.com"
    },
    "invite-token": {
      sub: "google-invitee",
      email: "invitee@outside.example",
      name: "Invited Employee"
    },
    "wrong-token": {
      sub: "google-wrong",
      email: "wrong@another.example",
      name: "Wrong Employee"
    },
    "unknown-token": {
      sub: "google-unknown",
      email: "unknown@third.example",
      name: "Unknown Employee"
    },
    "legacy-token": {
      sub: "google-legacy",
      email: "legacy@outside.example",
      name: "Legacy Employee"
    }
  };
  const provider = createServer(async (req, res) => {
    const url = new URL(req.url, "http://provider.invalid");
    if (url.pathname === "/token" && req.method === "POST") {
      const body = await readRequest(req);
      const code = new URLSearchParams(body).get("code");
      const tokenByCode = {
        "chance-code": "chance-token",
        "invite-code": "invite-token",
        "wrong-code": "wrong-token",
        "unknown-code": "unknown-token",
        "legacy-code": "legacy-token"
      };
      const accessToken = tokenByCode[code];
      if (!accessToken) return json(res, 400, { error: "bad code" });
      return json(res, 200, {
        access_token: accessToken,
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname === "/tokeninfo") {
      const token = url.searchParams.get("access_token");
      if (!identities[token]) {
        return json(res, 401, { error: "bad token" });
      }
      return json(res, 200, {
        audience: "hcn-invite-test-client",
        expires_in: 3600,
        verified_email: true,
        scope: "openid email profile"
      });
    }
    if (url.pathname === "/userinfo") {
      const token = String(req.headers.authorization || "")
        .replace(/^Bearer\s+/, "");
      const identity = identities[token];
      if (!identity) return json(res, 401, { error: "bad token" });
      return json(res, 200, {
        ...identity,
        email_verified: true
      });
    }
    if (
      url.pathname === "/account/users"
      && req.method === "GET"
    ) {
      jobNimbusUserReads += 1;
      return json(res, 200, {
        total: 6,
        users: [
          activeUser(
            "jn-chance",
            "cpearson@wavepa.com",
            "Chance Pearson"
          ),
          {
            ...activeUser(
              "jn-stale",
              "stale@outside.example",
              "Stale Employee"
            ),
            is_active: staleEmployeeActive
          },
          activeUser(
            "jn-invitee",
            "invitee@outside.example",
            "Invited Employee"
          ),
          activeUser(
            "jn-wrong",
            "wrong@another.example",
            "Wrong Employee"
          ),
          activeUser(
            "jn-unknown",
            "unknown@third.example",
            "Unknown Employee"
          ),
          activeUser(
            "jn-legacy",
            "legacy@outside.example",
            "Legacy Employee"
          )
        ]
      });
    }
    return json(res, 404, { error: "not found" });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => provider.close());
  const providerPort = provider.address().port;

  const bridgePort = await availablePort();
  const origin = `http://127.0.0.1:${bridgePort}`;
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hcn-invite-http-")
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const referenceKey = Buffer.alloc(32, 0x41).toString("base64url");
  const legacyPinStore = createHcnIdentityPinStore({
    filePath: path.join(root, "platform", "identity-pins.json"),
    key: referenceKey,
    allowedDomain: ""
  });
  await legacyPinStore.pin({
    email: "legacy@outside.example",
    displayName: "Legacy Employee",
    googleSubject: "google-legacy",
    jobNimbusOwnerId: "jn-legacy",
    jobNimbusScope: "assigned",
    role: "employee",
    source: "employee_auto_enroll"
  });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(bridgePort),
      PUBLIC_BASE_URL: origin,
      HCN_CONSOLE_ENABLED: "true",
      HCN_CONSOLE_ORIGIN: origin,
      ALLOW_GOOGLE_USER_AUTH: "true",
      HCN_GOOGLE_CLIENT_ID: "hcn-invite-test-client",
      HCN_GOOGLE_CLIENT_SECRET: "hcn-invite-test-secret",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      GOOGLE_TOKEN_URL:
        `http://127.0.0.1:${providerPort}/token`,
      GOOGLE_TOKENINFO_URL:
        `http://127.0.0.1:${providerPort}/tokeninfo`,
      GOOGLE_USERINFO_URL:
        `http://127.0.0.1:${providerPort}/userinfo`,
      HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "",
      GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
      HCN_ALLOW_ACTIVE_JOBNIMBUS_GOOGLE_USERS: "false",
      AUTO_ENROLL_WAVE_USERS: "false",
      CHANCE_GOOGLE_EMAIL: "cpearson@wavepa.com",
      CHANCE_GOOGLE_SUBJECT: "google-chance",
      CHANCE_JOBNIMBUS_OWNER_ID: "jn-chance",
      WAVE_AUTH_USERS_JSON: JSON.stringify([{
        email: "cpearson@wavepa.com",
        name: "Chance Pearson",
        role: "chance",
        googleSubject: "google-chance",
        jobNimbusOwnerId: "jn-chance",
        jobNimbusScope: "assigned"
      }]),
      OAUTH_SESSION_SECRET:
        "hcn-invitation-http-session-secret-1234567890",
      HCN_OPERATIONS_ROOT: root,
      HCN_TENANT_ID: "tenant_13579bdf2468ace0",
      HCN_REFERENCE_KEY:
        referenceKey,
      JOBNIMBUS_API_KEY: "jobnimbus-invite-test-key",
      JOBNIMBUS_API_BASE_URL:
        `http://127.0.0.1:${providerPort}`,
      HCN_THRESHER_ENABLED: "false",
      HCN_THRESHER_AI_ENABLED: "false",
      BRIDGE_ALLOW_WRITES: "false",
      GPT_OAUTH_CLIENT_SECRET: "",
      RETELL_API_KEY: "",
      QUO_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const childOutput = [];
  child.stdout.on("data", (chunk) => {
    childOutput.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    childOutput.push(String(chunk));
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForServer(child, bridgePort, childOutput);

  const landing = await fetch(`${origin}/hcn/invite`);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  assert.doesNotMatch(landingHtml, /HCN Work Center/);
  assert.match(landingHtml, /Checking your invitation/);
  const anonymousClaim = await fetch(
    `${origin}/hcn/auth/invitation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationRef: `invite_${"0".repeat(32)}`,
        inviteToken: "A".repeat(43)
      })
    }
  );
  assert.equal(anonymousClaim.status, 403);

  const chance = await login({
    origin,
    code: "chance-code"
  });
  assert.ok(chance.sessionCookie);
  const sessionResponse = await fetch(
    `${origin}/hcn/auth/session`,
    { headers: { cookie: chance.sessionCookie } }
  );
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.profile.email, "cpearson@wavepa.com");
  assert.equal(session.capabilities.teamInvitations.manage, true);
  const chanceHeaders = {
    cookie: chance.sessionCookie,
    origin,
    "content-type": "application/json",
    "x-hcn-csrf": session.browserSession.csrfToken
  };

  const health = await (await fetch(`${origin}/health`)).json();
  assert.deepEqual(
    health.userOAuth.invitationOnlyAdmission.legacyPinMigration,
    {
      compatibilityActive: true,
      preservedExistingAccessCount: 1,
      admission: "preexisting_authenticated_identity_pins_only",
      newSelfEnrollment: false
    }
  );
  const legacySession = await login({
    origin,
    code: "legacy-code"
  });
  assert.ok(
    legacySession.sessionCookie,
    "a pre-existing authenticated identity pin must survive the migration deployment"
  );
  const legacyList = await postJson(
    `${origin}/hcn/api/v1/team/invitations/list`,
    chanceHeaders,
    {}
  );
  assert.equal(legacyList.response.status, 200);
  assert.deepEqual(legacyList.body.legacyReviewRequired, [{
    email: "legacy@outside.example",
    displayName: "Legacy Employee",
    role: "employee",
    status: "migration_required_access_preserved",
    reason: "legacy_auto_enrollment_requires_invitation"
  }]);

  const chanceSelfInvite = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    {
      action: "create",
      email: "cpearson@wavepa.com",
      role: "employee",
      expiresInHours: 72
    }
  );
  assert.equal(chanceSelfInvite.response.status, 400);

  const changedLegacyRole = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    {
      action: "create",
      email: "legacy@outside.example",
      role: "manager",
      expiresInHours: 72
    }
  );
  assert.equal(changedLegacyRole.response.status, 409);
  assert.match(
    changedLegacyRole.body.error,
    /pinned to different authority/i
  );

  const legacyPrepared = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    {
      action: "create",
      email: "legacy@outside.example",
      role: "employee",
      expiresInHours: 72
    }
  );
  assert.equal(legacyPrepared.response.status, 200);
  assert.equal(
    legacyPrepared.body.plan.existingAccessMigration,
    true
  );
  const legacyCreated = await postJson(
    `${origin}/hcn/api/v1/team/invitations/create`,
    chanceHeaders,
    {
      approvalId: legacyPrepared.body.approval.approvalId,
      approvalDigest:
        legacyPrepared.body.approval.approvalDigest
    }
  );
  assert.equal(legacyCreated.response.status, 200);
  const legacyInviteUrl = new URL(legacyCreated.body.inviteUrl);
  const [legacyInvitationRef, legacyInviteToken] =
    legacyInviteUrl.hash.slice("#invite=".length).split(".");
  const legacyClaimCookie = await claimInvitation({
    origin,
    invitationRef: legacyInvitationRef,
    inviteToken: legacyInviteToken
  });
  const migratedLegacy = await login({
    origin,
    code: "legacy-code",
    extraCookie: legacyClaimCookie
  });
  assert.ok(migratedLegacy.sessionCookie);
  const migratedList = await postJson(
    `${origin}/hcn/api/v1/team/invitations/list`,
    chanceHeaders,
    {}
  );
  assert.equal(migratedList.body.legacyReviewRequiredCount, 0);
  assert.deepEqual(migratedList.body.legacyReviewRequired, []);
  const migratedHealth = await (await fetch(`${origin}/health`)).json();
  assert.equal(
    migratedHealth.userOAuth.invitationOnlyAdmission
      .legacyPinMigration.compatibilityActive,
    false
  );
  assert.equal(
    migratedHealth.userOAuth.invitationOnlyAdmission
      .legacyPinMigration.preservedExistingAccessCount,
    0
  );

  const legacyRevokePrepared = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    { action: "revoke", invitationRef: legacyInvitationRef }
  );
  assert.equal(legacyRevokePrepared.response.status, 200);
  const legacyRevoked = await postJson(
    `${origin}/hcn/api/v1/team/invitations/revoke`,
    chanceHeaders,
    {
      approvalId:
        legacyRevokePrepared.body.approval.approvalId,
      approvalDigest:
        legacyRevokePrepared.body.approval.approvalDigest
    }
  );
  assert.equal(legacyRevoked.response.status, 200);
  assert.ok(legacyRevoked.body.revokedSessionCount >= 2);
  for (const cookie of [
    legacySession.sessionCookie,
    migratedLegacy.sessionCookie
  ]) {
    const revokedLegacySession = await fetch(
      `${origin}/hcn/auth/session`,
      { headers: { cookie } }
    );
    assert.equal(revokedLegacySession.status, 401);
  }

  const stalePrepare = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    {
      action: "create",
      email: "stale@outside.example",
      role: "employee",
      expiresInHours: 72
    }
  );
  assert.equal(
    stalePrepare.response.status,
    200,
    JSON.stringify(stalePrepare.body)
  );
  staleEmployeeActive = false;
  const readsBeforeStaleExecute = jobNimbusUserReads;
  const staleCreate = await postJson(
    `${origin}/hcn/api/v1/team/invitations/create`,
    chanceHeaders,
    {
      approvalId: stalePrepare.body.approval.approvalId,
      approvalDigest:
        stalePrepare.body.approval.approvalDigest
    }
  );
  assert.equal(staleCreate.response.status, 409);
  assert.ok(jobNimbusUserReads > readsBeforeStaleExecute);

  const prepared = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    {
      action: "create",
      email: "invitee@outside.example",
      role: "employee",
      expiresInHours: 72
    }
  );
  assert.equal(prepared.response.status, 200);
  assert.equal(
    Object.hasOwn(prepared.body.plan, "jobNimbusOwnerId"),
    false
  );
  assert.equal(prepared.body.plan.managementVisibility, "none");
  const created = await postJson(
    `${origin}/hcn/api/v1/team/invitations/create`,
    chanceHeaders,
    {
      approvalId: prepared.body.approval.approvalId,
      approvalDigest: prepared.body.approval.approvalDigest
    }
  );
  assert.equal(created.response.status, 200);
  assert.equal(created.body.emailSent, false);
  const inviteUrl = new URL(created.body.inviteUrl);
  assert.equal(inviteUrl.origin, origin);
  assert.equal(inviteUrl.pathname, "/hcn/invite");
  assert.equal(inviteUrl.search, "");
  assert.match(
    inviteUrl.hash,
    /^#invite=invite_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/
  );
  const [invitationRef, inviteToken] =
    inviteUrl.hash.slice("#invite=".length).split(".");

  const wrongClaimCookie = await claimInvitation({
    origin,
    invitationRef,
    inviteToken
  });
  const wrong = await login({
    origin,
    code: "wrong-code",
    extraCookie: wrongClaimCookie
  });
  assert.equal(wrong.sessionCookie, "");

  const correctClaimCookie = await claimInvitation({
    origin,
    invitationRef,
    inviteToken
  });
  const employee = await login({
    origin,
    code: "invite-code",
    extraCookie: correctClaimCookie
  });
  assert.ok(
    employee.sessionCookie,
    `callback=${employee.response.status} location=${employee.response.headers.get("location") || ""}`
  );

  const replay = await fetch(
    `${origin}/hcn/auth/invitation`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json"
      },
      body: JSON.stringify({ invitationRef, inviteToken })
    }
  );
  assert.equal(replay.status, 403);

  const employeeSessionResponse = await fetch(
    `${origin}/hcn/auth/session`,
    { headers: { cookie: employee.sessionCookie } }
  );
  const employeeSession = await employeeSessionResponse.json();
  assert.equal(employeeSession.profile.email, "invitee@outside.example");
  assert.equal(
    employeeSession.capabilities.teamInvitations.manage,
    false
  );
  const employeeList = await postJson(
    `${origin}/hcn/api/v1/team/invitations/list`,
    {
      cookie: employee.sessionCookie,
      origin,
      "content-type": "application/json",
      "x-hcn-csrf":
        employeeSession.browserSession.csrfToken
    },
    {}
  );
  assert.equal(employeeList.response.status, 403);

  const revokePrepared = await postJson(
    `${origin}/hcn/api/v1/team/invitations/prepare`,
    chanceHeaders,
    { action: "revoke", invitationRef }
  );
  assert.equal(revokePrepared.response.status, 200);
  assert.equal(
    revokePrepared.body.plan.connectorGrant,
    "revoke_if_present"
  );
  assert.equal(
    revokePrepared.body.plan.quoBinding,
    "revoke_if_present"
  );
  const revoked = await postJson(
    `${origin}/hcn/api/v1/team/invitations/revoke`,
    chanceHeaders,
    {
      approvalId:
        revokePrepared.body.approval.approvalId,
      approvalDigest:
        revokePrepared.body.approval.approvalDigest
    }
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.googleConnectorGrant, "not_present");
  assert.equal(revoked.body.quoBinding, "not_present");
  assert.ok(revoked.body.revokedSessionCount >= 1);
  const revokedSession = await fetch(
    `${origin}/hcn/auth/session`,
    { headers: { cookie: employee.sessionCookie } }
  );
  assert.equal(revokedSession.status, 401);

  const unknown = await login({
    origin,
    code: "unknown-code"
  });
  assert.equal(unknown.sessionCookie, "");
});

async function claimInvitation({
  origin,
  invitationRef,
  inviteToken
}) {
  const response = await fetch(
    `${origin}/hcn/auth/invitation`,
    {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json"
      },
      body: JSON.stringify({ invitationRef, inviteToken })
    }
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie();
  const invitationCookie = setCookie.find((value) =>
    value.startsWith("hcn_invitation=")
  );
  assert.ok(invitationCookie);
  return cookiePair(invitationCookie);
}

async function login({ origin, code, extraCookie = "" }) {
  const loginResponse = await fetch(
    `${origin}/hcn/auth/login?returnTo=%2Fhcn%2F`,
    {
      redirect: "manual",
      headers: extraCookie ? { cookie: extraCookie } : {}
    }
  );
  assert.equal(loginResponse.status, 302);
  const loginCookie = cookiePair(
    loginResponse.headers.getSetCookie().find((value) =>
      value.startsWith("__Host-hcn_login=")
    )
  );
  const authorizationUrl = new URL(
    loginResponse.headers.get("location")
  );
  const callback = await fetch(
    `${origin}/oauth/google/callback?${new URLSearchParams({
      code,
      state: authorizationUrl.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: {
        cookie: [loginCookie, extraCookie]
          .filter(Boolean)
          .join("; ")
      }
    }
  );
  const sessionSetCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-hcn_session="));
  return {
    response: callback,
    sessionCookie: sessionSetCookie
      ? cookiePair(sessionSetCookie)
      : ""
  };
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return {
    response,
    body: await response.json()
  };
}

function activeUser(jnid, email, displayName) {
  return {
    jnid,
    email,
    display_name: displayName,
    is_active: true
  };
}

function cookiePair(value) {
  return String(value || "").split(";", 1)[0];
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json"
  });
  res.end(JSON.stringify(body));
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, port, childOutput = []) {
  let lastError = "";
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `HCN invitation server exited early: ${childOutput.join("")}`
      );
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`
      );
      if (response.ok) return;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `HCN invitation server did not start: ${lastError}\n${childOutput.join("")}`
  );
}
