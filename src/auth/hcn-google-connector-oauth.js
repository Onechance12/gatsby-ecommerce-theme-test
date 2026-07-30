import {
  createHash,
  randomBytes as cryptographicRandomBytes,
  timingSafeEqual
} from "node:crypto";

import {
  GOOGLE_PROVIDER_ENDPOINTS,
  fetchBoundedProviderJson,
  resolveGoogleProviderEndpoint
} from "./google-provider-http.js";
import { validateHcnReturnTo } from "./hcn-console-http.js";

export const HCN_GOOGLE_CONNECTOR_AUTHORIZE_STATE_KIND =
  "hcn_google_connector_authorize_state";

export const HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly"
]);

const DEFAULT_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const MAX_TRANSACTION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TRANSACTIONS = 256;
const HARD_MAX_TRANSACTIONS = 4096;
const PKCE_BYTES = 64;
const TRANSACTION_ID_BYTES = 32;
const MAX_STATE_BYTES = 8192;
const MAX_CODE_BYTES = 4096;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_CONFIG_TEXT_BYTES = 16 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_BINDING_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const PROVIDER_ERROR_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONFIG_FIELDS = Object.freeze([
  "clientId",
  "clientSecret",
  "callbackUri",
  "allowedDomain",
  "tokenUrl",
  "allowTestProviderEndpoints",
  "transactionTtlMs",
  "maxTransactions"
]);
const STATE_FIELDS = Object.freeze([
  "kind",
  "transactionId",
  "exp"
]);
const BINDING_HASH_CONTEXT =
  "hcn-google-connector-oauth:session-binding:v1";

/**
 * Coordinate a signed-in HCN employee's separate Google connector consent.
 *
 * This is deliberately not a login coordinator. The caller must supply the
 * current opaque HCN session binding and the principal's immutable Google
 * subject both when consent begins and when the shared callback returns.
 *
 * Transactions live only inside this coordinator, are bounded, expire
 * quickly, and are consumed before callback inputs or provider results are
 * accepted. Provider credentials and grants never enter returned values.
 */
export function createHcnGoogleConnectorOAuthCoordinator({
  seal,
  open,
  fetch: fetchImpl = globalThis.fetch,
  authenticateCurrentIdentity,
  persistGrant,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  config
} = {}) {
  assertFunction(seal, "seal");
  assertFunction(open, "open");
  assertFunction(fetchImpl, "fetch");
  assertFunction(
    authenticateCurrentIdentity,
    "authenticateCurrentIdentity"
  );
  assertFunction(persistGrant, "persistGrant");
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");

  const normalizedConfig = normalizeConfig(config);
  const transactions = new Map();

  async function beginAuthorization({
    sessionBinding,
    googleSubject,
    returnTo = "/hcn"
  } = {}) {
    const timestamp = readNow(now);
    purgeExpiredTransactions(transactions, timestamp);

    const binding = normalizeSessionBinding(sessionBinding);
    const subject = normalizeBeginGoogleSubject(googleSubject);
    const safeReturnTo = normalizeReturnTo(returnTo);
    if (transactions.size >= normalizedConfig.maxTransactions) {
      throw connectorError(
        "temporarily_unavailable",
        "Google connection is temporarily unavailable.",
        503
      );
    }

    const verifier = createPkceVerifier(randomBytes);
    const transactionId = createUniqueTransactionId(
      randomBytes,
      transactions
    );
    const expiresAt =
      timestamp + normalizedConfig.transactionTtlMs;
    transactions.set(transactionId, Object.freeze({
      sessionBindingHash: hashSessionBinding(binding),
      googleSubject: subject,
      returnTo: safeReturnTo,
      pkceVerifier: verifier,
      expiresAt
    }));

    let state;
    try {
      state = await seal(Object.freeze({
        kind: HCN_GOOGLE_CONNECTOR_AUTHORIZE_STATE_KIND,
        transactionId,
        exp: expiresAt
      }));
      state = boundedState(state);
    } catch {
      transactions.delete(transactionId);
      throw connectorError(
        "temporarily_unavailable",
        "Google connection is temporarily unavailable.",
        503
      );
    }

    const authorizationUrl = new URL(
      GOOGLE_PROVIDER_ENDPOINTS.authorize
    );
    authorizationUrl.searchParams.set(
      "client_id",
      normalizedConfig.clientId
    );
    authorizationUrl.searchParams.set(
      "redirect_uri",
      normalizedConfig.callbackUri
    );
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set(
      "scope",
      HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.join(" ")
    );
    authorizationUrl.searchParams.set(
      "code_challenge",
      pkceChallenge(verifier)
    );
    authorizationUrl.searchParams.set(
      "code_challenge_method",
      "S256"
    );
    authorizationUrl.searchParams.set("access_type", "offline");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set(
      "hd",
      normalizedConfig.allowedDomain
    );
    authorizationUrl.searchParams.set("state", state);

    return Object.freeze({
      status: "authorization_required",
      redirectUrl: authorizationUrl.toString()
    });
  }

  async function completeCallback({
    state,
    code = "",
    error = "",
    sessionBinding,
    googleSubject
  } = {}) {
    const statePayload = await decodeConnectorState(open, state);

    // Consume immediately after an authenticated state reveals the lookup
    // key. Every subsequent failure is one-shot, including binding mismatch,
    // expiry, denial, bad code, identity mismatch, and persistence failure.
    const transaction = transactions.get(
      statePayload.transactionId
    );
    transactions.delete(statePayload.transactionId);
    if (!transaction) {
      throw invalidTransaction();
    }

    const timestamp = readNow(now);
    if (
      statePayload.exp !== transaction.expiresAt
      || statePayload.exp <= timestamp
    ) {
      throw invalidTransaction();
    }

    const binding = normalizeCallbackSessionBinding(sessionBinding);
    const subject = normalizeCallbackGoogleSubject(googleSubject);
    if (
      !safeEqual(
        transaction.sessionBindingHash,
        hashSessionBinding(binding)
      )
      || subject !== transaction.googleSubject
    ) {
      throw invalidTransaction();
    }

    const providerError = normalizeProviderError(error);
    if (providerError) {
      return Object.freeze({
        status:
          providerError === "access_denied"
            ? "cancelled"
            : "provider_error",
        redirectPath: transaction.returnTo
      });
    }

    const authorizationCode = boundedCode(code);
    const tokens = await exchangeAuthorizationCode({
      fetchImpl,
      config: normalizedConfig,
      code: authorizationCode,
      verifier: assertPkceVerifier(transaction.pkceVerifier)
    });
    const identity = await authenticateIdentity({
      authenticateCurrentIdentity,
      fetchImpl,
      config: normalizedConfig,
      accessToken: tokens.accessToken
    });
    if (
      identity.subject !== transaction.googleSubject
      || identity.subject !== subject
    ) {
      throw connectorError(
        "access_denied",
        "The connected Google account does not match the current HCN employee.",
        403
      );
    }

    const accessExpiresAt = new Date(
      readNow(now) + tokens.expiresIn * 1000
    ).toISOString();
    const privateGrant = Object.freeze({
      googleSubject: subject,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt,
      scopes: HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES
    });
    try {
      await persistGrant(privateGrant);
    } catch {
      throw connectorError(
        "temporarily_unavailable",
        "The Google connection could not be saved.",
        503
      );
    }

    return Object.freeze({
      status: "connected",
      redirectPath: transaction.returnTo
    });
  }

  return Object.freeze({
    beginAuthorization,
    completeCallback
  });
}

export class HcnGoogleConnectorOAuthError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "HcnGoogleConnectorOAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function decodeConnectorState(open, value) {
  const state = boundedState(value);
  let payload;
  try {
    payload = await open(state);
  } catch {
    throw invalidTransaction();
  }
  if (
    !isPlainObject(payload)
    || !hasExactKeys(payload, STATE_FIELDS)
    || payload.kind
      !== HCN_GOOGLE_CONNECTOR_AUTHORIZE_STATE_KIND
    || !TRANSACTION_ID_PATTERN.test(payload.transactionId)
    || !Number.isSafeInteger(payload.exp)
    || payload.exp < 0
  ) {
    throw invalidTransaction();
  }
  return Object.freeze({
    kind: payload.kind,
    transactionId: payload.transactionId,
    exp: payload.exp
  });
}

async function exchangeAuthorizationCode({
  fetchImpl,
  config,
  code,
  verifier
}) {
  let providerResult;
  try {
    providerResult = await fetchBoundedProviderJson(
      fetchImpl,
      config.tokenUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUri,
          grant_type: "authorization_code",
          code_verifier: verifier
        })
      }
    );
  } catch {
    throw connectorError(
      "temporarily_unavailable",
      "Google authorization is temporarily unavailable.",
      503
    );
  }

  if (!providerResult.response.ok) {
    throw connectorError(
      "access_denied",
      "Google authorization could not be completed.",
      403
    );
  }

  try {
    const payload = providerResult.payload;
    const accessToken = boundedToken(
      payload.access_token,
      "Google access token"
    );
    const refreshToken = boundedToken(
      payload.refresh_token,
      "Google refresh token"
    );
    if (
      String(payload.token_type || "").trim().toLowerCase()
        !== "bearer"
    ) {
      throw new TypeError("Google token type is invalid");
    }
    const expiresIn = normalizeExpiresIn(payload.expires_in);
    const scopes = normalizeGrantedScopes(payload.scope);
    if (!exactScopeSet(scopes)) {
      throw new TypeError("Google scopes are incomplete");
    }
    return Object.freeze({
      accessToken,
      refreshToken,
      expiresIn
    });
  } catch {
    throw connectorError(
      "access_denied",
      "Google did not grant the required connector access.",
      403
    );
  }
}

async function authenticateIdentity({
  authenticateCurrentIdentity,
  fetchImpl,
  config,
  accessToken
}) {
  let identity;
  try {
    identity = await authenticateCurrentIdentity(Object.freeze({
      accessToken,
      clientId: config.clientId,
      allowedDomain: config.allowedDomain,
      fetch: fetchImpl
    }));
  } catch {
    throw connectorError(
      "access_denied",
      "The connected Google account could not be verified.",
      403
    );
  }
  if (!isPlainObject(identity)) {
    throw connectorError(
      "access_denied",
      "The connected Google account could not be verified.",
      403
    );
  }

  let subject;
  let hostedDomain;
  try {
    subject = normalizeGoogleSubject(identity.subject);
    hostedDomain = normalizeAllowedDomain(identity.hostedDomain);
  } catch {
    throw connectorError(
      "access_denied",
      "The connected Google account could not be verified.",
      403
    );
  }
  if (hostedDomain !== config.allowedDomain) {
    throw connectorError(
      "access_denied",
      "The connected Google account could not be verified.",
      403
    );
  }
  return Object.freeze({ subject, hostedDomain });
}

function normalizeConfig(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("config must be a plain object");
  }
  assertAllowedKeys(value, CONFIG_FIELDS, "config");
  const clientId = boundedConfigText(
    value.clientId,
    "Google client id"
  );
  const clientSecret = boundedConfigText(
    value.clientSecret,
    "Google client secret"
  );
  const callbackUri = normalizeCallbackUri(value.callbackUri);
  const allowedDomain = normalizeAllowedDomain(
    value.allowedDomain
  );
  if (
    value.allowTestProviderEndpoints !== undefined
    && typeof value.allowTestProviderEndpoints !== "boolean"
  ) {
    throw new TypeError(
      "allowTestProviderEndpoints must be a boolean"
    );
  }
  const allowTestProviderEndpoints =
    value.allowTestProviderEndpoints === true;
  const tokenUrl = resolveGoogleProviderEndpoint(
    "token",
    value.tokenUrl,
    { allowLoopbackForTests: allowTestProviderEndpoints }
  );
  const transactionTtlMs =
    value.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS;
  const maxTransactions =
    value.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  assertIntegerRange(
    transactionTtlMs,
    1000,
    MAX_TRANSACTION_TTL_MS,
    "transactionTtlMs"
  );
  assertIntegerRange(
    maxTransactions,
    1,
    HARD_MAX_TRANSACTIONS,
    "maxTransactions"
  );
  return Object.freeze({
    clientId,
    clientSecret,
    callbackUri,
    allowedDomain,
    tokenUrl,
    allowTestProviderEndpoints,
    transactionTtlMs,
    maxTransactions
  });
}

function normalizeCallbackUri(value) {
  const text = boundedConfigText(value, "Google callback URI");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError(
      "Google callback URI must be an absolute URL"
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname
  );
  if (
    parsed.toString() !== text
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/oauth/google/callback"
    || (parsed.protocol !== "https:" && !loopback)
  ) {
    throw new TypeError(
      "Google callback URI must be the exact shared callback"
    );
  }
  return text;
}

function normalizeAllowedDomain(value) {
  if (typeof value !== "string") {
    throw new TypeError("Google allowed domain is required");
  }
  const domain = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new TypeError("Google allowed domain is invalid");
  }
  return domain;
}

function normalizeReturnTo(value) {
  try {
    return validateHcnReturnTo(value);
  } catch {
    throw connectorError(
      "invalid_request",
      "The Google connection return path is invalid.",
      400
    );
  }
}

function normalizeSessionBinding(value) {
  if (
    typeof value !== "string"
    || !SESSION_BINDING_PATTERN.test(value)
  ) {
    throw connectorError(
      "invalid_request",
      "A current HCN session binding is required.",
      400
    );
  }
  return value;
}

function normalizeCallbackSessionBinding(value) {
  try {
    return normalizeSessionBinding(value);
  } catch {
    throw invalidTransaction();
  }
}

function normalizeGoogleSubject(value) {
  if (
    typeof value !== "string"
    || !GOOGLE_SUBJECT_PATTERN.test(value)
  ) {
    throw new TypeError(
      "Google subject must be an exact immutable provider subject"
    );
  }
  return value;
}

function normalizeBeginGoogleSubject(value) {
  try {
    return normalizeGoogleSubject(value);
  } catch {
    throw connectorError(
      "invalid_request",
      "An immutable Google subject is required.",
      400
    );
  }
}

function normalizeCallbackGoogleSubject(value) {
  try {
    return normalizeGoogleSubject(value);
  } catch {
    throw invalidTransaction();
  }
}

function normalizeProviderError(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (
    typeof value !== "string"
    || !PROVIDER_ERROR_PATTERN.test(value)
  ) {
    throw invalidTransaction();
  }
  return value;
}

function boundedState(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_STATE_BYTES
    || /[\x00-\x20\x7f]/.test(value)
  ) {
    throw invalidTransaction();
  }
  return value;
}

function boundedCode(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_CODE_BYTES
    || !TOKEN_PATTERN.test(value)
  ) {
    throw invalidTransaction();
  }
  return value;
}

function boundedToken(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES
    || !TOKEN_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedConfigText(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_CONFIG_TEXT_BYTES
    || /[\x00-\x20\x7f]/.test(value)
  ) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function normalizeExpiresIn(value) {
  const seconds =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  if (
    !Number.isSafeInteger(seconds)
    || seconds < 1
    || seconds > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new TypeError("Google token expiration is invalid");
  }
  return seconds;
}

function normalizeGrantedScopes(value) {
  if (typeof value !== "string") {
    throw new TypeError("Google granted scopes are missing");
  }
  const scopes = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((scope) => {
      if (
        scope
          === "https://www.googleapis.com/auth/userinfo.email"
      ) {
        return "email";
      }
      if (
        scope
          === "https://www.googleapis.com/auth/userinfo.profile"
      ) {
        return "profile";
      }
      return scope;
    });
  if (
    scopes.length !== HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.length
    || new Set(scopes).size !== scopes.length
  ) {
    throw new TypeError("Google granted scopes are invalid");
  }
  return scopes;
}

function exactScopeSet(scopes) {
  const granted = new Set(scopes);
  return (
    granted.size === HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.length
    && HCN_GOOGLE_CONNECTOR_REQUIRED_SCOPES.every(
      (scope) => granted.has(scope)
    )
  );
}

function createPkceVerifier(randomBytes) {
  const bytes = readRandomBytes(randomBytes, PKCE_BYTES);
  const verifier = bytes.toString("base64url");
  return assertPkceVerifier(verifier);
}

function assertPkceVerifier(value) {
  if (
    typeof value !== "string"
    || !PKCE_VERIFIER_PATTERN.test(value)
  ) {
    throw invalidTransaction();
  }
  return value;
}

function pkceChallenge(verifier) {
  return createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
}

function createUniqueTransactionId(randomBytes, transactions) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const transactionId = readRandomBytes(
      randomBytes,
      TRANSACTION_ID_BYTES
    ).toString("base64url");
    if (
      TRANSACTION_ID_PATTERN.test(transactionId)
      && !transactions.has(transactionId)
    ) {
      return transactionId;
    }
  }
  throw connectorError(
    "temporarily_unavailable",
    "Google connection is temporarily unavailable.",
    503
  );
}

function readRandomBytes(randomBytes, length) {
  let value;
  try {
    value = randomBytes(length);
  } catch {
    throw connectorError(
      "temporarily_unavailable",
      "Google connection is temporarily unavailable.",
      503
    );
  }
  if (
    (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    || value.byteLength !== length
  ) {
    throw connectorError(
      "temporarily_unavailable",
      "Google connection is temporarily unavailable.",
      503
    );
  }
  return Buffer.from(value);
}

function hashSessionBinding(value) {
  return createHash("sha256")
    .update(BINDING_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest();
}

function safeEqual(left, right) {
  return (
    Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.byteLength === right.byteLength
    && timingSafeEqual(left, right)
  );
}

function purgeExpiredTransactions(transactions, timestamp) {
  for (const [transactionId, transaction] of transactions) {
    if (transaction.expiresAt <= timestamp) {
      transactions.delete(transactionId);
    }
  }
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw connectorError(
      "temporarily_unavailable",
      "Google connection is temporarily unavailable.",
      503
    );
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw connectorError(
      "temporarily_unavailable",
      "Google connection is temporarily unavailable.",
      503
    );
  }
  return timestamp;
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      throw new TypeError(`${label} contains an unsupported field`);
    }
  }
}

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === "string")
    && keys.length === expected.length
    && expected.every(
      (key) => Object.prototype.hasOwnProperty.call(value, key)
    )
  );
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIntegerRange(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer between ${minimum} and ${maximum}`
    );
  }
}

function invalidTransaction() {
  return connectorError(
    "invalid_request",
    "The Google connection request is invalid or expired.",
    400
  );
}

function connectorError(code, message, statusCode) {
  return new HcnGoogleConnectorOAuthError(
    code,
    message,
    statusCode
  );
}
