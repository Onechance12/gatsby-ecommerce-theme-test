import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createHcnConsoleOAuthCoordinator,
  HCN_CONSOLE_AUTHORIZE_STATE_KIND,
  HcnConsoleOAuthError
} from "./hcn-console-auth.js";
import {
  HCN_LOGIN_COOKIE_NAME,
  HCN_SESSION_COOKIE_NAME
} from "./hcn-console-http.js";
import {
  createHcnConsoleSessionStore
} from "./hcn-console-session-store.js";
import {
  createHcnConsoleStateCodec
} from "./hcn-console-state-codec.js";

const START = Date.parse("2026-07-28T18:00:00.000Z");
const GOOGLE_ACCESS_SECRET = "provider-access-token-secret";
const GOOGLE_CLIENT_SECRET = "provider-client-secret";
const AUTHORIZATION_VERSION = `authz_v1_${"a".repeat(64)}`;

test("authorization uses the shared callback, minimal scopes, and S256 PKCE", async () => {
  const fixture = createFixture();
  const result = await fixture.coordinator.beginAuthorization({
    returnTo: "/hcn/system?view=build#runtime"
  });
  const url = new URL(result.redirectUrl);

  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"),
    "https://bridge.example/oauth/google/callback");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256")
      .update(fixture.createdTransactions[0].pkceVerifier, "ascii")
      .digest("base64url")
  );

  const statePayload = fixture.codec.open(url.searchParams.get("state"));
  assert.deepEqual(
    Object.keys(statePayload).sort(),
    ["exp", "kind", "transactionId"]
  );
  assert.equal(statePayload.kind, HCN_CONSOLE_AUTHORIZE_STATE_KIND);
  assert.equal("returnTo" in statePayload, false);
  assert.equal("pkceVerifier" in statePayload, false);
  assert.match(result.setCookies[0],
    new RegExp(`^${HCN_LOGIN_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
});

test("callback consumes the transaction, exchanges with its verifier, and creates an opaque session", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    returnTo: "/hcn/work-center?lane=today"
  });
  const state = new URL(begin.redirectUrl).searchParams.get("state");
  const loginBinding = cookieValue(begin.setCookies[0], HCN_LOGIN_COOKIE_NAME);

  const completed = await fixture.coordinator.completeCallback({
    state,
    code: "google-authorization-code",
    loginBinding
  });

  assert.equal(completed.redirectPath, "/hcn/work-center?lane=today");
  assert.equal(fixture.fetchCalls.length, 1);
  const tokenForm = new URLSearchParams(fixture.fetchCalls[0].options.body);
  assert.equal(tokenForm.get("code"), "google-authorization-code");
  assert.equal(tokenForm.get("code_verifier"),
    fixture.createdTransactions[0].pkceVerifier);
  assert.equal(tokenForm.get("client_secret"), GOOGLE_CLIENT_SECRET);
  assert.equal(tokenForm.get("redirect_uri"),
    "https://bridge.example/oauth/google/callback");
  assert.deepEqual(fixture.sessionInputs, [{
    subject: "chance@wavepa.com",
    googleSubject: "google-subject-1",
    role: "chance",
    authorizationVersion: AUTHORIZATION_VERSION
  }]);
  assert.match(completed.setCookies[0],
    new RegExp(`^${HCN_LOGIN_COOKIE_NAME}=;`));
  assert.match(completed.setCookies[1],
    new RegExp(`^${HCN_SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
});

test("exact-email approval supports Google accounts without a hosted-domain claim", async () => {
  const externalEmail = "manager@outside.example";
  const externalSubject = "external-google-subject";
  const fixture = createFixture({
    googleAllowedDomain: "",
    resolveApprovedUser: async () => ({
      email: externalEmail,
      name: "External Manager",
      role: "manager",
      enabled: true,
      googleSubject: externalSubject,
      authorizationVersion: AUTHORIZATION_VERSION
    }),
    authenticateGoogleAccessToken: async (options) => {
      const candidate = {
        subject: externalSubject,
        email: externalEmail,
        name: "External Manager",
        hostedDomain: ""
      };
      const approved = await options.resolveUser(candidate);
      return {
        type: "google_oauth",
        ...candidate,
        role: approved.role,
        googleAccessToken: options.token
      };
    }
  });
  const begin = await fixture.coordinator.beginAuthorization({
    returnTo: "/hcn/"
  });
  const authorizationUrl = new URL(begin.redirectUrl);
  assert.equal(authorizationUrl.searchParams.has("hd"), false);

  const completed = await fixture.coordinator.completeCallback({
    state: authorizationUrl.searchParams.get("state"),
    code: "external-google-code",
    loginBinding: cookieValue(
      begin.setCookies[0],
      HCN_LOGIN_COOKIE_NAME
    )
  });

  assert.equal(completed.redirectPath, "/hcn/");
  assert.deepEqual(fixture.sessionInputs, [{
    subject: externalEmail,
    googleSubject: externalSubject,
    role: "manager",
    authorizationVersion: AUTHORIZATION_VERSION
  }]);
});

test("return paths are confined to the HCN console", async () => {
  const fixture = createFixture();
  for (const unsafe of [
    "https://attacker.example/hcn",
    "//attacker.example/hcn",
    "/other",
    "/hcn/%2e%2e/other",
    "/hcn/%5c%5cattacker.example"
  ]) {
    await assert.rejects(
      fixture.coordinator.beginAuthorization({ returnTo: unsafe }),
      isOAuthError("invalid_request", 400)
    );
  }
  assert.equal(fixture.createdTransactions.length, 0);
});

test("tampered state and a mismatched binding fail closed and cannot be replayed", async () => {
  const fixture = createFixture();
  const first = await fixture.coordinator.beginAuthorization();
  const firstState = new URL(first.redirectUrl).searchParams.get("state");
  const firstBinding = cookieValue(
    first.setCookies[0],
    HCN_LOGIN_COOKIE_NAME
  );
  const tamperedState = `${firstState.slice(0, -1)}${
    firstState.endsWith("A") ? "B" : "A"
  }`;

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: tamperedState,
      code: "code",
      loginBinding: firstBinding
    }),
    isOAuthError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: firstState,
      code: "code",
      loginBinding: "A".repeat(43)
    }),
    isOAuthError("invalid_request", 400)
  );
  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: firstState,
      code: "code",
      loginBinding: firstBinding
    }),
    isOAuthError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);
});

test("expired state and provider denial never exchange a code", async () => {
  const fixture = createFixture();
  const expired = await fixture.coordinator.beginAuthorization();
  const expiredState =
    new URL(expired.redirectUrl).searchParams.get("state");
  const expiredBinding = cookieValue(
    expired.setCookies[0],
    HCN_LOGIN_COOKIE_NAME
  );
  fixture.setNow(START + 10 * 60 * 1000);

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: expiredState,
      code: "code",
      loginBinding: expiredBinding
    }),
    isOAuthError("invalid_request", 400)
  );

  fixture.setNow(START);
  const denied = await fixture.coordinator.beginAuthorization();
  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: new URL(denied.redirectUrl).searchParams.get("state"),
      error: "access_denied",
      loginBinding: cookieValue(
        denied.setCookies[0],
        HCN_LOGIN_COOKIE_NAME
      )
    }),
    isOAuthError("access_denied", 401)
  );
  assert.equal(fixture.fetchCalls.length, 0);
});

test("an unapproved current user cannot receive a browser session", async () => {
  const fixture = createFixture({
    resolveApprovedUser: async () => null
  });
  const begin = await fixture.coordinator.beginAuthorization();

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: new URL(begin.redirectUrl).searchParams.get("state"),
      code: "code",
      loginBinding: cookieValue(
        begin.setCookies[0],
        HCN_LOGIN_COOKIE_NAME
      )
    }),
    isOAuthError("access_denied", 403)
  );
  assert.deepEqual(fixture.sessionInputs, []);
});

test("a missing or mismatched immutable subject pin cannot create a browser session", async () => {
  for (const resolveApprovedUser of [
    async () => ({
      email: "chance@wavepa.com",
      role: "chance",
      enabled: true
    }),
    async () => ({
      email: "chance@wavepa.com",
      role: "chance",
      enabled: true,
      googleSubject: "different-google-subject"
    })
  ]) {
    const fixture = createFixture({ resolveApprovedUser });
    const begin = await fixture.coordinator.beginAuthorization();
    await assert.rejects(
      fixture.coordinator.completeCallback({
        state: new URL(begin.redirectUrl).searchParams.get("state"),
        code: "code",
        loginBinding: cookieValue(
          begin.setCookies[0],
          HCN_LOGIN_COOKIE_NAME
        )
      }),
      isOAuthError("access_denied", 403)
    );
    assert.deepEqual(fixture.sessionInputs, []);
  }
});

test("mismatched authenticated and approved identities fail closed", async () => {
  const fixture = createFixture({
    authenticateGoogleAccessToken: async (options) => {
      const approved = await options.resolveUser({
        subject: "google-subject-1",
        email: "chance@wavepa.com",
        name: "Chance",
        hostedDomain: "wavepa.com"
      });
      return {
        type: "google_oauth",
        subject: "google-subject-1",
        email: "other@wavepa.com",
        name: "Other",
        hostedDomain: "wavepa.com",
        role: approved.role,
        googleAccessToken: options.token
      };
    }
  });
  const begin = await fixture.coordinator.beginAuthorization();

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: new URL(begin.redirectUrl).searchParams.get("state"),
      code: "code",
      loginBinding: cookieValue(
        begin.setCookies[0],
        HCN_LOGIN_COOKIE_NAME
      )
    }),
    isOAuthError("access_denied", 403)
  );
  assert.deepEqual(fixture.sessionInputs, []);
});

test("callback results and session records do not serialize provider or PKCE secrets", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    returnTo: "/hcn"
  });
  const completed = await fixture.coordinator.completeCallback({
    state: new URL(begin.redirectUrl).searchParams.get("state"),
    code: "authorization-code-secret",
    loginBinding: cookieValue(
      begin.setCookies[0],
      HCN_LOGIN_COOKIE_NAME
    )
  });
  const serialized = JSON.stringify({
    begin,
    completed,
    sessionInput: fixture.sessionInputs[0]
  });

  assert.equal(serialized.includes(GOOGLE_ACCESS_SECRET), false);
  assert.equal(serialized.includes(GOOGLE_CLIENT_SECRET), false);
  assert.equal(serialized.includes("authorization-code-secret"), false);
  assert.equal(
    serialized.includes(fixture.createdTransactions[0].pkceVerifier),
    false
  );
  assert.equal(serialized.includes("chance@wavepa.com"), true);
  assert.deepEqual(Object.keys(fixture.sessionInputs[0]),
    ["subject", "googleSubject", "role", "authorizationVersion"]);
});

function createFixture({
  resolveApprovedUser = async () => ({
    email: "chance@wavepa.com",
    name: "Chance",
    role: "chance",
    enabled: true,
    googleSubject: "google-subject-1",
    authorizationVersion: AUTHORIZATION_VERSION
  }),
  authenticateGoogleAccessToken = defaultAuthenticator,
  googleAllowedDomain = "wavepa.com"
} = {}) {
  let timestamp = START;
  let randomCounter = 0;
  const now = () => timestamp;
  const codec = createHcnConsoleStateCodec({
    secret: "state-sealing-test-secret-at-least-32-bytes",
    randomBytes(length) {
      return Buffer.alloc(length, 17);
    }
  });
  const baseStore = createHcnConsoleSessionStore({ now });
  const createdTransactions = [];
  const sessionInputs = [];
  const store = {
    createLoginTransaction(input) {
      createdTransactions.push({ ...input });
      return baseStore.createLoginTransaction(input);
    },
    consumeLoginTransaction(input) {
      return baseStore.consumeLoginTransaction(input);
    },
    createSession(input) {
      sessionInputs.push({ ...input });
      return baseStore.createSession(input);
    }
  };
  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    return new Response(JSON.stringify({
      access_token: GOOGLE_ACCESS_SECRET
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const coordinator = createHcnConsoleOAuthCoordinator({
    fetchImpl,
    now,
    randomBytes(length) {
      randomCounter += 1;
      return Buffer.alloc(length, randomCounter);
    },
    store,
    sealState: codec.seal,
    openState: codec.open,
    authenticateGoogleAccessToken,
    resolveApprovedUser,
    canonicalOrigin: "https://bridge.example",
    google: {
      clientId: "google-client-id",
      clientSecret: GOOGLE_CLIENT_SECRET,
      allowedDomain: googleAllowedDomain
    }
  });
  return {
    coordinator,
    codec,
    createdTransactions,
    fetchCalls,
    sessionInputs,
    setNow(value) {
      timestamp = value;
    }
  };
}

async function defaultAuthenticator(options) {
  const candidate = {
    subject: "google-subject-1",
    email: "chance@wavepa.com",
    name: "Chance",
    hostedDomain: "wavepa.com"
  };
  const approved = await options.resolveUser(candidate);
  if (!approved || approved.enabled === false) {
    const error = new Error("not approved");
    error.statusCode = 403;
    throw error;
  }
  return {
    type: "google_oauth",
    ...candidate,
    role: approved.role,
    googleAccessToken: options.token
  };
}

function cookieValue(serialized, name) {
  const match = String(serialized).match(
    new RegExp(`^${name}=([^;]+);`)
  );
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function isOAuthError(code, statusCode) {
  return (error) => {
    assert.ok(error instanceof HcnConsoleOAuthError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}
