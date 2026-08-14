import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";

export const JOBROLO_HCN_REQUEST_SCHEMA = "jobrolo.hcn.request.v1";

export const JOBROLO_HCN_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/status",
  "/integrations/jobrolo/v1/work-center",
  "/integrations/jobrolo/v1/file-review",
  "/integrations/jobrolo/v1/communication-sweep",
  "/integrations/jobrolo/v1/management-sweep",
  "/integrations/jobrolo/v1/assistant/turn",
  "/integrations/jobrolo/v1/action-plans/prepare",
  "/integrations/jobrolo/v1/action-plans/execute",
  "/integrations/jobrolo/v1/action-receipts/detail"
]);

export const HCN_JOBROLO_NOTE_WRITEBACK_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/action-plans/prepare",
  "/integrations/jobrolo/v1/action-plans/execute",
  "/integrations/jobrolo/v1/action-receipts/detail"
]);

export const HCN_JOBROLO_CLAIM_FILING_ROUTES = Object.freeze([
  "/integrations/jobrolo/v1/claim-filings/status",
  "/integrations/jobrolo/v1/claim-filings/prepare",
  "/integrations/jobrolo/v1/claim-filings/execute",
  "/integrations/jobrolo/v1/claim-filings/result",
  "/integrations/jobrolo/v1/claim-filings/writeback/prepare",
  "/integrations/jobrolo/v1/claim-filings/writeback/execute"
]);

const ROUTES = new Set([
  ...JOBROLO_HCN_ROUTES,
  ...HCN_JOBROLO_CLAIM_FILING_ROUTES
]);
const CLIENT_ID = /^[A-Za-z0-9._-]{3,64}$/;
const REQUEST_ID = /^request_[a-f0-9]{32}$/;
const SESSION_REF = /^session_[a-f0-9]{32}$/;
const PRINCIPAL_REF = /^principal_[a-f0-9]{32}$/;
const FILE_REF = /^subject_[a-f0-9]{32}$/;
const BINDING_REF = /^binding_[a-f0-9]{64}$/;
const NONCE = /^nonce_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_NONCES = 8_192;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 30_000;

export function isJobroloHcnRoute(pathname) {
  return ROUTES.has(String(pathname || ""));
}

export function deriveJobroloAssistantSessionBindingRef({
  tenantId,
  clientId,
  principalRef,
  sessionRef
} = {}) {
  const tenant = String(tenantId || "");
  if (
    !tenant
    || tenant.length > 256
    || /[\u0000-\u001f\u007f]/.test(tenant)
    || !CLIENT_ID.test(String(clientId || ""))
    || !PRINCIPAL_REF.test(String(principalRef || ""))
    || !SESSION_REF.test(String(sessionRef || ""))
  ) {
    throw new TypeError("Jobrolo assistant session binding input is invalid.");
  }
  return `binding_${createHash("sha256")
    .update("hcn-jobrolo:assistant-session-binding:v1", "utf8")
    .update("\0", "utf8")
    .update(tenant, "utf8")
    .update("\0", "utf8")
    .update(clientId, "utf8")
    .update("\0", "utf8")
    .update(principalRef, "utf8")
    .update("\0", "utf8")
    .update(sessionRef, "utf8")
    .digest("hex")}`;
}

export function deriveJobroloAssistantScopedBindingRef({
  sessionBindingRef,
  kind,
  fileRef
} = {}) {
  const normalizedFileRef = String(fileRef || "");
  if (
    !BINDING_REF.test(String(sessionBindingRef || ""))
    || !["general", "file"].includes(kind)
    || (kind === "general" && normalizedFileRef !== "")
    || (kind === "file" && !FILE_REF.test(normalizedFileRef))
  ) {
    throw new TypeError("Jobrolo assistant scope binding input is invalid.");
  }
  return `binding_${createHash("sha256")
    .update("hcn-jobrolo:assistant-conversation-scope:v1", "utf8")
    .update("\0", "utf8")
    .update(sessionBindingRef, "utf8")
    .update("\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(normalizedFileRef, "utf8")
    .digest("hex")}`;
}

export function loadJobroloHcnIntegrationConfiguration(
  env = {},
  { disallowedSecrets = [] } = {}
) {
  const enabled = String(env.HCN_JOBROLO_ADAPTER_ENABLED || "")
    .trim() === "true";
  const clientId = String(env.HCN_JOBROLO_CLIENT_ID || "").trim();
  const secret = String(env.HCN_JOBROLO_SHARED_SECRET || "");
  const principalEmail = String(
    env.HCN_JOBROLO_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_ADAPTER_ENABLED must be true when Jobrolo adapter credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

/**
 * A separate credential for the ordinary-chat JobNimbus note pilot. It shares
 * the reviewed HCN request envelope and action engine, but its server-owned
 * capability profile is intentionally narrower than the existing general
 * Jobrolo/Thresher adapter.
 */
export function loadJobroloHcnNoteWritebackConfiguration(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const enabled = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_ENABLED || ""
  ).trim() === "true";
  const clientId = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID || ""
  ).trim();
  const secret = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET || ""
  );
  const principalEmail = String(
    env.HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_ENABLED must be true when note-writeback credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedClientIds) {
    const name = String(item?.name || "another client id");
    const value = String(item?.value || "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError(
        `HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID must be different from ${name}.`
      );
    }
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

/**
 * Dedicated owner-only credential for the existing HCN claim-filing engine.
 * It cannot call the general Thresher or note-writeback routes.
 */
export function loadJobroloHcnClaimFilingConfiguration(
  env = {},
  { disallowedClientIds = [], disallowedSecrets = [] } = {}
) {
  const enabled = String(
    env.HCN_JOBROLO_CLAIM_FILING_ENABLED || ""
  ).trim() === "true";
  const clientId = String(
    env.HCN_JOBROLO_CLAIM_FILING_CLIENT_ID || ""
  ).trim();
  const secret = String(
    env.HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET || ""
  );
  const principalEmail = String(
    env.HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL || ""
  ).trim().toLowerCase();
  const anyConfigured = Boolean(clientId || secret || principalEmail);

  if (!enabled && !anyConfigured) {
    return Object.freeze({
      enabled: false,
      ready: false,
      clientId: "",
      secret: "",
      principalEmail: ""
    });
  }
  if (!enabled) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_ENABLED must be true when claim-filing credentials are configured."
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_CLIENT_ID must contain 3-64 safe identifier characters."
    );
  }
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET must contain 32-512 printable non-space ASCII characters."
    );
  }
  if (!EMAIL.test(principalEmail) || principalEmail.length > 254) {
    configurationError(
      "HCN_JOBROLO_CLAIM_FILING_PRINCIPAL_EMAIL must be one fixed valid HCN employee email."
    );
  }
  for (const item of disallowedClientIds) {
    const name = String(item?.name || "another client id");
    const value = String(item?.value || "");
    if (value && secureTextEqual(clientId, value)) {
      configurationError(
        `HCN_JOBROLO_CLAIM_FILING_CLIENT_ID must be different from ${name}.`
      );
    }
  }
  for (const item of disallowedSecrets) {
    const name = String(item?.name || "another secret");
    const value = String(item?.value || "");
    if (value && secureTextEqual(secret, value)) {
      configurationError(
        `HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET must be different from ${name}.`
      );
    }
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    clientId,
    secret,
    principalEmail
  });
}

export function createJobroloHcnNonceGuard({
  now = Date.now,
  ttlMs = DEFAULT_SKEW_MS,
  maxEntries = DEFAULT_MAX_NONCES
} = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) {
    throw new TypeError("ttlMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 32
    || maxEntries > 100_000
  ) {
    throw new TypeError("maxEntries is outside the supported range");
  }
  const used = new Map();
  return Object.freeze({
    consume(clientId, nonce, validUntilMs) {
      const current = now();
      for (const [key, expiresAt] of used) {
        if (expiresAt <= current) used.delete(key);
      }
      const key = `${clientId}\0${nonce}`;
      if (used.has(key)) {
        throw authenticationError(
          "Jobrolo integration request replay was rejected."
        );
      }
      if (used.size >= maxEntries) {
        throw serviceError(
          "Jobrolo integration replay protection is at capacity."
        );
      }
      const requestedExpiry = Number(validUntilMs);
      // Authenticators permit at most one hour of clock skew, so a signed
      // future timestamp can remain usable for at most two hours from receipt.
      // Keep this bound independent of the guard's fallback TTL so an injected
      // guard cannot accidentally shorten replay coverage below the signature
      // validity window.
      const maximumExpiry = current + (2 * 3_600_000) + 1;
      const expiresAt = Number.isSafeInteger(requestedExpiry)
        && requestedExpiry > current
        && requestedExpiry <= maximumExpiry
        ? requestedExpiry
        : current + ttlMs;
      used.set(key, expiresAt);
    }
  });
}

export function createJobroloHcnAuthenticator({
  configuration,
  now = Date.now,
  maximumSkewMs = DEFAULT_SKEW_MS,
  nonceGuard = createJobroloHcnNonceGuard({ now, ttlMs: maximumSkewMs }),
  allowedRoutes = JOBROLO_HCN_ROUTES
} = {}) {
  if (!configuration?.ready || !configuration?.enabled) {
    return Object.freeze({
      authenticate() {
        throw serviceError("The Jobrolo HCN integration is unavailable.");
      }
    });
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(maximumSkewMs)
    || maximumSkewMs < 1_000
    || maximumSkewMs > 3_600_000
  ) {
    throw new TypeError("maximumSkewMs is outside the supported range");
  }
  const allowedRouteSet = validateAllowedRoutes(allowedRoutes);

  return Object.freeze({
    authenticate({ method, pathname, headers, body } = {}) {
      const normalizedMethod = String(method || "").toUpperCase();
      const normalizedPath = String(pathname || "");
      if (
        normalizedMethod !== "POST"
        || !allowedRouteSet.has(normalizedPath)
      ) {
        throw authenticationError("Jobrolo integration route is not allowed.");
      }
      const authorization = exactHeader(headers, "authorization");
      if (authorization !== `Jobrolo-HMAC ${configuration.clientId}`) {
        throw authenticationError("Jobrolo integration authentication failed.");
      }
      const timestampText = exactHeader(headers, "x-jobrolo-timestamp");
      if (!/^\d{13}$/.test(timestampText)) {
        throw authenticationError("Jobrolo integration timestamp is invalid.");
      }
      const timestamp = Number(timestampText);
      if (
        !Number.isSafeInteger(timestamp)
        || Math.abs(now() - timestamp) > maximumSkewMs
      ) {
        throw authenticationError("Jobrolo integration timestamp is stale.");
      }
      const nonce = exactHeader(headers, "x-jobrolo-nonce");
      if (!NONCE.test(nonce)) {
        throw authenticationError("Jobrolo integration nonce is invalid.");
      }
      const claimedHash = exactHeader(
        headers,
        "x-jobrolo-content-sha256"
      );
      const signature = exactHeader(headers, "x-jobrolo-signature");
      if (!SHA256.test(claimedHash) || !SHA256.test(signature)) {
        throw authenticationError("Jobrolo integration signature is invalid.");
      }

      const canonicalBody = stableCanonicalJson(body);
      const actualHash = createHash("sha256")
        .update(canonicalBody, "utf8")
        .digest("hex");
      if (!secureTextEqual(claimedHash, actualHash)) {
        throw authenticationError("Jobrolo integration body hash is invalid.");
      }
      const canonicalRequest = jobroloHcnSigningMaterial({
        method: normalizedMethod,
        pathname: normalizedPath,
        timestamp: timestampText,
        nonce,
        bodyHash: actualHash
      });
      const expectedSignature = createHmac(
        "sha256",
        configuration.secret
      ).update(canonicalRequest, "utf8").digest("hex");
      if (!secureTextEqual(signature, expectedSignature)) {
        throw authenticationError("Jobrolo integration signature is invalid.");
      }

      const envelope = validateJobroloHcnRequestEnvelope(body);
      // A timestamp may be as much as one skew window in the future. Retain
      // the nonce until that timestamp can no longer authenticate, otherwise
      // a future-dated request could be replayed after a fixed TTL elapsed.
      nonceGuard.consume(
        configuration.clientId,
        nonce,
        timestamp + maximumSkewMs + 1
      );
      return Object.freeze({
        clientId: configuration.clientId,
        principalEmail: configuration.principalEmail,
        requestId: envelope.requestId,
        sessionRef: envelope.actor.sessionRef,
        input: envelope.input
      });
    }
  });
}

function validateAllowedRoutes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("allowedRoutes must be a non-empty route array");
  }
  const routes = new Set();
  for (const route of value) {
    if (
      typeof route !== "string"
      || !ROUTES.has(route)
      || routes.has(route)
    ) {
      throw new TypeError(
        "allowedRoutes must contain unique allowlisted Jobrolo HCN routes"
      );
    }
    routes.add(route);
  }
  return routes;
}

export function signJobroloHcnRequest({
  clientId,
  secret,
  method = "POST",
  pathname,
  timestamp,
  nonce,
  body
} = {}) {
  const canonicalBody = stableCanonicalJson(body);
  const bodyHash = createHash("sha256")
    .update(canonicalBody, "utf8")
    .digest("hex");
  const timestampText = String(timestamp);
  const material = jobroloHcnSigningMaterial({
    method: String(method).toUpperCase(),
    pathname,
    timestamp: timestampText,
    nonce,
    bodyHash
  });
  return Object.freeze({
    authorization: `Jobrolo-HMAC ${clientId}`,
    "x-jobrolo-timestamp": timestampText,
    "x-jobrolo-nonce": nonce,
    "x-jobrolo-content-sha256": bodyHash,
    "x-jobrolo-signature": createHmac("sha256", secret)
      .update(material, "utf8")
      .digest("hex")
  });
}

export function stableCanonicalJson(value) {
  const state = { nodes: 0 };
  return canonicalValue(value, 0, state);
}

function canonicalValue(value, depth, state) {
  state.nodes += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
    throw requestError("Jobrolo integration body is too complex.");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw requestError("Jobrolo integration body contains an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item, depth + 1, state)).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    throw requestError("Jobrolo integration body must contain plain JSON data.");
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1, state)}`
  )).join(",")}}`;
}

function validateJobroloHcnRequestEnvelope(value) {
  exactRecord(value, ["schema", "requestId", "actor", "input"], "request");
  if (value.schema !== JOBROLO_HCN_REQUEST_SCHEMA) {
    throw requestError("Jobrolo integration request schema is invalid.");
  }
  if (!REQUEST_ID.test(value.requestId)) {
    throw requestError("Jobrolo integration requestId is invalid.");
  }
  exactRecord(value.actor, ["sessionRef"], "actor");
  if (!SESSION_REF.test(value.actor.sessionRef)) {
    throw requestError("Jobrolo integration sessionRef is invalid.");
  }
  if (!isPlainRecord(value.input)) {
    throw requestError("Jobrolo integration input must be an object.");
  }
  return value;
}

function jobroloHcnSigningMaterial({
  method,
  pathname,
  timestamp,
  nonce,
  bodyHash
}) {
  return `${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

function exactHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value) || typeof value !== "string" || !value) {
    throw authenticationError("Jobrolo integration authentication failed.");
  }
  return value;
}

function exactRecord(value, keys, label) {
  if (!isPlainRecord(value)) {
    throw requestError(`Jobrolo integration ${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) {
    throw requestError(
      `Jobrolo integration ${label} contains unsupported fields.`
    );
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function secureTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function configurationError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_configuration";
  throw error;
}

function authenticationError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_authentication";
  error.statusCode = 401;
  return error;
}

function requestError(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_request";
  error.statusCode = 400;
  return error;
}

function serviceError(message) {
  const error = new Error(message);
  error.code = "jobrolo_hcn_unavailable";
  error.statusCode = 503;
  return error;
}
