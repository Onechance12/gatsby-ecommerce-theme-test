import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import path from "node:path";

import {
  JOBROLO_JOBNIMBUS_IMPORT_SNAPSHOT_SCHEMA,
  JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN
} from "./jobrolo-import-snapshot.js";

export const JOBROLO_IMPORT_CATALOG_ROUTE =
  "/integrations/jobrolo-import/v1/catalog";
export const JOBROLO_IMPORT_SNAPSHOT_ROUTE =
  "/integrations/jobrolo-import/v1/snapshot";
export const JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE =
  "/integrations/jobrolo-import/v1/document-content";
export const JOBROLO_IMPORT_ROUTES = Object.freeze([
  JOBROLO_IMPORT_CATALOG_ROUTE,
  JOBROLO_IMPORT_SNAPSHOT_ROUTE,
  JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE
]);

export const JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA =
  "jobrolo.jobnimbus-import.catalog-request.v1";
export const JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA =
  "jobrolo.jobnimbus-import.snapshot-request.v1";
export const JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA =
  "jobrolo.jobnimbus-import.document-content-request.v1";
export const JOBROLO_IMPORT_DOCUMENT_MANIFEST_SCHEMA =
  "jobrolo.jobnimbus-import.document-manifest.v1";
export const JOBROLO_IMPORT_TRANSPORT_RESPONSE_SCHEMA =
  "jobrolo.jobnimbus-import.transport-response.v1";
export const JOBROLO_IMPORT_TRANSPORT_ERROR_SCHEMA =
  "jobrolo.jobnimbus-import.transport-error.v1";

export const JOBROLO_IMPORT_TRANSPORT_LIMITS = Object.freeze({
  maximumRequestUtf8Bytes: 8 * 1024,
  maximumCatalogCanonicalUtf8Bytes: 256 * 1024,
  maximumSnapshotCanonicalUtf8Bytes: 512 * 1024,
  maximumResponseCanonicalUtf8Bytes: 544 * 1024,
  maximumDocumentContentBytes: 25 * 1024 * 1024,
  maximumDocumentRouteDurationMs: 70_000,
  maximumClockSkewMs: 5 * 60_000,
  maximumNonceEntries: 8_192,
  maximumCanonicalDepth: 24,
  maximumCanonicalNodes: 20_000
});

export const JOBROLO_IMPORT_REQUEST_HEADERS = Object.freeze({
  timestamp: "x-jobrolo-import-timestamp",
  nonce: "x-jobrolo-import-nonce",
  contentSha256: "x-jobrolo-import-content-sha256",
  signature: "x-jobrolo-import-signature"
});
export const JOBROLO_IMPORT_RESPONSE_HEADERS = Object.freeze({
  digest: "x-jobrolo-import-response-digest",
  signature: "x-jobrolo-import-response-signature"
});
export const JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS = Object.freeze({
  requestId: "x-jobrolo-request-id",
  requestNonce: "x-jobrolo-request-nonce",
  responseTimestamp: "x-jobrolo-response-timestamp",
  contentSha256: "x-jobrolo-content-sha256",
  manifestDigest: "x-jobrolo-manifest-digest",
  signature: "x-jobrolo-response-signature"
});

// Server-facing aliases preserve the HCN isolation rule that deployable
// server.js never introduces a bare legacy JOBROLO_* environment namespace.
export const HCN_JOBROLO_IMPORT_CATALOG_ROUTE =
  JOBROLO_IMPORT_CATALOG_ROUTE;
export const HCN_JOBROLO_IMPORT_SNAPSHOT_ROUTE =
  JOBROLO_IMPORT_SNAPSHOT_ROUTE;
export const HCN_JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE =
  JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE;
export const HCN_JOBROLO_IMPORT_ROUTES = JOBROLO_IMPORT_ROUTES;
export const HCN_JOBROLO_IMPORT_TRANSPORT_LIMITS =
  JOBROLO_IMPORT_TRANSPORT_LIMITS;

const REQUEST_SIGNATURE_DOMAIN =
  "jobrolo.jobnimbus-import.request-signature.v1";
const RESPONSE_SIGNATURE_DOMAIN =
  "jobrolo.jobnimbus-import.response-signature.v1";
const DOCUMENT_RESPONSE_SIGNATURE_DOMAIN =
  "jobrolo.jobnimbus-import.document-content-response-signature.v1";
const NONCE_STORAGE_DOMAIN =
  "hcn.jobrolo.jobnimbus-import.nonce.v1";
const ROUTES = new Set(JOBROLO_IMPORT_ROUTES);
const CLIENT_ID = /^[A-Za-z0-9._-]{3,64}$/;
const REQUEST_ID = /^request_[a-f0-9]{32}$/;
const NONCE = /^nonce_[a-f0-9]{32}$/;
const SOURCE_FILE_REF = /^subject_[a-f0-9]{32}$/;
const SOURCE_RECORD_REF = /^ref_[a-f0-9]{32}$/;
const CONNECTION_REF = /^connection_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET = /^[\x21-\x7e]{32,512}$/;

export function isJobroloImportRoute(pathname) {
  return ROUTES.has(String(pathname || ""));
}

export function loadJobroloImportTransportConfiguration(
  environment = {},
  { disallowedSecrets = [], disallowedClientIds = [] } = {}
) {
  const enabledValue = String(
    environment.HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED || ""
  ).trim();
  if (enabledValue === "" || enabledValue === "false") {
    // The kill switch stays operational even when Render retains staged
    // values. Dormant credentials confer no route authority and are not
    // parsed until an exact true enables the transport.
    return unavailableConfiguration();
  }
  if (enabledValue !== "true") configurationFailure();
  const enabled = true;
  const clientId = String(
    environment.HCN_JOBROLO_IMPORT_CLIENT_ID || ""
  ).trim();
  const secret = String(
    environment.HCN_JOBROLO_IMPORT_SHARED_SECRET || ""
  );
  const principalEmail = String(
    environment.HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL || ""
  ).trim();
  const connectionRef = String(
    environment.HCN_JOBROLO_IMPORT_CONNECTION_REF || ""
  ).trim();
  if (!CLIENT_ID.test(clientId)) configurationFailure();
  if (!SECRET.test(secret)) configurationFailure();
  if (
    !JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN.test(principalEmail)
    || principalEmail !== principalEmail.toLowerCase()
  ) {
    configurationFailure();
  }
  if (!CONNECTION_REF.test(connectionRef)) configurationFailure();

  for (const candidate of disallowedSecrets) {
    const value = String(candidate?.value || "");
    if (value && secureTextEqual(secret, value)) configurationFailure();
  }
  for (const candidate of disallowedClientIds) {
    const value = String(candidate || "");
    if (value && secureTextEqual(clientId, value)) configurationFailure();
  }

  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail,
    connectionRef
  });
}

export function createJobroloImportMemoryNonceGuard({
  now = Date.now,
  maximumEntries = JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumNonceEntries
} = {}) {
  assertNonceGuardOptions(now, maximumEntries);
  const used = new Map();
  return Object.freeze({
    async consume(clientId, nonce, validUntilMs) {
      const current = now();
      for (const [key, expiry] of used) {
        if (expiry <= current) used.delete(key);
      }
      const key = nonceKey(clientId, nonce);
      if (used.has(key)) authenticationFailure();
      if (used.size >= maximumEntries) serviceFailure();
      used.set(key, validNonceExpiry(validUntilMs, current));
    }
  });
}

/**
 * Durable, process-independent replay protection for a single shared
 * operations volume. Atomic exclusive file creation makes concurrent workers
 * agree on the first consumer without persisting the client id or raw nonce.
 */
export function createJobroloImportDurableNonceGuard({
  directory,
  now = Date.now,
  maximumEntries = JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumNonceEntries
} = {}) {
  assertNonceGuardOptions(now, maximumEntries);
  const root = path.resolve(String(directory || ""));
  if (!path.isAbsolute(root) || !String(directory || "").trim()) {
    throw new TypeError("A durable nonce directory is required.");
  }

  return Object.freeze({
    async consume(clientId, nonce, validUntilMs) {
      const current = now();
      const expiry = validNonceExpiry(validUntilMs, current);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const staging = path.join(root, ".staging");
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await pruneExpiredNonces(root, current);
      const entries = await readdir(root, { withFileTypes: true });
      const receipts = entries.filter((entry) => entry.isFile());
      if (receipts.length >= maximumEntries) serviceFailure();
      const key = nonceKey(clientId, nonce);
      const file = path.join(root, key);
      const temporary = path.join(
        staging,
        `${key}.${randomBytes(16).toString("hex")}`
      );
      let handle;
      try {
        // Publish only a complete immutable receipt. A direct open/write of
        // the final path creates an empty-file window in which a concurrent
        // pruner could otherwise mistake an in-progress receipt for expiry.
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(String(expiry), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await link(temporary, file);
      } catch (error) {
        if (error?.code === "EEXIST") authenticationFailure();
        serviceFailure();
      } finally {
        await handle?.close().catch(() => {});
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
  });
}

export function createJobroloImportAuthenticator({
  configuration,
  now = Date.now,
  maximumSkewMs = JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumClockSkewMs,
  nonceGuard = createJobroloImportMemoryNonceGuard({ now })
} = {}) {
  if (!configuration?.ready || !configuration?.enabled) {
    return Object.freeze({
      async authenticate() {
        serviceFailure();
      }
    });
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(maximumSkewMs)
    || maximumSkewMs < 1_000
    || maximumSkewMs > 60 * 60_000
  ) {
    throw new TypeError("maximumSkewMs is invalid");
  }
  if (typeof nonceGuard?.consume !== "function") {
    throw new TypeError("nonceGuard is invalid");
  }

  return Object.freeze({
    async authenticate({ method, pathname, search = "", headers, body, rawBody } = {}) {
      const normalizedMethod = String(method || "").toUpperCase();
      const normalizedPath = String(pathname || "");
      if (
        normalizedMethod !== "POST"
        || !isJobroloImportRoute(normalizedPath)
        || String(search || "") !== ""
      ) {
        authenticationFailure();
      }
      if (
        exactHeader(headers, "authorization")
        !== `Jobrolo-Import-HMAC ${configuration.clientId}`
      ) {
        authenticationFailure();
      }

      const timestamp = exactHeader(
        headers,
        JOBROLO_IMPORT_REQUEST_HEADERS.timestamp
      );
      const timestampMs = parseIsoUtc(timestamp);
      if (
        timestampMs === null
        || Math.abs(now() - timestampMs) > maximumSkewMs
      ) {
        authenticationFailure();
      }
      const nonce = exactHeader(
        headers,
        JOBROLO_IMPORT_REQUEST_HEADERS.nonce
      );
      const claimedBodyHash = exactHeader(
        headers,
        JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256
      );
      const signature = exactHeader(
        headers,
        JOBROLO_IMPORT_REQUEST_HEADERS.signature
      );
      if (
        !NONCE.test(nonce)
        || !SHA256.test(claimedBodyHash)
        || !SHA256.test(signature)
      ) {
        authenticationFailure();
      }
      const rawBytes = normalizeRawBody(rawBody);
      if (
        rawBytes.byteLength === 0
        || rawBytes.byteLength
          > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumRequestUtf8Bytes
      ) {
        requestFailure();
      }
      const bodyHash = sha256(rawBytes);
      if (!secureTextEqual(claimedBodyHash, bodyHash)) {
        authenticationFailure();
      }
      const expectedSignature = hmac(
        configuration.secret,
        jobroloImportRequestSigningMaterial({
          method: normalizedMethod,
          pathname: normalizedPath,
          timestamp,
          nonce,
          bodyHash
        })
      );
      if (!secureTextEqual(signature, expectedSignature)) {
        authenticationFailure();
      }

      const request = validateImportRequest(normalizedPath, body);
      await nonceGuard.consume(
        configuration.clientId,
        nonce,
        timestampMs + maximumSkewMs + 1
      );
      return Object.freeze({
        clientId: configuration.clientId,
        principalEmail: configuration.principalEmail,
        connectionRef: configuration.connectionRef,
        requestId: request.requestId,
        requestNonce: nonce,
        requestTimestamp: timestamp,
        requestBodyHash: bodyHash,
        sourceFileRef: request.sourceFileRef || null,
        sourceRecordRef: request.sourceRecordRef || null,
        manifestDigest: request.manifestDigest || null
      });
    }
  });
}

export function signJobroloImportRequest({
  clientId,
  secret,
  pathname,
  timestamp,
  nonce,
  body,
  bodyText = canonicalJson(body)
} = {}) {
  const rawBody = normalizeRawBody(bodyText);
  const bodyHash = sha256(rawBody);
  const timestampText = String(timestamp || "");
  const signature = hmac(secret, jobroloImportRequestSigningMaterial({
    method: "POST",
    pathname,
    timestamp: timestampText,
    nonce,
    bodyHash
  }));
  return Object.freeze({
    bodyText: rawBody.toString("utf8"),
    headers: Object.freeze({
      authorization: `Jobrolo-Import-HMAC ${clientId}`,
      "content-type": "application/json",
      [JOBROLO_IMPORT_REQUEST_HEADERS.timestamp]: timestampText,
      [JOBROLO_IMPORT_REQUEST_HEADERS.nonce]: String(nonce || ""),
      [JOBROLO_IMPORT_REQUEST_HEADERS.contentSha256]: bodyHash,
      [JOBROLO_IMPORT_REQUEST_HEADERS.signature]: signature
    })
  });
}

export function createJobroloImportTransportResponse({
  configuration,
  verifiedRequest,
  pathname,
  kind,
  payload,
  now = Date.now
} = {}) {
  if (!configuration?.ready || !configuration?.secret) serviceFailure();
  if (!isJobroloImportRoute(pathname)) serviceFailure();
  if (!verifiedRequest || !REQUEST_ID.test(verifiedRequest.requestId)) {
    serviceFailure();
  }
  if (!NONCE.test(verifiedRequest.requestNonce)) serviceFailure();
  if (parseIsoUtc(verifiedRequest.requestTimestamp) === null) serviceFailure();
  if (!SHA256.test(verifiedRequest.requestBodyHash)) serviceFailure();
  const expectedPayloadSchema = kind === "catalog"
    ? "jobrolo.jobnimbus-import.catalog.v1"
    : kind === "snapshot"
      ? JOBROLO_JOBNIMBUS_IMPORT_SNAPSHOT_SCHEMA
      : "";
  if (!expectedPayloadSchema || payload?.schema !== expectedPayloadSchema) {
    serviceFailure();
  }

  const payloadCanonical = canonicalJson(payload);
  const payloadLimit = kind === "catalog"
    ? JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumCatalogCanonicalUtf8Bytes
    : JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumSnapshotCanonicalUtf8Bytes;
  if (Buffer.byteLength(payloadCanonical, "utf8") > payloadLimit) {
    boundsFailure();
  }
  const generatedAt = new Date(Number(now())).toISOString();
  if (parseIsoUtc(generatedAt) === null) serviceFailure();
  const material = {
    schema: JOBROLO_IMPORT_TRANSPORT_RESPONSE_SCHEMA,
    requestId: verifiedRequest.requestId,
    requestNonce: verifiedRequest.requestNonce,
    generatedAt,
    kind,
    payloadDigest: sha256(Buffer.from(payloadCanonical, "utf8")),
    payload
  };
  const responseDigest = sha256(Buffer.from(canonicalJson(material), "utf8"));
  const body = deepFreeze({ ...material, responseDigest });
  const bodyText = canonicalJson(body);
  if (
    Buffer.byteLength(bodyText, "utf8")
    > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumResponseCanonicalUtf8Bytes
  ) {
    boundsFailure();
  }
  const responseSignature = hmac(
    configuration.secret,
    jobroloImportResponseSigningMaterial({
      pathname,
      requestTimestamp: verifiedRequest.requestTimestamp,
      requestNonce: verifiedRequest.requestNonce,
      requestBodyHash: verifiedRequest.requestBodyHash,
      responseDigest
    })
  );
  return Object.freeze({
    body,
    bodyText,
    headers: Object.freeze({
      [JOBROLO_IMPORT_RESPONSE_HEADERS.digest]: responseDigest,
      [JOBROLO_IMPORT_RESPONSE_HEADERS.signature]: responseSignature
    })
  });
}

export function verifyJobroloImportTransportResponse({
  secret,
  pathname,
  verifiedRequest,
  body,
  headers
} = {}) {
  exactRecord(body, [
    "schema", "requestId", "requestNonce", "generatedAt", "kind",
    "payloadDigest", "payload", "responseDigest"
  ]);
  const claimedDigest = exactHeader(
    headers,
    JOBROLO_IMPORT_RESPONSE_HEADERS.digest
  );
  const signature = exactHeader(
    headers,
    JOBROLO_IMPORT_RESPONSE_HEADERS.signature
  );
  if (
    body.schema !== JOBROLO_IMPORT_TRANSPORT_RESPONSE_SCHEMA
    || body.requestId !== verifiedRequest?.requestId
    || body.requestNonce !== verifiedRequest?.requestNonce
    || !SHA256.test(body.payloadDigest)
    || !SHA256.test(body.responseDigest)
    || claimedDigest !== body.responseDigest
    || signature.length !== 64
  ) {
    authenticationFailure();
  }
  const { responseDigest, ...material } = body;
  const actualPayloadDigest = sha256(
    Buffer.from(canonicalJson(body.payload), "utf8")
  );
  const actualResponseDigest = sha256(
    Buffer.from(canonicalJson(material), "utf8")
  );
  const expectedSignature = hmac(
    secret,
    jobroloImportResponseSigningMaterial({
      pathname,
      requestTimestamp: verifiedRequest.requestTimestamp,
      requestNonce: verifiedRequest.requestNonce,
      requestBodyHash: verifiedRequest.requestBodyHash,
      responseDigest
    })
  );
  if (
    !secureTextEqual(actualPayloadDigest, body.payloadDigest)
    || !secureTextEqual(actualResponseDigest, responseDigest)
    || !secureTextEqual(signature, expectedSignature)
  ) {
    authenticationFailure();
  }
  return true;
}

export function jobroloImportRequestSigningMaterial({
  method,
  pathname,
  timestamp,
  nonce,
  bodyHash
}) {
  return [
    REQUEST_SIGNATURE_DOMAIN,
    method,
    pathname,
    timestamp,
    nonce,
    bodyHash
  ].join("\n");
}

export function jobroloImportResponseSigningMaterial({
  pathname,
  requestTimestamp,
  requestNonce,
  requestBodyHash,
  responseDigest
}) {
  return [
    RESPONSE_SIGNATURE_DOMAIN,
    "POST",
    pathname,
    requestTimestamp,
    requestNonce,
    requestBodyHash,
    responseDigest
  ].join("\n");
}

export function createJobroloImportDocumentResponseHeaders({
  configuration,
  verifiedRequest,
  pathname = JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE,
  responseTimestamp,
  contentType = "application/octet-stream",
  contentLength,
  contentSha256
} = {}) {
  if (!configuration?.ready || !configuration?.secret) serviceFailure();
  if (pathname !== JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE) serviceFailure();
  if (
    !verifiedRequest
    || !REQUEST_ID.test(verifiedRequest.requestId)
    || !NONCE.test(verifiedRequest.requestNonce)
    || parseIsoUtc(verifiedRequest.requestTimestamp) === null
    || !SHA256.test(verifiedRequest.requestBodyHash)
    || !SOURCE_FILE_REF.test(verifiedRequest.sourceFileRef)
    || !SOURCE_RECORD_REF.test(verifiedRequest.sourceRecordRef)
    || !SHA256.test(verifiedRequest.manifestDigest)
    || parseIsoUtc(responseTimestamp) === null
    || contentType !== "application/octet-stream"
    || !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength
      > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumDocumentContentBytes
    || !SHA256.test(contentSha256)
  ) {
    serviceFailure();
  }
  const signature = hmac(
    configuration.secret,
    jobroloImportDocumentResponseSigningMaterial({
      pathname,
      requestTimestamp: verifiedRequest.requestTimestamp,
      requestNonce: verifiedRequest.requestNonce,
      requestBodyHash: verifiedRequest.requestBodyHash,
      requestId: verifiedRequest.requestId,
      sourceFileRef: verifiedRequest.sourceFileRef,
      sourceRecordRef: verifiedRequest.sourceRecordRef,
      manifestDigest: verifiedRequest.manifestDigest,
      responseTimestamp,
      contentType,
      contentLength,
      contentSha256
    })
  );
  return Object.freeze({
    "content-type": contentType,
    "content-length": String(contentLength),
    "content-disposition": "attachment; filename=\"jobnimbus-document\"",
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestId]:
      verifiedRequest.requestId,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.requestNonce]:
      verifiedRequest.requestNonce,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.responseTimestamp]:
      responseTimestamp,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.contentSha256]: contentSha256,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.manifestDigest]:
      verifiedRequest.manifestDigest,
    [JOBROLO_IMPORT_DOCUMENT_RESPONSE_HEADERS.signature]: signature
  });
}

export function jobroloImportDocumentResponseSigningMaterial({
  pathname,
  requestTimestamp,
  requestNonce,
  requestBodyHash,
  requestId,
  sourceFileRef,
  sourceRecordRef,
  manifestDigest,
  responseTimestamp,
  contentType,
  contentLength,
  contentSha256
}) {
  return [
    DOCUMENT_RESPONSE_SIGNATURE_DOMAIN,
    "POST",
    pathname,
    requestTimestamp,
    requestNonce,
    requestBodyHash,
    requestId,
    sourceFileRef,
    sourceRecordRef,
    manifestDigest,
    responseTimestamp,
    contentType,
    String(contentLength),
    contentSha256
  ].join("\n");
}

export function canonicalJson(value) {
  return canonicalValue(value, 0, { nodes: 0 });
}

export function projectJobroloImportError(error) {
  const status = normalizedErrorStatus(error);
  const code = status === 400 || status === 413 || status === 415
    ? "invalid_jobrolo_import_request"
    : status === 401 || status === 403
      ? "invalid_jobrolo_import_authentication"
      : status === 404
        ? "jobrolo_import_source_not_found"
        : status === 409
          ? "jobrolo_import_source_changed"
          : "jobrolo_import_unavailable";
  return Object.freeze({
    status,
    body: Object.freeze({
      schema: JOBROLO_IMPORT_TRANSPORT_ERROR_SCHEMA,
      error: Object.freeze({ code })
    })
  });
}

function validateImportRequest(pathname, value) {
  if (pathname === JOBROLO_IMPORT_CATALOG_ROUTE) {
    exactRecord(value, ["schema", "requestId"]);
    if (
      value.schema !== JOBROLO_IMPORT_CATALOG_REQUEST_SCHEMA
      || !REQUEST_ID.test(value.requestId)
    ) requestFailure();
    return value;
  }
  if (pathname === JOBROLO_IMPORT_DOCUMENT_CONTENT_ROUTE) {
    exactRecord(value, [
      "schema",
      "requestId",
      "sourceFileRef",
      "sourceRecordRef",
      "manifestDigest"
    ]);
    if (
      value.schema !== JOBROLO_IMPORT_DOCUMENT_CONTENT_REQUEST_SCHEMA
      || !REQUEST_ID.test(value.requestId)
      || !SOURCE_FILE_REF.test(value.sourceFileRef)
      || !SOURCE_RECORD_REF.test(value.sourceRecordRef)
      || !SHA256.test(value.manifestDigest)
    ) requestFailure();
    return value;
  }
  exactRecord(value, ["schema", "requestId", "sourceFileRef"]);
  if (
    value.schema !== JOBROLO_IMPORT_SNAPSHOT_REQUEST_SCHEMA
    || !REQUEST_ID.test(value.requestId)
    || !SOURCE_FILE_REF.test(value.sourceFileRef)
  ) requestFailure();
  return value;
}

function canonicalValue(value, depth, state) {
  state.nodes += 1;
  if (
    depth > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumCanonicalDepth
    || state.nodes > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumCanonicalNodes
  ) requestFailure();
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, depth + 1, state)).join(",")}]`;
  }
  if (!isPlainRecord(value)) requestFailure();
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1, state)}`
  )).join(",")}}`;
}

async function pruneExpiredNonces(directory, current) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    serviceFailure();
  }
  if (entries.length > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumNonceEntries + 1) {
    serviceFailure();
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === ".staging") continue;
    if (!entry.isFile() || !SHA256.test(entry.name)) serviceFailure();
    const file = path.join(directory, entry.name);
    let expiry;
    try {
      const raw = await readFile(file, "utf8");
      // Empty/partial receipts are corruption or an implementation fault,
      // never expired state. Fail closed without unlinking them.
      if (!/^\d{13}$/.test(raw)) serviceFailure();
      expiry = Number(raw);
    } catch {
      serviceFailure();
    }
    if (!Number.isSafeInteger(expiry)) serviceFailure();
    if (expiry <= current) await rm(file, { force: true });
  }
}

function assertNonceGuardOptions(now, maximumEntries) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(maximumEntries)
    || maximumEntries < 32
    || maximumEntries > 100_000
  ) throw new TypeError("maximumEntries is invalid");
}

function validNonceExpiry(value, current) {
  const expiry = Number(value);
  if (
    !Number.isSafeInteger(expiry)
    || expiry <= current
    || expiry > current + (2 * 60 * 60_000) + 1
  ) serviceFailure();
  return expiry;
}

function nonceKey(clientId, nonce) {
  return createHash("sha256")
    .update(NONCE_STORAGE_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(String(clientId), "utf8")
    .update("\0", "utf8")
    .update(String(nonce), "utf8")
    .digest("hex");
}

function exactHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (typeof value !== "string" || !value || value.includes(",")) {
    authenticationFailure();
  }
  return value;
}

function exactRecord(value, keys) {
  if (!isPlainRecord(value)) requestFailure();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) requestFailure();
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRawBody(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  requestFailure();
}

function parseIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(secret, value) {
  return createHmac("sha256", String(secret || ""))
    .update(value, "utf8")
    .digest("hex");
}

function secureTextEqual(left, right) {
  const leftBytes = Buffer.from(String(left), "utf8");
  const rightBytes = Buffer.from(String(right), "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function unavailableConfiguration() {
  return Object.freeze({
    enabled: false,
    ready: false,
    clientId: "",
    secret: "",
    principalEmail: "",
    connectionRef: ""
  });
}

function normalizedErrorStatus(error) {
  const status = Number(error?.statusCode);
  return [400, 401, 403, 404, 409, 413, 415, 502, 503].includes(status)
    ? status === 403 ? 401 : status
    : 503;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isPlainRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function configurationFailure() {
  const error = new Error("Jobrolo import configuration is invalid.");
  error.code = "invalid_jobrolo_import_configuration";
  throw error;
}

function authenticationFailure() {
  const error = new Error("Jobrolo import authentication failed.");
  error.code = "invalid_jobrolo_import_authentication";
  error.statusCode = 401;
  throw error;
}

function requestFailure() {
  const error = new Error("Jobrolo import request is invalid.");
  error.code = "invalid_jobrolo_import_request";
  error.statusCode = 400;
  throw error;
}

function boundsFailure() {
  const error = new Error("Jobrolo import response exceeds its bound.");
  error.code = "jobrolo_import_bounds_exceeded";
  error.statusCode = 503;
  throw error;
}

function serviceFailure() {
  const error = new Error("Jobrolo import transport is unavailable.");
  error.code = "jobrolo_import_unavailable";
  error.statusCode = 503;
  throw error;
}
