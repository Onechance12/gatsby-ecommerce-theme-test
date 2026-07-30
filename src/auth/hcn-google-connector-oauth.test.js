import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HCN_CONSOLE_AUTHORIZE_STATE_KIND
} from "./hcn-console-auth.js";
import {
  createHcnConsoleStateCodec
} from "./hcn-console-state-codec.js";
import {
  HCN_GOOGLE_CONNECTOR_AUTHORIZE_STATE_KIND,
  HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES,
  HcnGoogleConnectorOAuthError,
  createHcnGoogleConnectorOAuthCoordinator
} from "./hcn-google-connector-oauth.js";

const START = Date.UTC(2026, 6, 29, 12, 0, 0);
const CALLBACK_URI =
  "https://bridge.example/oauth/google/callback";
const SESSION_BINDING = "S".repeat(43);
const GOOGLE_SUBJECT = "google-subject-1";
const ACCESS_TOKEN = "ya29.access-token-secret";
const REFRESH_TOKEN = "1//refresh-token-secret";
const CLIENT_SECRET = "google-client-secret";

test("authorization is separate from sign-in and requests exact offline connector access", async () => {
  const fixture = createFixture();
  const result = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT,
    returnTo: "/hcn/connections?provider=google"
  });
  const url = new URL(result.redirectUrl);

  assert.deepEqual(result, {
    status: "authorization_required",
    redirectUrl: result.redirectUrl
  });
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(
    url.pathname,
    "/o/oauth2/v2/auth"
  );
  assert.equal(url.searchParams.get("client_id"), "google-client-id");
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("scope"),
    HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.join(" ")
  );
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("hd"), "wavepa.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const verifier = Buffer.alloc(64, 1).toString("base64url");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url")
  );

  const state = fixture.codec.open(url.searchParams.get("state"));
  assert.deepEqual(
    Object.keys(state).sort(),
    ["exp", "kind", "transactionId"]
  );
  assert.equal(
    state.kind,
    HCN_GOOGLE_CONNECTOR_AUTHORIZE_STATE_KIND
  );
  assert.notEqual(
    state.kind,
    HCN_CONSOLE_AUTHORIZE_STATE_KIND
  );
  assert.equal("sessionBinding" in state, false);
  assert.equal("googleSubject" in state, false);
  assert.equal("pkceVerifier" in state, false);
  assert.equal(
    JSON.stringify(result).includes(SESSION_BINDING),
    false
  );
});

test("successful callback verifies the pinned identity and privately persists the exact grant", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT,
    returnTo: "/hcn/connections"
  });
  const completed = await fixture.coordinator.completeCallback({
    state: stateFrom(begin),
    code: "google-authorization-code",
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });

  assert.deepEqual(completed, {
    status: "connected",
    redirectPath: "/hcn/connections"
  });
  assert.equal(fixture.fetchCalls.length, 1);
  assert.equal(
    fixture.fetchCalls[0].url,
    "https://oauth2.googleapis.com/token"
  );
  assert.equal(fixture.fetchCalls[0].options.method, "POST");
  assert.equal(fixture.fetchCalls[0].options.redirect, "error");
  const form = new URLSearchParams(
    fixture.fetchCalls[0].options.body
  );
  assert.equal(form.get("code"), "google-authorization-code");
  assert.equal(form.get("client_id"), "google-client-id");
  assert.equal(form.get("client_secret"), CLIENT_SECRET);
  assert.equal(form.get("redirect_uri"), CALLBACK_URI);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(
    form.get("code_verifier"),
    Buffer.alloc(64, 1).toString("base64url")
  );

  assert.equal(fixture.authenticationCalls.length, 1);
  assert.deepEqual(
    Object.keys(fixture.authenticationCalls[0]).sort(),
    ["accessToken", "allowedDomain", "clientId", "fetch"]
  );
  assert.equal(
    fixture.authenticationCalls[0].accessToken,
    ACCESS_TOKEN
  );
  assert.equal(
    fixture.authenticationCalls[0].allowedDomain,
    "wavepa.com"
  );
  assert.equal(fixture.persistCalls.length, 1);
  assert.deepEqual(fixture.persistCalls[0], {
    googleSubject: GOOGLE_SUBJECT,
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    accessExpiresAt: "2026-07-29T13:00:00.000Z",
    scopes: HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES
  });
  assert.equal(Object.isFrozen(fixture.persistCalls[0]), true);
  assert.equal(
    Object.isFrozen(fixture.persistCalls[0].scopes),
    true
  );

  const publicResult = JSON.stringify({ begin, completed });
  for (const secret of [
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    CLIENT_SECRET,
    "google-authorization-code",
    SESSION_BINDING,
    GOOGLE_SUBJECT
  ]) {
    assert.equal(publicResult.includes(secret), false);
  }
});

test("a callback transaction is one-shot and cannot be replayed", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const callback = {
    state: stateFrom(begin),
    code: "authorization-code",
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  };

  await fixture.coordinator.completeCallback(callback);
  await assert.rejects(
    fixture.coordinator.completeCallback(callback),
    isConnectorError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 1);
  assert.equal(fixture.persistCalls.length, 1);
});

test("a cross-session attempt consumes the transaction before failing", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const state = stateFrom(begin);

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state,
      code: "authorization-code",
      sessionBinding: "X".repeat(43),
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  await assert.rejects(
    fixture.coordinator.completeCallback({
      state,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);
});

test("a cross-subject attempt consumes the transaction before failing", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const state = stateFrom(begin);

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: "different-google-subject"
    }),
    isConnectorError("invalid_request", 400)
  );
  await assert.rejects(
    fixture.coordinator.completeCallback({
      state,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);
});

test("a missing refresh token is rejected and never persisted", async () => {
  const fixture = createFixture({
    tokenPayload: {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      scope: requiredScopeText()
    }
  });
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: stateFrom(begin),
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("access_denied", 403)
  );
  assert.equal(fixture.authenticationCalls.length, 0);
  assert.equal(fixture.persistCalls.length, 0);
});

test("missing, duplicate, and additional scopes are rejected", async () => {
  const invalidScopes = [
    HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.slice(0, -1),
    [
      ...HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.slice(0, -1),
      "openid"
    ],
    [
      ...HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES,
      "https://www.googleapis.com/auth/drive"
    ]
  ];

  for (const scopes of invalidScopes) {
    const fixture = createFixture({
      tokenPayload: validTokenPayload({
        scope: scopes.join(" ")
      })
    });
    const begin = await fixture.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    });
    await assert.rejects(
      fixture.coordinator.completeCallback({
        state: stateFrom(begin),
        code: "authorization-code",
        sessionBinding: SESSION_BINDING,
        googleSubject: GOOGLE_SUBJECT
      }),
      isConnectorError("access_denied", 403)
    );
    assert.equal(fixture.persistCalls.length, 0);
  }
});

test("Google userinfo scope aliases normalize to the exact requested identity scopes", async () => {
  const scopes =
    HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.map((scope) => {
      if (scope === "email") {
        return "https://www.googleapis.com/auth/userinfo.email";
      }
      if (scope === "profile") {
        return "https://www.googleapis.com/auth/userinfo.profile";
      }
      return scope;
    });
  const fixture = createFixture({
    tokenPayload: validTokenPayload({
      scope: scopes.join(" ")
    })
  });
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const result = await fixture.coordinator.completeCallback({
    state: stateFrom(begin),
    code: "authorization-code",
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  assert.equal(result.status, "connected");
  assert.deepEqual(
    fixture.persistCalls[0].scopes,
    HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES
  );
});

test("provider callback errors return only a safe status and consume the transaction", async () => {
  for (const [providerError, status] of [
    ["access_denied", "cancelled"],
    ["server_error", "provider_error"]
  ]) {
    const fixture = createFixture();
    const begin = await fixture.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT,
      returnTo: "/hcn/connections"
    });
    const state = stateFrom(begin);
    const completed = await fixture.coordinator.completeCallback({
      state,
      error: providerError,
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    });
    assert.deepEqual(completed, {
      status,
      redirectPath: "/hcn/connections"
    });
    assert.equal(JSON.stringify(completed).includes(providerError), false);
    assert.equal(fixture.fetchCalls.length, 0);
    assert.equal(fixture.persistCalls.length, 0);
    await assert.rejects(
      fixture.coordinator.completeCallback({
        state,
        error: providerError,
        sessionBinding: SESSION_BINDING,
        googleSubject: GOOGLE_SUBJECT
      }),
      isConnectorError("invalid_request", 400)
    );
  }
});

test("cryptographically tampered state fails without revealing a transaction", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const original = stateFrom(begin);
  const index = Math.floor(original.length / 2);
  const tampered = `${original.slice(0, index)}${
    original[index] === "A" ? "B" : "A"
  }${original.slice(index + 1)}`;

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: tampered,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);

  const completed = await fixture.coordinator.completeCallback({
    state: original,
    code: "authorization-code",
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  assert.equal(completed.status, "connected");
});

test("authenticated state metadata mismatch consumes the transaction before validation", async () => {
  const fixture = createFixture();
  const begin = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  const originalState = stateFrom(begin);
  const payload = fixture.codec.open(originalState);
  const changedState = fixture.codec.seal({
    ...payload,
    exp: payload.exp + 1
  });

  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: changedState,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  await assert.rejects(
    fixture.coordinator.completeCallback({
      state: originalState,
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("invalid_request", 400)
  );
  assert.equal(fixture.fetchCalls.length, 0);
});

test("the authenticated Google subject and hosted domain must match exactly", async () => {
  for (const identity of [
    {
      subject: "different-google-subject",
      hostedDomain: "wavepa.com"
    },
    {
      subject: GOOGLE_SUBJECT,
      hostedDomain: "other.example"
    }
  ]) {
    const fixture = createFixture({ identity });
    const begin = await fixture.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    });
    await assert.rejects(
      fixture.coordinator.completeCallback({
        state: stateFrom(begin),
        code: "authorization-code",
        sessionBinding: SESSION_BINDING,
        googleSubject: GOOGLE_SUBJECT
      }),
      isConnectorError("access_denied", 403)
    );
    assert.equal(fixture.persistCalls.length, 0);
  }
});

test("transactions are bounded and expired entries are purged", async () => {
  const fixture = createFixture({
    configOverrides: {
      maxTransactions: 2,
      transactionTtlMs: 1000
    }
  });
  await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  await fixture.coordinator.beginAuthorization({
    sessionBinding: "T".repeat(43),
    googleSubject: "google-subject-2"
  });
  await assert.rejects(
    fixture.coordinator.beginAuthorization({
      sessionBinding: "U".repeat(43),
      googleSubject: "google-subject-3"
    }),
    isConnectorError("temporarily_unavailable", 503)
  );

  fixture.setNow(START + 1001);
  const next = await fixture.coordinator.beginAuthorization({
    sessionBinding: "U".repeat(43),
    googleSubject: "google-subject-3"
  });
  assert.equal(next.status, "authorization_required");
});

test("failed state sealing releases its in-memory transaction slot", async () => {
  let sealCalls = 0;
  const fixture = createFixture({
    configOverrides: { maxTransactions: 1 },
    seal(payload) {
      sealCalls += 1;
      if (sealCalls === 1) throw new Error("seal unavailable");
      return fixture.codec.seal(payload);
    }
  });

  await assert.rejects(
    fixture.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    isConnectorError("temporarily_unavailable", 503)
  );
  const next = await fixture.coordinator.beginAuthorization({
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  });
  assert.equal(next.status, "authorization_required");
});

test("unsafe input and a non-shared callback URI fail closed", async () => {
  const fixture = createFixture();
  for (const input of [
    {
      sessionBinding: "short",
      googleSubject: GOOGLE_SUBJECT
    },
    {
      sessionBinding: SESSION_BINDING,
      googleSubject: " subject "
    },
    {
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT,
      returnTo: "https://attacker.example/hcn"
    }
  ]) {
    await assert.rejects(
      fixture.coordinator.beginAuthorization(input),
      isConnectorError("invalid_request", 400)
    );
  }

  assert.throws(
    () => createFixture({
      configOverrides: {
        callbackUri: "https://bridge.example/oauth/google/connect"
      }
    }),
    /exact shared callback/
  );
});

test("provider and persistence failures are safe, terminal, and token-free", async () => {
  const providerFailure = createFixture({
    fetchImpl: async () => new Response(
      JSON.stringify({ error: "invalid_grant" }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    )
  });
  const providerBegin =
    await providerFailure.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    });
  await assert.rejects(
    providerFailure.coordinator.completeCallback({
      state: stateFrom(providerBegin),
      code: "authorization-code",
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    }),
    (error) => {
      assert.equal(JSON.stringify(error).includes(ACCESS_TOKEN), false);
      return isConnectorError("access_denied", 403)(error);
    }
  );

  const persistenceFailure = createFixture({
    persistGrant: async () => {
      throw new Error(`do not expose ${REFRESH_TOKEN}`);
    }
  });
  const persistenceBegin =
    await persistenceFailure.coordinator.beginAuthorization({
      sessionBinding: SESSION_BINDING,
      googleSubject: GOOGLE_SUBJECT
    });
  const callback = {
    state: stateFrom(persistenceBegin),
    code: "authorization-code",
    sessionBinding: SESSION_BINDING,
    googleSubject: GOOGLE_SUBJECT
  };
  await assert.rejects(
    persistenceFailure.coordinator.completeCallback(callback),
    (error) => {
      assert.equal(error.message.includes(REFRESH_TOKEN), false);
      return isConnectorError(
        "temporarily_unavailable",
        503
      )(error);
    }
  );
  await assert.rejects(
    persistenceFailure.coordinator.completeCallback(callback),
    isConnectorError("invalid_request", 400)
  );
});

function createFixture({
  tokenPayload = validTokenPayload(),
  identity = {
    subject: GOOGLE_SUBJECT,
    hostedDomain: "wavepa.com"
  },
  fetchImpl,
  persistGrant,
  seal,
  configOverrides = {}
} = {}) {
  let timestamp = START;
  let randomCounter = 0;
  const codec = createHcnConsoleStateCodec({
    secret: "connector-state-test-secret-at-least-32-bytes",
    randomBytes(length) {
      return Buffer.alloc(length, 77);
    }
  });
  const fetchCalls = [];
  const resolvedFetch = fetchImpl || (async (url, options) => {
    fetchCalls.push({ url, options });
    return new Response(JSON.stringify(tokenPayload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const authenticationCalls = [];
  const authenticateCurrentIdentity = async (input) => {
    authenticationCalls.push(input);
    return identity;
  };
  const persistCalls = [];
  const resolvedPersistGrant = persistGrant || (async (grant) => {
    persistCalls.push(grant);
  });
  const coordinator = createHcnGoogleConnectorOAuthCoordinator({
    seal: seal || codec.seal,
    open: codec.open,
    fetch: resolvedFetch,
    authenticateCurrentIdentity,
    persistGrant: resolvedPersistGrant,
    now: () => timestamp,
    randomBytes(length) {
      randomCounter += 1;
      return Buffer.alloc(length, randomCounter);
    },
    config: {
      clientId: "google-client-id",
      clientSecret: CLIENT_SECRET,
      callbackUri: CALLBACK_URI,
      allowedDomain: "wavepa.com",
      ...configOverrides
    }
  });
  return {
    coordinator,
    codec,
    fetchCalls,
    authenticationCalls,
    persistCalls,
    setNow(value) {
      timestamp = value;
    }
  };
}

function validTokenPayload(overrides = {}) {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
    scope: requiredScopeText(),
    ...overrides
  };
}

function requiredScopeText() {
  return HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.join(" ");
}

function stateFrom(beginResult) {
  return new URL(beginResult.redirectUrl).searchParams.get("state");
}

function isConnectorError(code, statusCode) {
  return (error) => {
    assert.ok(error instanceof HcnGoogleConnectorOAuthError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}
