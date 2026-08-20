import {
  createHash,
  randomBytes as cryptographicRandomBytes,
  timingSafeEqual
} from "node:crypto";

import {
  validateHcnCsrfToken,
  validateHcnReturnTo
} from "./hcn-console-http.js";

const IDENTIFIER_BYTES = 32;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const AUTHORIZATION_VERSION_PATTERN = /^authz_v1_[a-f0-9]{64}$/;
const SUBJECT_MAX_BYTES = 256;
const DEFAULT_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_TRANSACTIONS = 256;
const DEFAULT_MAX_SESSIONS = 1024;
const RANDOM_ATTEMPTS = 4;
const HASH_CONTEXT = "hcn-console:opaque-store:v1";
const REDACTED = "[REDACTED]";

/**
 * Bounded, in-memory authorization state for the HCN browser console.
 *
 * Raw transaction, session, and binding identifiers are returned only to the
 * caller that creates them. Maps and records retain domain-separated SHA-256
 * digests, never raw bearer material. No client or file data is accepted.
 */
export function createHcnConsoleSessionStore({
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  transactionTtlMs = DEFAULT_TRANSACTION_TTL_MS,
  sessionIdleTtlMs = DEFAULT_SESSION_IDLE_TTL_MS,
  sessionAbsoluteTtlMs = DEFAULT_SESSION_ABSOLUTE_TTL_MS,
  maxTransactions = DEFAULT_MAX_TRANSACTIONS,
  maxSessions = DEFAULT_MAX_SESSIONS
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof randomBytes !== "function") {
    throw new TypeError("randomBytes must be a function");
  }
  assertPositiveDuration(transactionTtlMs, "transactionTtlMs");
  assertPositiveDuration(sessionIdleTtlMs, "sessionIdleTtlMs");
  assertPositiveDuration(sessionAbsoluteTtlMs, "sessionAbsoluteTtlMs");
  if (sessionIdleTtlMs > sessionAbsoluteTtlMs) {
    throw new TypeError(
      "sessionIdleTtlMs must not exceed sessionAbsoluteTtlMs"
    );
  }
  assertPositiveBound(maxTransactions, "maxTransactions");
  assertPositiveBound(maxSessions, "maxSessions");

  const transactions = new Map();
  const sessions = new Map();
  const dummyBindingDigest = digestIdentifier("binding", "invalid");
  const dummyCsrfToken = Buffer.alloc(
    IDENTIFIER_BYTES,
    0
  ).toString("base64url");

  function createLoginTransaction(input) {
    assertExactObjectKeys(input, [
      "returnTo",
      "pkceVerifier"
    ], "login transaction");
    const returnTo = validateHcnReturnTo(input.returnTo);
    const pkceVerifier = assertPkceVerifier(input.pkceVerifier);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    if (transactions.size >= maxTransactions) {
      throw storeError("Login transaction capacity is exhausted");
    }

    const transactionId = generateUniqueId({
      domain: "transaction",
      records: transactions,
      randomBytes
    });
    const bindingId = generateIndependentId(randomBytes);
    const transactionKey = digestIdentifier(
      "transaction",
      transactionId
    ).toString("hex");
    const expiresAt = timestamp + transactionTtlMs;
    transactions.set(transactionKey, {
      bindingDigest: digestIdentifier("binding", bindingId),
      returnTo,
      pkceVerifier,
      createdAt: timestamp,
      expiresAt
    });

    const result = {
      createdAt: iso(timestamp),
      expiresAt: iso(expiresAt)
    };
    defineSensitive(result, "transactionId", transactionId);
    defineSensitive(result, "bindingId", bindingId);
    return freezeCredentialResult(result);
  }

  function consumeLoginTransaction(input) {
    if (!hasExactObjectKeys(input, [
      "transactionId",
      "bindingId"
    ])) {
      return null;
    }
    if (
      !isIdentifier(input.transactionId) ||
      !isIdentifier(input.bindingId)
    ) {
      return null;
    }

    const timestamp = readNow(now);
    const transactionKey = digestIdentifier(
      "transaction",
      input.transactionId
    ).toString("hex");
    const record = transactions.get(transactionKey);
    if (!record) {
      // Do the binding work even when the state id is unknown.
      constantTimeDigestEqual(
        digestIdentifier("binding", input.bindingId),
        dummyBindingDigest
      );
      return null;
    }

    // A located transaction is consumed before any validation result is
    // returned. It can never be replayed, including after a bad binding.
    transactions.delete(transactionKey);
    const bindingMatches = constantTimeDigestEqual(
      digestIdentifier("binding", input.bindingId),
      record.bindingDigest
    );
    if (!bindingMatches || timestamp >= record.expiresAt) {
      return null;
    }

    const result = {
      returnTo: record.returnTo,
      createdAt: iso(record.createdAt),
      expiresAt: iso(record.expiresAt)
    };
    defineSensitive(result, "pkceVerifier", record.pkceVerifier);
    return freezeCredentialResult(result);
  }

  function createSession(input) {
    assertAllowedObjectKeys(input, [
      "subject",
      "googleSubject",
      "role",
      "authorizationVersion"
    ], [
      "subject",
      "googleSubject",
      "role"
    ], "session");
    const subject = assertSubject(input.subject);
    const googleSubject = assertGoogleSubject(input.googleSubject);
    const role = assertRole(input.role);
    const authorizationVersion =
      input.authorizationVersion === undefined
        ? ""
        : assertAuthorizationVersion(input.authorizationVersion);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    if (sessions.size >= maxSessions) {
      throw storeError("Session capacity is exhausted");
    }

    const sessionId = generateUniqueId({
      domain: "session",
      records: sessions,
      randomBytes
    });
    const csrfToken = generateIndependentId(randomBytes);
    const sessionKey = digestIdentifier(
      "session",
      sessionId
    ).toString("hex");
    const absoluteExpiresAt = timestamp + sessionAbsoluteTtlMs;
    const idleExpiresAt = Math.min(
      timestamp + sessionIdleTtlMs,
      absoluteExpiresAt
    );
    sessions.set(sessionKey, {
      csrfToken,
      subject,
      googleSubject,
      role,
      authorizationVersion,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      idleExpiresAt,
      absoluteExpiresAt
    });

    const result = safeSessionRecord(sessions.get(sessionKey));
    defineSensitive(result, "sessionId", sessionId);
    return Object.freeze(result);
  }

  function resolveSession(sessionId) {
    const located = locateLiveSession(
      sessionId,
      readNow(now)
    );
    return located ? safeSessionRecord(located.record) : null;
  }

  function touchSession(sessionId) {
    const timestamp = readNow(now);
    const located = locateLiveSession(sessionId, timestamp);
    if (!located) return null;
    located.record.lastSeenAt = timestamp;
    located.record.idleExpiresAt = Math.min(
      timestamp + sessionIdleTtlMs,
      located.record.absoluteExpiresAt
    );
    return safeSessionRecord(located.record);
  }

  function validateSessionCsrf(sessionId, providedToken) {
    const located = locateLiveSession(
      sessionId,
      readNow(now)
    );
    const matches = validateHcnCsrfToken(
      providedToken,
      located?.record.csrfToken ?? dummyCsrfToken
    );
    return matches && Boolean(located);
  }

  function revokeSession(sessionId) {
    if (!isIdentifier(sessionId)) return false;
    return sessions.delete(
      digestIdentifier("session", sessionId).toString("hex")
    );
  }

  function revokeSubject(subject) {
    if (!isSubject(subject)) return 0;
    let revoked = 0;
    for (const [key, record] of sessions) {
      if (record.subject !== subject) continue;
      sessions.delete(key);
      revoked += 1;
    }
    return revoked;
  }

  function cleanup() {
    return cleanupAt(readNow(now));
  }

  function cleanupAt(timestamp) {
    let loginTransactionsRemoved = 0;
    let sessionsRemoved = 0;
    for (const [key, record] of transactions) {
      if (timestamp < record.expiresAt) continue;
      transactions.delete(key);
      loginTransactionsRemoved += 1;
    }
    for (const [key, record] of sessions) {
      if (
        timestamp < record.idleExpiresAt &&
        timestamp < record.absoluteExpiresAt
      ) {
        continue;
      }
      sessions.delete(key);
      sessionsRemoved += 1;
    }
    return Object.freeze({
      loginTransactionsRemoved,
      sessionsRemoved
    });
  }

  function locateLiveSession(sessionId, timestamp) {
    if (!isIdentifier(sessionId)) return null;
    const key = digestIdentifier("session", sessionId).toString("hex");
    const record = sessions.get(key);
    if (!record) return null;
    if (
      timestamp >= record.idleExpiresAt ||
      timestamp >= record.absoluteExpiresAt
    ) {
      sessions.delete(key);
      return null;
    }
    return { key, record };
  }

  return Object.freeze({
    createLoginTransaction,
    consumeLoginTransaction,
    createSession,
    resolveSession,
    touchSession,
    validateSessionCsrf,
    // Compatibility alias for callers using the broader "binding" term.
    validateSessionBinding: validateSessionCsrf,
    revokeSession,
    revokeSubject,
    cleanup,
    stats() {
      cleanupAt(readNow(now));
      return Object.freeze({
        loginTransactions: transactions.size,
        sessions: sessions.size,
        maxTransactions,
        maxSessions
      });
    }
  });
}

/**
 * Exact safe projection for a browser-visible session.
 *
 * It deliberately excludes subject identifiers, the Google subject binding,
 * bearer/session ids, binding ids, digests, PKCE material, provider tokens,
 * email, and all client data.
 */
export function projectPublicHcnSession(session) {
  if (
    !session ||
    session.authenticated !== true ||
    session.authentication !== "hcn_browser_session" ||
    typeof session.role !== "string" ||
    typeof session.createdAt !== "string" ||
    typeof session.lastSeenAt !== "string" ||
    typeof session.idleExpiresAt !== "string" ||
    typeof session.expiresAt !== "string"
  ) {
    return Object.freeze({
      authenticated: false,
      authentication: "none"
    });
  }
  return Object.freeze({
    authenticated: true,
    authentication: "hcn_browser_session",
    role: session.role,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    expiresAt: session.expiresAt
  });
}

export class HcnConsoleSessionStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "HcnConsoleSessionStoreError";
  }
}

function safeSessionRecord(record) {
  const result = {
    authenticated: true,
    authentication: "hcn_browser_session",
    role: record.role,
    createdAt: iso(record.createdAt),
    lastSeenAt: iso(record.lastSeenAt),
    idleExpiresAt: iso(record.idleExpiresAt),
    expiresAt: iso(record.absoluteExpiresAt)
  };
  defineSensitive(result, "subject", record.subject);
  defineSensitive(result, "googleSubject", record.googleSubject);
  defineSensitive(
    result,
    "authorizationVersion",
    record.authorizationVersion
  );
  defineSensitive(result, "csrfToken", record.csrfToken);
  Object.defineProperty(result, "toJSON", {
    value() {
      return projectPublicHcnSession(this);
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return result;
}

function generateUniqueId({ domain, records, randomBytes }) {
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const identifier = generateIndependentId(randomBytes);
    const key = digestIdentifier(domain, identifier).toString("hex");
    if (!records.has(key)) return identifier;
  }
  throw storeError(`Unable to allocate a unique ${domain} identifier`);
}

function generateIndependentId(randomBytes) {
  let generated;
  try {
    generated = randomBytes(IDENTIFIER_BYTES);
  } catch {
    throw storeError("Cryptographic identifier generation failed");
  }
  if (
    (!Buffer.isBuffer(generated) && !(generated instanceof Uint8Array)) ||
    generated.byteLength !== IDENTIFIER_BYTES
  ) {
    throw storeError(
      `randomBytes must return exactly ${IDENTIFIER_BYTES} bytes`
    );
  }
  return Buffer.from(generated).toString("base64url");
}

function digestIdentifier(domain, identifier) {
  return createHash("sha256")
    .update(HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(identifier, "utf8")
    .digest();
}

function constantTimeDigestEqual(left, right) {
  return timingSafeEqual(left, right);
}

function assertExactObjectKeys(input, expectedKeys, label) {
  if (!hasExactObjectKeys(input, expectedKeys)) {
    throw storeError(
      `${label} must contain exactly: ${expectedKeys.join(", ")}`
    );
  }
}

function assertAllowedObjectKeys(
  input,
  allowedKeys,
  requiredKeys,
  label
) {
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
  ) {
    throw storeError(`${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(input);
  if (
    !actual.every((key) => typeof key === "string")
    || actual.some((key) => !allowedKeys.includes(key))
    || requiredKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(input, key)
    )
  ) {
    throw storeError(
      `${label} contains unsupported or missing fields`
    );
  }
}

function hasExactObjectKeys(input, expectedKeys) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return false;
  }
  const actual = Reflect.ownKeys(input);
  if (!actual.every((key) => typeof key === "string")) {
    return false;
  }
  actual.sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertPkceVerifier(value) {
  if (typeof value !== "string" || !PKCE_VERIFIER_PATTERN.test(value)) {
    throw storeError(
      "pkceVerifier must be a 43-128 character PKCE verifier"
    );
  }
  return value;
}

function assertSubject(value) {
  if (!isSubject(value)) {
    throw storeError("subject must be a bounded opaque identity");
  }
  return value;
}

function assertGoogleSubject(value) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9._~-]{1,255}$/.test(value)
  ) {
    throw storeError("googleSubject must be a bounded opaque identity");
  }
  return value;
}

function isSubject(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= SUBJECT_MAX_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertRole(value) {
  if (typeof value !== "string" || !ROLE_PATTERN.test(value)) {
    throw storeError("role must be a normalized authorization role");
  }
  return value;
}

function assertAuthorizationVersion(value) {
  if (
    typeof value !== "string"
    || !AUTHORIZATION_VERSION_PATTERN.test(value)
  ) {
    throw storeError(
      "authorizationVersion must be a normalized HCN authorization version"
    );
  }
  return value;
}

function isIdentifier(value) {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw storeError("Clock failed");
  }
  const timestamp = value instanceof Date
    ? value.getTime()
    : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw storeError("Clock must return a non-negative millisecond timestamp");
  }
  return timestamp;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function defineSensitive(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

function freezeCredentialResult(result) {
  Object.defineProperty(result, "toJSON", {
    value() {
      return REDACTED;
    },
    enumerable: false,
    configurable: false,
    writable: false
  });
  return Object.freeze(result);
}

function assertPositiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertPositiveBound(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 100_000
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than 100000`
    );
  }
}

function storeError(message) {
  return new HcnConsoleSessionStoreError(message);
}
