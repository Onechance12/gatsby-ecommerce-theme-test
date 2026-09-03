import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobroloHcnAuthenticator,
  createJobroloHcnNonceGuard,
  deriveJobroloAssistantScopedBindingRef,
  deriveJobroloAssistantSessionBindingRef,
  HCN_JOBROLO_CLAIM_FILING_ROUTES,
  HCN_JOBROLO_NOTE_WRITEBACK_ROUTES,
  JOBROLO_HCN_GENERAL_EFFECT_ROUTES,
  JOBROLO_HCN_GENERAL_READ_ONLY_ROUTES,
  JOBROLO_HCN_READ_ROUTES,
  JOBROLO_HCN_ROUTES,
  jobroloHcnGeneralProfileAllowsRoute,
  loadJobroloHcnClaimFilingConfiguration,
  loadJobroloHcnClaimFilingRegistry,
  loadJobroloHcnIntegrationConfiguration,
  loadJobroloHcnIntegrationRegistry,
  loadJobroloHcnNoteWritebackConfiguration,
  loadJobroloHcnNoteWritebackRegistry,
  resolveJobroloHcnClaimFilingProfile,
  resolveJobroloHcnIntegrationProfile,
  resolveJobroloHcnNoteWritebackProfile,
  signJobroloHcnRequest,
  stableCanonicalJson
} from "./jobrolo-service-auth.js";

const NOW = 1_800_000_000_000;
const SECRET = "jobrolo-hcn-test-secret-that-is-unique-123456";
const PATH = "/integrations/jobrolo/v1/status";
const NOTE_PATH = "/integrations/jobrolo/v1/action-plans/prepare";
const NOTE_SECRET =
  "jobrolo-note-writeback-test-secret-unique-123456";
const CLAIM_PATH = "/integrations/jobrolo/v1/claim-filings/prepare";
const CLAIM_SECRET =
  "jobrolo-claim-filing-test-secret-unique-123456";
const SECOND_CLAIM_SECRET =
  "jobrolo-claim-filing-second-pa-secret-123456";

test("general adapter read surface is explicit and excludes every effect route", () => {
  assert.deepEqual(JOBROLO_HCN_READ_ROUTES, [
    "/integrations/jobrolo/v1/status",
    "/integrations/jobrolo/v1/work-center",
    "/integrations/jobrolo/v1/file-review",
    "/integrations/jobrolo/v1/communication-sweep",
    "/integrations/jobrolo/v1/quo-phone-history",
    "/integrations/jobrolo/v1/management-sweep"
  ]);
  assert.equal(
    JOBROLO_HCN_READ_ROUTES.some((route) =>
      /(?:execute|prepare|writeback|send|call)/.test(route)
    ),
    false
  );
  assert.equal(
    JOBROLO_HCN_GENERAL_READ_ONLY_ROUTES.some((route) =>
      JOBROLO_HCN_GENERAL_EFFECT_ROUTES.includes(route)
    ),
    false
  );
  assert.deepEqual(
    [...new Set([
      ...JOBROLO_HCN_GENERAL_READ_ONLY_ROUTES,
      ...JOBROLO_HCN_GENERAL_EFFECT_ROUTES
    ])].sort(),
    [...JOBROLO_HCN_ROUTES].sort(),
    "read-only and effect routes must exactly partition the general adapter"
  );
});

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

test("note-writeback credential is default-off and all-or-nothing", () => {
  assert.deepEqual(
    loadJobroloHcnNoteWritebackConfiguration({}),
    {
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    }
  );
  assert.throws(
    () => loadJobroloHcnNoteWritebackConfiguration({
      HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "false",
      HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: "jobrolo-note-writeback"
    }),
    /must be true/i
  );
  assert.throws(
    () => loadJobroloHcnNoteWritebackConfiguration({
      HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "true",
      HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: "jobrolo-note-writeback",
      HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET: NOTE_SECRET
    }),
    /principal/i
  );
});

test("note-writeback credential cannot reuse a client id or secret", () => {
  const env = {
    HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "true",
    HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: "jobrolo-note-writeback",
    HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET: NOTE_SECRET,
    HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL: "chance@wavepa.com"
  };
  assert.throws(
    () => loadJobroloHcnNoteWritebackConfiguration(env, {
      disallowedClientIds: [{
        name: "HCN_JOBROLO_CLIENT_ID",
        value: "jobrolo-note-writeback"
      }]
    }),
    /different from HCN_JOBROLO_CLIENT_ID/
  );
  assert.throws(
    () => loadJobroloHcnNoteWritebackConfiguration(env, {
      disallowedSecrets: [{
        name: "HCN_JOBROLO_SHARED_SECRET",
        value: NOTE_SECRET
      }]
    }),
    /different from HCN_JOBROLO_SHARED_SECRET/
  );
});

test("additional note-only profiles are exact, distinct, and principal-bound", () => {
  const env = {
    HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "true",
    HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: "jobrolo-note-writeback",
    HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET: NOTE_SECRET,
    HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON: JSON.stringify({
      schema: "hcn.jobrolo.note-writeback-profiles.v1",
      profiles: [{
        clientId: "jobrolo-note-joel",
        sharedSecret: "jobrolo-note-joel-secret-that-is-unique-123456",
        principalEmail: "joel@wavepa.com"
      }]
    })
  };
  const registry = loadJobroloHcnNoteWritebackRegistry(env, {
    disallowedClientIds: [{
      name: "HCN_JOBROLO_CLIENT_ID",
      value: "jobrolo-general"
    }],
    disallowedSecrets: [{
      name: "HCN_JOBROLO_SHARED_SECRET",
      value: SECRET
    }]
  });
  assert.equal(registry.profiles.length, 2);
  assert.equal(registry.primary.principalEmail, "chance@wavepa.com");
  assert.equal(
    resolveJobroloHcnNoteWritebackProfile(
      registry,
      "jobrolo-note-joel"
    ).principalEmail,
    "joel@wavepa.com"
  );
  assert.equal(
    resolveJobroloHcnNoteWritebackProfile(registry, "missing"),
    null
  );

  const duplicatePrincipal = structuredClone(env);
  duplicatePrincipal.HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON =
    JSON.stringify({
      schema: "hcn.jobrolo.note-writeback-profiles.v1",
      profiles: [{
        clientId: "jobrolo-note-joel",
        sharedSecret: "jobrolo-note-joel-secret-that-is-unique-123456",
        principalEmail: "chance@wavepa.com"
      }]
    });
  assert.throws(
    () => loadJobroloHcnNoteWritebackRegistry(duplicatePrincipal),
    /distinct client ids, secrets, and principals/
  );
  assert.throws(
    () => loadJobroloHcnNoteWritebackRegistry({
      ...env,
      HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON: JSON.stringify({
        schema: "wrong.v1",
        profiles: []
      })
    }),
    /invalid schema/
  );
});

test("note-writeback authenticator accepts only its three action routes", () => {
  const configuration = loadJobroloHcnNoteWritebackConfiguration({
    HCN_JOBROLO_NOTE_WRITEBACK_ENABLED: "true",
    HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID: "jobrolo-note-writeback",
    HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET: NOTE_SECRET,
    HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL: "chance@wavepa.com"
  });
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    actor: {
      sessionRef: "session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    input: {}
  };
  const authenticator = createJobroloHcnAuthenticator({
    configuration,
    now: () => NOW,
    allowedRoutes: HCN_JOBROLO_NOTE_WRITEBACK_ROUTES
  });
  const noteHeaders = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: NOTE_PATH,
    timestamp: NOW,
    nonce: "nonce_cccccccccccccccccccccccccccccccc",
    body
  });
  assert.equal(
    authenticator.authenticate({
      method: "POST",
      pathname: NOTE_PATH,
      headers: noteHeaders,
      body
    }).clientId,
    configuration.clientId
  );

  const readHeaders = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: PATH,
    timestamp: NOW,
    nonce: "nonce_dddddddddddddddddddddddddddddddd",
    body
  });
  assert.throws(
    () => authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: readHeaders,
      body
    }),
    /route is not allowed/i
  );
});

test("claim-filing credential is default-off, distinct, and route-limited", () => {
  assert.deepEqual(
    loadJobroloHcnClaimFilingConfiguration({}),
    {
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    }
  );
  assert.throws(
    () => loadJobroloHcnClaimFilingConfiguration({
      HCN_JOBROLO_CLAIM_FILING_ENABLED: "false",
      HCN_JOBROLO_CLAIM_FILING_CLIENT_ID: "jobrolo-claim-filing"
    }),
    /must be true/i
  );
  const environment = {
    HCN_JOBROLO_CLAIM_FILING_ENABLED: "true",
    HCN_JOBROLO_CLAIM_FILING_CLIENT_ID: "jobrolo-claim-filing",
    HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET: CLAIM_SECRET,
    HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL: "chance@wavepa.com"
  };
  assert.throws(
    () => loadJobroloHcnClaimFilingConfiguration(environment, {
      disallowedClientIds: [{
        name: "HCN_JOBROLO_CLIENT_ID",
        value: "jobrolo-claim-filing"
      }]
    }),
    /different from HCN_JOBROLO_CLIENT_ID/
  );
  assert.throws(
    () => loadJobroloHcnClaimFilingConfiguration(environment, {
      disallowedSecrets: [{
        name: "HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET",
        value: CLAIM_SECRET
      }]
    }),
    /different from HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET/
  );

  const configuration = loadJobroloHcnClaimFilingConfiguration(environment);
  const body = {
    schema: "jobrolo.hcn.request.v1",
    requestId: "request_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    actor: {
      sessionRef: "session_ffffffffffffffffffffffffffffffff"
    },
    input: {}
  };
  const authenticator = createJobroloHcnAuthenticator({
    configuration,
    now: () => NOW,
    allowedRoutes: HCN_JOBROLO_CLAIM_FILING_ROUTES
  });
  const claimHeaders = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: CLAIM_PATH,
    timestamp: NOW,
    nonce: "nonce_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    body
  });
  assert.equal(
    authenticator.authenticate({
      method: "POST",
      pathname: CLAIM_PATH,
      headers: claimHeaders,
      body
    }).clientId,
    configuration.clientId
  );

  const genericHeaders = signJobroloHcnRequest({
    clientId: configuration.clientId,
    secret: configuration.secret,
    pathname: PATH,
    timestamp: NOW,
    nonce: "nonce_ffffffffffffffffffffffffffffffff",
    body
  });
  assert.throws(
    () => authenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: genericHeaders,
      body
    }),
    /route is not allowed/i
  );
});

test("claim-filing registry binds distinct PA callers to signed clients", () => {
  const environment = {
    HCN_JOBROLO_CLAIM_FILING_ENABLED: "true",
    HCN_JOBROLO_CLAIM_FILING_CLIENT_ID: "jobrolo-claim-filing",
    HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET: CLAIM_SECRET,
    HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON: JSON.stringify({
      schema: "hcn.jobrolo.claim-filing-profiles.v1",
      profiles: [{
        clientId: "jobrolo-claim-second-pa",
        sharedSecret: SECOND_CLAIM_SECRET,
        principalEmail: "second.adjuster@wavepa.com",
        publicAdjusterName: "Second Adjuster",
        licenseJurisdiction: "Texas",
        licenseNumber: "PA-20002",
        firmName: "Wave Public Adjusting",
        officeAddress: "3500 Oak Lawn Avenue, Dallas, Texas 75219",
        officePhone: "+19725550111",
        email: "second.adjuster@wavepa.com",
        queueCallbackPhone: "+18175550112"
      }]
    })
  };
  const registry = loadJobroloHcnClaimFilingRegistry(environment);
  assert.equal(registry.profiles.length, 2);
  const second = resolveJobroloHcnClaimFilingProfile(
    registry,
    "jobrolo-claim-second-pa"
  );
  assert.deepEqual(second.callerProfile, {
    publicAdjusterName: "Second Adjuster",
    licenseJurisdiction: "Texas",
    licenseNumber: "PA-20002",
    firmName: "Wave Public Adjusting",
    officeAddress: "3500 Oak Lawn Avenue, Dallas, Texas 75219",
    officePhone: "+19725550111",
    email: "second.adjuster@wavepa.com",
    queueCallbackPhone: "+18175550112"
  });
  assert.equal(
    resolveJobroloHcnClaimFilingProfile(registry, "not-configured"),
    null
  );
});

test("claim-filing registry rejects duplicate or caller-selected identity fields", () => {
  const baseProfile = {
    clientId: "jobrolo-claim-second-pa",
    sharedSecret: SECOND_CLAIM_SECRET,
    principalEmail: "second.adjuster@wavepa.com",
    publicAdjusterName: "Second Adjuster",
    licenseJurisdiction: "Texas",
    licenseNumber: "PA-20002",
    firmName: "Wave Public Adjusting",
    officeAddress: "3500 Oak Lawn Avenue, Dallas, Texas 75219",
    officePhone: "+19725550111",
    email: "second.adjuster@wavepa.com",
    queueCallbackPhone: "+18175550112"
  };
  const environment = (profile) => ({
    HCN_JOBROLO_CLAIM_FILING_ENABLED: "true",
    HCN_JOBROLO_CLAIM_FILING_CLIENT_ID: "jobrolo-claim-filing",
    HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET: CLAIM_SECRET,
    HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON: JSON.stringify({
      schema: "hcn.jobrolo.claim-filing-profiles.v1",
      profiles: [{ ...baseProfile, ...profile }]
    })
  });
  for (const duplicate of [
    { clientId: "jobrolo-claim-filing" },
    { sharedSecret: CLAIM_SECRET },
    { principalEmail: "chance@wavepa.com" },
    { licenseJurisdiction: "TX", licenseNumber: "3-351-885" },
    { email: "CPEARSON@WAVEPA.COM" },
    { queueCallbackPhone: "+18176867361" }
  ]) {
    assert.throws(
      () => loadJobroloHcnClaimFilingRegistry(environment(duplicate)),
      /distinct|reuses/i
    );
  }
  assert.doesNotThrow(
    () => loadJobroloHcnClaimFilingRegistry(environment({
      officeAddress:
        "3500 Oak Lawn Avenue, Suite 460C, Dallas, Texas 75219",
      officePhone: "+19725731730"
    }))
  );
  assert.throws(
    () => loadJobroloHcnClaimFilingRegistry(environment({
      callerSelectedPrincipal: "attacker@wavepa.com"
    })),
    /exact approved fields/i
  );
  assert.throws(
    () => loadJobroloHcnClaimFilingRegistry(environment({}), {
      disallowedClientIds: [{
        name: "another capability",
        value: "jobrolo-claim-second-pa"
      }]
    }),
    /reuses/i
  );
});

test("general HCN registry binds each signed client to one server principal", () => {
  const secondSecret = "jobrolo-general-second-pa-secret-unique-123456";
  const environment = {
    HCN_JOBROLO_ADAPTER_ENABLED: "true",
    HCN_JOBROLO_CLIENT_ID: "jobrolo-production",
    HCN_JOBROLO_SHARED_SECRET: SECRET,
    HCN_JOBROLO_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_ADDITIONAL_PROFILES_JSON: JSON.stringify({
      schema: "hcn.jobrolo.general-profiles.v1",
      profiles: [{
        clientId: "jobrolo-general-second-pa",
        sharedSecret: secondSecret,
        principalEmail: "second.adjuster@wavepa.com",
        effectMode: "read_only"
      }]
    })
  };
  const registry = loadJobroloHcnIntegrationRegistry(environment);
  assert.equal(registry.profiles.length, 2);
  assert.equal(registry.primary.effectMode, "approved_effects");
  assert.equal(
    resolveJobroloHcnIntegrationProfile(
      registry,
      "jobrolo-general-second-pa"
    )?.principalEmail,
    "second.adjuster@wavepa.com"
  );
  const readOnlyProfile = resolveJobroloHcnIntegrationProfile(
    registry,
    "jobrolo-general-second-pa"
  );
  assert.equal(readOnlyProfile?.effectMode, "read_only");
  assert.equal(
    jobroloHcnGeneralProfileAllowsRoute(
      readOnlyProfile,
      "/integrations/jobrolo/v1/file-review"
    ),
    true
  );
  assert.equal(
    jobroloHcnGeneralProfileAllowsRoute(
      readOnlyProfile,
      "/integrations/jobrolo/v1/carrier-emails/receipts/detail"
    ),
    true,
    "receipt reconciliation must survive an effect-mode demotion"
  );
  assert.equal(
    jobroloHcnGeneralProfileAllowsRoute(
      readOnlyProfile,
      "/integrations/jobrolo/v1/carrier-emails/sends/prepare"
    ),
    false,
    "effect-mode demotion must still block a new send plan"
  );
  for (const route of JOBROLO_HCN_GENERAL_EFFECT_ROUTES) {
    assert.equal(
      jobroloHcnGeneralProfileAllowsRoute(readOnlyProfile, route),
      false,
      `read-only PA must not access ${route}`
    );
    assert.equal(
      jobroloHcnGeneralProfileAllowsRoute(registry.primary, route),
      true,
      `legacy primary must preserve approved effects for ${route}`
    );
  }
  const crossProfileBody = {
    schema: "jobrolo.hcn.request.v1",
    requestId: `request_${"7".repeat(32)}`,
    actor: { sessionRef: `session_${"8".repeat(32)}` },
    input: {}
  };
  const primaryHeaders = signJobroloHcnRequest({
    clientId: registry.primary.clientId,
    secret: registry.primary.secret,
    pathname: PATH,
    timestamp: NOW,
    nonce: `nonce_${"9".repeat(32)}`,
    body: crossProfileBody
  });
  const secondAuthenticator = createJobroloHcnAuthenticator({
    configuration: readOnlyProfile,
    now: () => NOW,
    nonceGuard: createJobroloHcnNonceGuard({ now: () => NOW })
  });
  assert.throws(
    () => secondAuthenticator.authenticate({
      method: "POST",
      pathname: PATH,
      headers: primaryHeaders,
      body: crossProfileBody
    }),
    /authentication failed/i,
    "one PA's signed credential cannot select another PA's principal"
  );
  assert.equal(resolveJobroloHcnIntegrationProfile(registry, "unknown"), null);
});

test("general HCN registry rejects ambiguity and cross-capability credentials", () => {
  const secondSecret = "jobrolo-general-second-pa-secret-unique-123456";
  const environment = (profile = {}) => ({
    HCN_JOBROLO_ADAPTER_ENABLED: "true",
    HCN_JOBROLO_CLIENT_ID: "jobrolo-production",
    HCN_JOBROLO_SHARED_SECRET: SECRET,
    HCN_JOBROLO_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_ADDITIONAL_PROFILES_JSON: JSON.stringify({
      schema: "hcn.jobrolo.general-profiles.v1",
      profiles: [{
        clientId: "jobrolo-general-second-pa",
        sharedSecret: secondSecret,
        principalEmail: "second.adjuster@wavepa.com",
        effectMode: "read_only",
        ...profile
      }]
    })
  });
  for (const duplicate of [
    { clientId: "jobrolo-production" },
    { sharedSecret: SECRET },
    { principalEmail: "chance@wavepa.com" }
  ]) {
    assert.throws(
      () => loadJobroloHcnIntegrationRegistry(environment(duplicate)),
      /distinct|reuses/i
    );
  }
  assert.throws(
    () => loadJobroloHcnIntegrationRegistry(environment(), {
      disallowedSecrets: [secondSecret]
    }),
    /reuses/i
  );
  assert.throws(
    () => loadJobroloHcnIntegrationRegistry(environment({
      callerSelectedOwnerId: "attacker"
    })),
    /exact approved fields/i
  );
  assert.throws(
    () => loadJobroloHcnIntegrationRegistry(environment({
      effectMode: "inherit_global"
    })),
    /invalid/i
  );
  assert.throws(
    () => loadJobroloHcnIntegrationRegistry(environment({
      effectMode: undefined
    })),
    /invalid|exact approved fields/i
  );
  const approvedRegistry = loadJobroloHcnIntegrationRegistry(
    environment({ effectMode: "approved_effects" })
  );
  const approvedSecond = resolveJobroloHcnIntegrationProfile(
    approvedRegistry,
    "jobrolo-general-second-pa"
  );
  assert.equal(approvedSecond?.effectMode, "approved_effects");
  for (const route of JOBROLO_HCN_GENERAL_EFFECT_ROUTES) {
    assert.equal(
      jobroloHcnGeneralProfileAllowsRoute(approvedSecond, route),
      true,
      `switching only PA-B to approved_effects must enable ${route}`
    );
  }
});
