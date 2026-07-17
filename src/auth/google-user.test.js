import assert from "node:assert/strict";
import test from "node:test";

import { authenticateGoogleAccessToken, parseWaveUsers, routeAllowed } from "./google-user.js";

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

test("coordinator routes are read-focused while Chance retains full access", () => {
  const coordinator = { type: "google_oauth", role: "client_coordinator" };
  const chance = { type: "google_oauth", role: "chance" };
  assert.equal(routeAllowed(coordinator, "POST", "/gmail/search"), true);
  assert.equal(routeAllowed(coordinator, "POST", "/claim-filing/call"), false);
  assert.equal(routeAllowed(coordinator, "POST", "/quo/send"), false);
  assert.equal(routeAllowed(chance, "POST", "/claim-filing/call"), true);
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
