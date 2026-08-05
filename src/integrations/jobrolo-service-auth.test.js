import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobroloHcnAuthenticator,
  createJobroloHcnNonceGuard,
  deriveJobroloAssistantScopedBindingRef,
  deriveJobroloAssistantSessionBindingRef,
  loadJobroloHcnIntegrationConfiguration,
  signJobroloHcnRequest,
  stableCanonicalJson
} from "./jobrolo-service-auth.js";

const NOW = 1_800_000_000_000;
const SECRET = "jobrolo-hcn-test-secret-that-is-unique-123456";
const PATH = "/integrations/jobrolo/v1/status";

function fixture(overrides = {}) {
  const configuration = loadJobroloHcnIntegrationConfiguration({
    HCN_JOBROLO_ADAPTER_ENABLED: "true",
    HCN_JOBROLO_CLIENT_ID: "jobrolo-production",
    HCN_JOBROLO_SHARED_SECRET: SECRET,
    HCN_JOBROLO_PRINCIPAL_EMAIL: "chance@wavepa.com"
  });
  const body = overrides.body || {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_0123456789abcdef0123456789abcdef",
    actor: {
      sessionRef: "session_0123456789abcdef0123456789abcdef"
    },
    input: {}
  };
  const nonce = overrides.nonce || "nonce_0123456789abcdef0123456789abcdef";
  const timestamp = overrides.timestamp ?? NOW;
  const headers = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: PATH,
    timestamp,
    nonce,
    body
  });
  const authenticator = createJobroloHcnAuthenticator({
    configuration,
    now: () => NOW,
    nonceGuard: createJobroloHcnNonceGuard({ now: () => NOW })
  });
  return { authenticator, body, headers };
}

test("canonical JSON sorts object keys recursively but preserves arrays", () => {
  assert.equal(
    stableCanonicalJson({ z: [{ b: 2, a: 1 }], a: true }),
    '{"a":true,"z":[{"a":1,"b":2}]}'
  );
});

test("assistant continuity isolates sessions and exact general/file scopes", () => {
  const common = {
    tenantId: "tenant_0123456789abcdef",
    clientId: "jobrolo-production",
    principalRef: `principal_${"a".repeat(32)}`
  };
  const sessionA = deriveJobroloAssistantSessionBindingRef({
    ...common,
    sessionRef: `session_${"1".repeat(32)}`
  });
  const sameSessionA = deriveJobroloAssistantSessionBindingRef({
    ...common,
    sessionRef: `session_${"1".repeat(32)}`
  });
  const sessionB = deriveJobroloAssistantSessionBindingRef({
    ...common,
    sessionRef: `session_${"2".repeat(32)}`
  });
  assert.equal(sessionA, sameSessionA);
  assert.notEqual(sessionA, sessionB);

  const general = deriveJobroloAssistantScopedBindingRef({
    sessionBindingRef: sessionA,
    kind: "general",
    fileRef: ""
  });
  const fileA = deriveJobroloAssistantScopedBindingRef({
    sessionBindingRef: sessionA,
    kind: "file",
    fileRef: `subject_${"a".repeat(32)}`
  });
  const sameFileA = deriveJobroloAssistantScopedBindingRef({
    sessionBindingRef: sessionA,
    kind: "file",
    fileRef: `subject_${"a".repeat(32)}`
  });
  const fileB = deriveJobroloAssistantScopedBindingRef({
    sessionBindingRef: sessionA,
    kind: "file",
    fileRef: `subject_${"b".repeat(32)}`
  });
  assert.equal(fileA, sameFileA);
  assert.equal(new Set([general, fileA, fileB]).size, 3);
  assert.notEqual(
    fileA,
    deriveJobroloAssistantScopedBindingRef({
      sessionBindingRef: sessionB,
      kind: "file",
      fileRef: `subject_${"a".repeat(32)}`
    })
  );
  assert.throws(() => deriveJobroloAssistantScopedBindingRef({
    sessionBindingRef: sessionA,
    kind: "general",
    fileRef: `subject_${"a".repeat(32)}`
  }), /invalid/);
});

test("cross-repository signature fixture is byte-for-byte stable", () => {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_0123456789abcdef0123456789abcdef",
    actor: {
      sessionRef: "session_0123456789abcdef0123456789abcdef"
    },
    input: { limit: 10, offset: 0 }
  };
  assert.equal(
    stableCanonicalJson(body),
    '{"actor":{"sessionRef":"session_0123456789abcdef0123456789abcdef"},"input":{"limit":10,"offset":0},"requestId":"request_0123456789abcdef0123456789abcdef","schema":"jobrolo.hcn.request.v1"}'
  );
  assert.deepEqual(signJobroloHcnRequest({
    clientId: "jobrolo-contract-fixture",
    secret: "fixture-jobrolo-hcn-shared-secret-0123456789",
    pathname: "/integrations/jobrolo/v1/work-center",
    timestamp: 1_800_000_000_000,
    nonce: "nonce_0123456789abcdef0123456789abcdef",
    body
  }), {
    authorization: "Jobrolo-HMAC jobrolo-contract-fixture",
    "x-jobrolo-timestamp": "1800000000000",
    "x-jobrolo-nonce": "nonce_0123456789abcdef0123456789abcdef",
    "x-jobrolo-content-sha256":
      "38b96e66f249afa1a907fe397aac62fcf561c20a1daabb20550a0f373c0f840a",
    "x-jobrolo-signature":
      "282623fe3972377308c295c0b4dccd20e743b391c5228fcb4f4442663a3a2173"
  });
});

test("authenticates one signed fixed-principal adapter request", () => {
  const { authenticator, body, headers } = fixture();
  const result = authenticator.authenticate({
    method: "POST",
    pathname: PATH,
    headers,
    body
  });
  assert.equal(result.principalEmail, "chance@wavepa.com");
  assert.equal(result.requestId, body.requestId);
  assert.deepEqual(result.input, {});
});

test("rejects a replay after signature verification", () => {
  const { authenticator, body, headers } = fixture();
  authenticator.authenticate({ method: "POST", pathname: PATH, headers, body });
  assert.throws(
    () => authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers,
      body
    }),
    /replay/i
  );
});

test("retains future-dated nonces until their signature window closes", () => {
  let current = NOW;
  const configuration = loadJobroloHcnIntegrationConfiguration({
    HCN_JOBROLO_ADAPTER_ENABLED: "true",
    HCN_JOBROLO_CLIENT_ID: "jobrolo-production",
    HCN_JOBROLO_SHARED_SECRET: SECRET,
    HCN_JOBROLO_PRINCIPAL_EMAIL: "chance@wavepa.com"
  });
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_0123456789abcdef0123456789abcdef",
    actor: {
      sessionRef: "session_0123456789abcdef0123456789abcdef"
    },
    input: {}
  };
  const timestamp = NOW + 5 * 60_000;
  const headers = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: PATH,
    timestamp,
    nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    body
  });
  const authenticator = createJobroloHcnAuthenticator({
    configuration,
    now: () => current,
    nonceGuard: createJobroloHcnNonceGuard({ now: () => current })
  });

  authenticator.authenticate({ method: "POST", pathname: PATH, headers, body });
  current = NOW + 5 * 60_000 + 1;
  assert.throws(
    () => authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers,
      body
    }),
    /replay/i
  );
});

test("rejects tampered bodies and stale timestamps", () => {
  const signed = fixture();
  assert.throws(
    () => signed.authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: signed.headers,
      body: { ...signed.body, input: { offset: 0 } }
    }),
    /body hash/i
  );
  const stale = fixture({
    timestamp: NOW - 5 * 60_000 - 1,
    nonce: "nonce_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.throws(
    () => stale.authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: stale.headers,
      body: stale.body
    }),
    /stale/i
  );
});

test("caller cannot put an email or other identity selector in actor", () => {
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_0123456789abcdef0123456789abcdef",
    actor: {
      sessionRef: "session_0123456789abcdef0123456789abcdef",
      email: "someone-else@wavepa.com"
    },
    input: {}
  };
  const signed = fixture({ body });
  assert.throws(
    () => signed.authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: signed.headers,
      body
    }),
    /unsupported fields/i
  );
});

test("integration secret cannot reuse another platform credential", () => {
  assert.throws(
    () => loadJobroloHcnIntegrationConfiguration({
      HCN_JOBROLO_ADAPTER_ENABLED: "true",
      HCN_JOBROLO_CLIENT_ID: "jobrolo-production",
      HCN_JOBROLO_SHARED_SECRET: SECRET,
      HCN_JOBROLO_PRINCIPAL_EMAIL: "chance@wavepa.com"
    }, {
      disallowedSecrets: [{ name: "JOBNIMBUS_BRIDGE_TOKEN", value: SECRET }]
    }),
    /different from JOBNIMBUS_BRIDGE_TOKEN/
  );
});
