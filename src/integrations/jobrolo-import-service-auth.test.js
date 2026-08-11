import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  createJobroloImportAuthenticator,
  createJobroloImportDocumentResponseHeaders,
  createJobroloImportDurableNonceGuard,
  createJobroloImportMemoryNonceGuard,
  createJobroloImportTransportResponse,
  JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
  JOBROLO_IMPORT_CATALOG_ROUTE,
  JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
  JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
  JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS,
  JOBROLO_IMPORT_REQUEST_HEADERS,
  JOBROLO_IMPORT_RESPONSE_HEADERS,
  JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
  JOBROLO_IMPORT_SNAPSHOT_ROUTE,
  JOBROLO_IMPORT_TRANSPORT_LIMITS,
  JOBROLO_IMPORT_TRANSPORT_RESPONSE_SCHEMA,
  loadJobroloImportTransportConfiguration,
  projectJobroloImportError,
  signJobroloImportRequest,
  verifyJobroloImportTransportResponse
} from "./jobrolo-import-service-auth.js";

const NOW = Date.parse("2026-08-08T15:02:00.000Z");
const TIMESTAMP = "2026-08-08T15:02:00.000Z";
const CLIENT_ID = "jobrolo-import-fixture";
const SECRET = "jobrolo-import-fixture-secret-0123456789abcdef";
const CONNECTION_REF = "connection_cccccccccccccccccccccccccccccccc";
const REQUEST_ID = "request_0123456789abcdef0123456789abcdef";
const NONCE = "nonce_0123456789abcdef0123456789abcdef";
const SOURCE_FILE_REF = "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_RECORD_REF = "ref_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MANIFEST_DIGEST = "d".repeat(64);

test("document transport reserves execution-lease time for scan and storage", () => {
  assert.equal(
    JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumDocumentRouteDurationMs,
    70_000
  );
});

function configuration(overrides = {}) {
  return loadJobroloImportTransportConfiguration({
    HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "true",
    HCN_JOBROLO_IMPORT_CLIENT_ID: CLIENT_ID,
    HCN_JOBROLO_IMPORT_SHARED_SECRET: SECRET,
    HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_IMPORT_CONNECTION_REF: CONNECTION_REF,
    ...overrides
  });
}

function catalogBody() {
  return {
    schema: JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA,
    requestId: REQUEST_ID
  };
}

function signedFixture(overrides = {}) {
  const body = overrides.body || catalogBody();
  const pathname = overrides.pathname || JOBROLO_IMPORT_CATALOG_ROUTE;
  const signed = signJobroloImportRequest({
    clientId: CLIENT_ID,
    secret: SECRET,
    pathname,
    timestamp: overrides.timestamp || TIMESTAMP,
    nonce: overrides.nonce || NONCE,
    body,
    ...(overrides.bodyText === undefined
      ? {}
      : { bodyText: overrides.bodyText })
  });
  return { body, pathname, ...signed };
}

function authenticator(nonceGuard = createJobroloImportMemoryNonceGuard({
  now: () => NOW
})) {
  return createJobroloImportAuthenticator({
    configuration: configuration(),
    now: () => NOW,
    nonceGuard
  });
}

test("import configuration is separate, exact, and rejects reused credentials", () => {
  assert.deepEqual(
    loadJobroloImportTransportConfiguration({}),
    {
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: "",
      connectionRef: ""
    }
  );
  assert.equal(configuration().ready, true);
  assert.deepEqual(configuration({
    HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "false"
  }), {
    enabled: false,
    ready: false,
    clientId: "",
    secret: "",
    principalEmail: "",
    connectionRef: ""
  });
  assert.throws(() => loadJobroloImportTransportConfiguration({
    HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "true",
    HCN_JOBROLO_IMPORT_CLIENT_ID: CLIENT_ID
  }), /configuration is invalid/);
  assert.throws(() => configuration({
    HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL: "Chance@wavepa.com"
  }), /configuration is invalid/);
  assert.throws(() => loadJobroloImportTransportConfiguration({
    HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "true",
    HCN_JOBROLO_IMPORT_CLIENT_ID: CLIENT_ID,
    HCN_JOBROLO_IMPORT_SHARED_SECRET: SECRET,
    HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_IMPORT_CONNECTION_REF: CONNECTION_REF
  }, {
    disallowedSecrets: [{ name: "old HCN Jobrolo secret", value: SECRET }]
  }), /configuration is invalid/);
  assert.throws(() => loadJobroloImportTransportConfiguration({
    HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED: "true",
    HCN_JOBROLO_IMPORT_CLIENT_ID: CLIENT_ID,
    HCN_JOBROLO_IMPORT_SHARED_SECRET: SECRET,
    HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL: "chance@wavepa.com",
    HCN_JOBROLO_IMPORT_CONNECTION_REF: CONNECTION_REF
  }, {
    disallowedClientIds: [CLIENT_ID]
  }), /configuration is invalid/);
});

test("request signing vector freezes exact header names, bytes, and domain", () => {
  const signed = signedFixture();
  assert.equal(
    signed.bodyText,
    '{"requestId":"request_0123456789abcdef0123456789abcdef","schema":"jobrolo.jobnimbus-import.catalog-request.v1"}'
  );
  assert.deepEqual(signed.headers, {
    authorization: "Jobrolo-Import-HMAC jobrolo-import-fixture",
    "content-type": "application/json",
    "x-jobrolo-import-timestamp": TIMESTAMP,
    "x-jobrolo-import-nonce": NONCE,
    "x-jobrolo-import-content-sha256":
      "7316733c31099b005739513d550a24580cb76ec846436722540f92365b987429",
    "x-jobrolo-import-signature":
      "17386b9a851fbda53de5ea53125b23dd79c17e9debaa0fb5f4785d3486fc815d"
  });
});

test("authenticator binds exact bytes, route, method, query, time, and strict schema", async () => {
  const signed = signedFixture();
  const verified = await authenticator().authenticate({
    method: "POST",
    pathname: signed.pathname,
    search: "",
    headers: signed.headers,
    body: signed.body,
    rawBody: signed.bodyText
  });
  assert.equal(verified.requestId, REQUEST_ID);
  assert.equal(verified.requestNonce, NONCE);
  assert.equal(verified.connectionRef, CONNECTION_REF);
  assert.equal(verified.sourceFileRef, null);

  for (const change of [
    { method: "GET" },
    { pathname: JOBROLO_IMPORT_SNAPSHOT_ROUTE },
    { search: "?connectionRef=attacker" },
    { rawBody: `${signed.bodyText}\n` },
    { headers: { ...signed.headers, authorization: `Jobrolo-HMAC ${CLIENT_ID}` } },
    { headers: { ...signed.headers, [JOBROLO_IMPORT_REQUEST_HEADERS.nonce]: `${NONCE}, ${NONCE}` } }
  ]) {
    await assert.rejects(
      authenticator().authenticate({
        method: "POST",
        pathname: signed.pathname,
        search: "",
        headers: signed.headers,
        body: signed.body,
        rawBody: signed.bodyText,
        ...change
      }),
      (error) => {
        assert.equal(error.code, "invalid_jobrolo_import_authentication");
        return true;
      }
    );
  }

  const unsupported = signedFixture({
    body: { ...catalogBody(), connectionRef: CONNECTION_REF }
  });
  await assert.rejects(authenticator().authenticate({
    method: "POST",
    pathname: unsupported.pathname,
    headers: unsupported.headers,
    body: unsupported.body,
    rawBody: unsupported.bodyText
  }), (error) => error.code === "invalid_jobrolo_import_request");
});

test("snapshot request accepts only an opaque source ref and no caller scope", async () => {
  const body = {
    schema: JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA,
    requestId: REQUEST_ID,
    sourceFileRef: SOURCE_FILE_REF
  };
  const signed = signedFixture({
    pathname: JOBROLO_IMPORT_SNAPSHOT_ROUTE,
    body
  });
  const verified = await authenticator().authenticate({
    method: "POST",
    pathname: signed.pathname,
    headers: signed.headers,
    body,
    rawBody: signed.bodyText
  });
  assert.equal(verified.sourceFileRef, SOURCE_FILE_REF);
  assert.equal(Object.hasOwn(body, "connectionRef"), false);
  assert.equal(Object.hasOwn(body, "principal"), false);
});

test("document request binds exact file, record, and manifest proof", async () => {
  const body = {
    schema: JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
    requestId: REQUEST_ID,
    sourceFileRef: SOURCE_FILE_REF,
    sourceRecordRef: SOURCE_RECORD_REF,
    manifestDigest: MANIFEST_DIGEST
  };
  const signed = signedFixture({
    pathname: JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    body
  });
  const verified = await authenticator().authenticate({
    method: "POST",
    pathname: signed.pathname,
    headers: signed.headers,
    body,
    rawBody: signed.bodyText
  });
  assert.equal(verified.sourceFileRef, SOURCE_FILE_REF);
  assert.equal(verified.sourceRecordRef, SOURCE_RECORD_REF);
  assert.equal(verified.manifestDigest, MANIFEST_DIGEST);
  for (const malformed of [
    { ...body, sourceRecordRef: "provider-id" },
    { ...body, manifestDigest: "0".repeat(63) },
    { ...body, connectionRef: CONNECTION_REF }
  ]) {
    const invalid = signedFixture({
      pathname: JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
      body: malformed,
      nonce: `nonce_${"e".repeat(32)}`
    });
    await assert.rejects(authenticator().authenticate({
      method: "POST",
      pathname: invalid.pathname,
      headers: invalid.headers,
      body: malformed,
      rawBody: invalid.bodyText
    }), (error) => error.code === "invalid_jobrolo_import_request");
  }
});

test("document response signature binds exact request, proof, bytes, and length", () => {
  const body = {
    schema: JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA,
    requestId: REQUEST_ID,
    sourceFileRef: SOURCE_FILE_REF,
    sourceRecordRef: SOURCE_RECORD_REF,
    manifestDigest: MANIFEST_DIGEST
  };
  const signed = signedFixture({
    pathname: JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
    body
  });
  const headers = createJobroloImportDocumentResponseHeaders({
    configuration: configuration(),
    verifiedRequest: {
      requestId: REQUEST_ID,
      requestNonce: NONCE,
      requestTimestamp: TIMESTAMP,
      requestBodyHash:
        signed.headers[JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256],
      sourceFileRef: SOURCE_FILE_REF,
      sourceRecordRef: SOURCE_RECORD_REF,
      manifestDigest: MANIFEST_DIGEST
    },
    responseTimestamp: "2026-08-08T15:02:01.000Z",
    contentLength: 19,
    contentSha256: "a".repeat(64)
  });
  assert.deepEqual(headers, {
    "content-type": "application/octet-stream",
    "content-length": "19",
    "content-disposition": "attachment; filename=\"jobnimbus-document\"",
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestId]: REQUEST_ID,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestNonce]: NONCE,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.responseTimestamp]:
      "2026-08-08T15:02:01.000Z",
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.contentSha256]: "a".repeat(64),
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.manifestDigest]:
      MANIFEST_DIGEST,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.signature]:
      "fe5ababbba271c020d7837e54b12dbac40b013f8a8f8b577394790110f6342a5"
  });
  assert.throws(() => createJobroloImportDocumentResponseHeaders({
    configuration: configuration(),
    verifiedRequest: {
      requestId: REQUEST_ID,
      requestNonce: NONCE,
      requestTimestamp: TIMESTAMP,
      requestBodyHash:
        signed.headers[JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256],
      sourceFileRef: SOURCE_FILE_REF,
      sourceRecordRef: SOURCE_RECORD_REF,
      manifestDigest: MANIFEST_DIGEST
    },
    responseTimestamp: "2026-08-08T15:02:01.000Z",
    contentLength: 25 * 1024 * 1024 + 1,
    contentSha256: "a".repeat(64)
  }), /transport is unavailable/);
});

test("durable replay guard survives new instances and stores only a nonce hash", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-import-nonces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const authenticateWith = (guard) => createJobroloImportAuthenticator({
    configuration: configuration(),
    now: () => NOW,
    nonceGuard: guard
  }).authenticate({
    method: "POST",
    pathname: signed.pathname,
    headers: signed.headers,
    body: signed.body,
    rawBody: signed.bodyText
  });
  await authenticateWith(createJobroloImportDurableNonceGuard({
    directory: root,
    now: () => NOW
  }));
  await assert.rejects(
    authenticateWith(createJobroloImportDurableNonceGuard({
      directory: root,
      now: () => NOW
    })),
    (error) => error.code === "invalid_jobrolo_import_authentication"
  );
  const entries = (await readdir(root)).filter((entry) =>
    /^[a-f0-9]{64}$/.test(entry)
  );
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(entries[0], /0123456789abcdef/);
  assert.doesNotMatch(await readFile(path.join(root, entries[0]), "utf8"), /nonce_/);
});

test("durable replay receipt publication is atomic under concurrency", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-import-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signed = signedFixture();
  const attempt = () => createJobroloImportAuthenticator({
    configuration: configuration(),
    now: () => NOW,
    nonceGuard: createJobroloImportDurableNonceGuard({
      directory: root,
      now: () => NOW
    })
  }).authenticate({
    method: "POST",
    pathname: signed.pathname,
    headers: signed.headers,
    body: signed.body,
    rawBody: signed.bodyText
  });
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["fulfilled", "rejected"]
  );
  assert.equal(results.find((result) => result.status === "rejected")
    .reason.code, "invalid_jobrolo_import_authentication");
  const receipts = (await readdir(root)).filter((entry) =>
    /^[a-f0-9]{64}$/.test(entry)
  );
  assert.equal(receipts.length, 1);
  assert.match(await readFile(path.join(root, receipts[0]), "utf8"), /^\d{13}$/);
});

test("pruning never unlinks an empty or partial replay receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hcn-import-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const partial = path.join(root, "a".repeat(64));
  await writeFile(partial, "", { mode: 0o600 });
  const guard = createJobroloImportDurableNonceGuard({
    directory: root,
    now: () => NOW
  });
  await assert.rejects(
    guard.consume(CLIENT_ID, NONCE, NOW + 60_000),
    (error) => error.code === "jobrolo_import_unavailable"
  );
  assert.equal(await readFile(partial, "utf8"), "");
});

test("signed response binds request nonce/body, payload digest, and response material", () => {
  const signed = signedFixture();
  const verifiedRequest = {
    requestId: REQUEST_ID,
    requestNonce: NONCE,
    requestTimestamp: TIMESTAMP,
    requestBodyHash: signed.headers[JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256]
  };
  const payload = {
    schema: "jobrolo.jobnimbus-import.catalog.v1",
    source: {
      system: "jobnimbus",
      connectionRef: CONNECTION_REF,
      scope: "assigned",
      complete: true
    },
    asOf: "2026-08-08T15:00:00.000Z",
    checkedAt: "2026-08-08T15:01:00.000Z",
    validUntil: "2026-08-08T15:11:00.000Z",
    returnedItems: 1,
    items: [{
      sourceFileRef: SOURCE_FILE_REF,
      jobNumber: "JN-2739",
      displayName: "Fixture Homeowner",
      statusCode: "ready_for_review",
      stageCode: "carrier_review",
      updatedAt: "2026-08-08T14:58:00.000Z"
    }]
  };
  const response = createJobroloImportTransportResponse({
    configuration: configuration(),
    verifiedRequest,
    pathname: JOBROLO_IMPORT_CATALOG_ROUTE,
    kind: "catalog",
    payload,
    now: () => NOW
  });
  assert.equal(response.body.schema, JOBROLO_IMPORT_TRANSPORT_RESPONSE_SCHEMA);
  assert.equal(response.body.requestNonce, NONCE);
  assert.equal(
    response.body.payloadDigest,
    "206a18ee8c97187b89204c5fbeb537a13ac90517c8d0ab73168b271673ead22e"
  );
  assert.equal(
    response.body.responseDigest,
    "c2561e76c9857d1ed704a1fe8757d6f4fb69703f51c5e81d7babc4dd2a6e30e9"
  );
  assert.equal(
    response.headers[JOBROLO_IMPORT_RESPONSE_HEADERS.signature],
    "ae7c1270de2ad1d31604c83679587a3c2efeb3610c0a2c224f08e6f3a08b828b"
  );
  assert.equal(
    response.headers[JOBROLO_IMPORT_RESPONSE_HEADERS.digest],
    response.body.responseDigest
  );
  assert.equal(Buffer.byteLength(response.bodyText, "utf8") < 544 * 1024, true);
  assert.equal(verifyJobroloImportTransportResponse({
    secret: SECRET,
    pathname: JOBROLO_IMPORT_CATALOG_ROUTE,
    verifiedRequest,
    body: response.body,
    headers: response.headers
  }), true);

  assert.throws(() => verifyJobroloImportTransportResponse({
    secret: SECRET,
    pathname: JOBROLO_IMPORT_CATALOG_ROUTE,
    verifiedRequest,
    body: {
      ...response.body,
      payload: { ...response.body.payload, returnedItems: 0 }
    },
    headers: response.headers
  }), /authentication failed/);
  assert.throws(() => verifyJobroloImportTransportResponse({
    secret: SECRET,
    pathname: JOBROLO_IMPORT_CATALOG_ROUTE,
    verifiedRequest: { ...verifiedRequest, requestNonce: `nonce_${"f".repeat(32)}` },
    body: response.body,
    headers: response.headers
  }), /authentication failed/);
});

test("errors project to fixed local codes without source messages", () => {
  for (const [statusCode, expectedStatus, code] of [
    [400, 400, "invalid_jobrolo_import_request"],
    [401, 401, "invalid_jobrolo_import_authentication"],
    [403, 401, "invalid_jobrolo_import_authentication"],
    [404, 404, "jobrolo_import_source_not_found"],
    [409, 409, "jobrolo_import_source_changed"],
    [502, 502, "jobrolo_import_unavailable"],
    [500, 503, "jobrolo_import_unavailable"]
  ]) {
    const error = new Error("provider URL https://secret.invalid raw-id");
    error.statusCode = statusCode;
    const projected = projectJobroloImportError(error);
    assert.equal(projected.status, expectedStatus);
    assert.equal(projected.body.error.code, code);
    assert.doesNotMatch(JSON.stringify(projected), /secret|raw-id|provider URL/);
  }
});

test("canonical JSON rejects unsupported values and excessive depth", () => {
  assert.equal(canonicalJson({ z: [2, { b: 1, a: true }], a: null }),
    '{"a":null,"z":[2,{"a":true,"b":1}]}');
  assert.throws(() => canonicalJson({ missing: undefined }));
  let deep = null;
  for (let index = 0; index < 26; index += 1) deep = [deep];
  assert.throws(() => canonicalJson(deep));
});
