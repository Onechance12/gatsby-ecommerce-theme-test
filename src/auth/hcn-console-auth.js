import {
  createHash,
  randomBytes as cryptographicRandomBytes
} from "node:crypto";

import {
  GOOGLE_PROVIDER_ENDPOINTS,
  fetchBoundedProviderJson,
  resolveGoogleProviderEndpoint
} from "./google-provider-http.js";
import {
  clearHcnLoginCookie,
  createHcnLoginCookie,
  createHcnSessionCookie,
  validateHcnReturnTo
} from "./hcn-console-http.js";

export const HCN_CONSOLE_AUTHORIZE_STATE_KIND =
  "hcn_console_authorize_state";

const CONSOLE_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile"
]);
const PKCE_BYTES = 64;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_STATE_BYTES = 8192;
const MAX_CODE_BYTES = 4096;
const MAX_PROVIDER_TOKEN_BYTES = 16 * 1024;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Coordinate the HCN console's Google sign-in without creating a second
 * callback URI or sharing the Custom GPT token-broker flow.
 *
 * The injected store is the only owner of one-shot transaction and browser
 * session state. The injected state codec may share the server's existing
 * authenticated-encryption implementation, but the state kind is distinct and
 * its payload is deliberately limited to a transaction id and expiration.
 */
export function createHcnConsoleOAuthCoordinator({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  store,
  sealState,
  openState,
  authenticateGoogleAccessToken,
  resolveApprovedUser,
  canonicalOrigin,
  allowTestProviderEndpoints = false,
  google = {}
} = {}) {
  assertFunction(fetchImpl, "fetchImpl");
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  assertStore(store);
  assertFunction(sealState, "sealState");
  assertFunction(openState, "openState");
  assertFunction(
    authenticateGoogleAccessToken,
    "authenticateGoogleAccessToken"
  );
  assertFunction(resolveApprovedUser, "resolveApprovedUser");

  const origin = normalizeCanonicalOrigin(canonicalOrigin);
  if (typeof allowTestProviderEndpoints !== "boolean") {
    throw new TypeError("allowTestProviderEndpoints must be a boolean");
  }
  const config = normalizeGoogleConfig(
    google,
    allowTestProviderEndpoints
  );
  const redirectUri = `${origin}/oauth/google/callback`;

  async function beginAuthorization({ returnTo = "/hcn" } = {}) {
    let safeReturnTo;
    try {
      safeReturnTo = validateHcnReturnTo(returnTo);
    } catch {
      throw oauthError(
        "invalid_request",
        "The requested console return path is invalid.",
        400
      );
    }

    const verifier = createPkceVerifier(randomBytes);
    let transaction;
    try {
      transaction = await store.createLoginTransaction({
        returnTo: safeReturnTo,
        pkceVerifier: verifier
      });
    } catch {
      throw oauthError(
        "temporarily_unavailable",
        "HCN console sign-in is temporarily unavailable.",
        503
      );
    }

    const transactionId = boundedOpaqueValue(
      transaction?.transactionId,
      "login transaction"
    );
    const bindingId = boundedOpaqueValue(
      transaction?.bindingId,
      "login binding"
    );
    const expiresAt = parseStoreExpiry(transaction?.expiresAt);
    const statePayload = Object.freeze({
      kind: HCN_CONSOLE_AUTHORIZE_STATE_KIND,
      transactionId,
      exp: expiresAt
    });

    let state;
    try {
      state = await sealState(statePayload);
    } catch {
      throw oauthError(
        "temporarily_unavailable",
        "HCN console sign-in is temporarily unavailable.",
        503
      );
    }
    state = boundedText(state, MAX_STATE_BYTES, "OAuth state");

    const authorizationUrl = new URL(config.authorizationUrl);
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", CONSOLE_SCOPES.join(" "));
    authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("access_type", "online");
    authorizationUrl.searchParams.set("prompt", config.prompt);
    authorizationUrl.searchParams.set("state", state);
    if (config.allowedDomain) {
      authorizationUrl.searchParams.set("hd", config.allowedDomain);
    }

    return Object.freeze({
      redirectUrl: authorizationUrl.toString(),
      setCookies: Object.freeze([createHcnLoginCookie(bindingId)])
    });
  }

  async function completeCallback({
    state,
    code = "",
    error = "",
    loginBinding
  } = {}) {
    const timestamp = readNow(now);
    const statePayload = await decodeConsoleState(openState, state);
    if (statePayload.exp <= timestamp) {
      throw oauthError(
        "invalid_request",
        "The HCN console sign-in request is invalid or expired.",
        400
      );
    }

    let transaction;
    try {
      transaction = await store.consumeLoginTransaction({
        transactionId: statePayload.transactionId,
        bindingId: String(loginBinding || "")
      });
    } catch {
      throw oauthError(
        "temporarily_unavailable",
        "HCN console sign-in is temporarily unavailable.",
        503
      );
    }
    if (!transaction) {
      throw oauthError(
        "invalid_request",
        "The HCN console sign-in request is invalid or expired.",
        400
      );
    }

    const transactionExpiry = parseStoreExpiry(transaction.expiresAt);
    if (
      transactionExpiry !== statePayload.exp ||
      transactionExpiry <= timestamp
    ) {
      throw oauthError(
        "invalid_request",
        "The HCN console sign-in request is invalid or expired.",
        400
      );
    }
    const verifier = assertPkceVerifier(transaction.pkceVerifier);
    const returnTo = assertStoredReturnPath(transaction.returnTo);

    if (error) {
      throw oauthError(
        "access_denied",
        "Google sign-in was not completed.",
        401
      );
    }
    const authorizationCode = boundedText(
      code,
      MAX_CODE_BYTES,
      "authorization code"
    );

    const tokens = await exchangeGoogleCode({
      fetchImpl,
      config,
      redirectUri,
      code: authorizationCode,
      verifier
    });
    const identity = await authenticateCurrentApprovedIdentity({
      authenticateGoogleAccessToken,
      resolveApprovedUser,
      fetchImpl,
      config,
      accessToken: tokens.accessToken
    });

    let session;
    try {
      session = await store.createSession({
        subject: identity.subject,
        googleSubject: identity.googleSubject,
        role: identity.role
      });
    } catch {
      throw oauthError(
        "temporarily_unavailable",
        "HCN console sign-in is temporarily unavailable.",
        503
      );
    }
    const sessionId = boundedOpaqueValue(
      session?.sessionId,
      "browser session"
    );

    // Only the opaque HttpOnly session id crosses the coordinator boundary.
    // The store retains its non-enumerable CSRF token for the session endpoint.
    return Object.freeze({
      redirectPath: returnTo,
      setCookies: Object.freeze([
        clearHcnLoginCookie(),
        createHcnSessionCookie(sessionId)
      ])
    });
  }

  return Object.freeze({
    beginAuthorization,
    completeCallback
  });
}

export class HcnConsoleOAuthError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "HcnConsoleOAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function decodeConsoleState(openState, sealedState) {
  const encoded = boundedText(
    sealedState,
    MAX_STATE_BYTES,
    "OAuth state"
  );
  let payload;
  try {
    payload = await openState(encoded);
  } catch {
    throw oauthError(
      "invalid_request",
      "The HCN console sign-in request is invalid or expired.",
      400
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !hasExactKeys(payload, ["kind", "transactionId", "exp"]) ||
    payload.kind !== HCN_CONSOLE_AUTHORIZE_STATE_KIND ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp < 0
  ) {
    throw oauthError(
      "invalid_request",
      "The HCN console sign-in request is invalid or expired.",
      400
    );
  }
  return Object.freeze({
    kind: payload.kind,
    transactionId: assertStateOpaqueValue(
      payload.transactionId,
      "login transaction"
    ),
    exp: payload.exp
  });
}

async function exchangeGoogleCode({
  fetchImpl,
  config,
  redirectUri,
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
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier
      })
      }
    );
  } catch {
    throw oauthError(
      "temporarily_unavailable",
      "Google sign-in is temporarily unavailable.",
      503
    );
  }

  const response = providerResult.response;
  const payload = providerResult.payload;
  if (!response.ok || !payload || typeof payload !== "object") {
    throw oauthError(
      "access_denied",
      "Google sign-in could not be completed.",
      401
    );
  }
  let accessToken;
  try {
    accessToken = boundedText(
      payload.access_token,
      MAX_PROVIDER_TOKEN_BYTES,
      "Google access token"
    );
  } catch {
    throw oauthError(
      "access_denied",
      "Google sign-in could not be completed.",
      401
    );
  }
  return Object.freeze({ accessToken });
}

async function authenticateCurrentApprovedIdentity({
  authenticateGoogleAccessToken,
  resolveApprovedUser,
  fetchImpl,
  config,
  accessToken
}) {
  let resolution = null;
  let resolverCalls = 0;
  let identity;
  try {
    identity = await authenticateGoogleAccessToken({
      token: accessToken,
      clientId: config.clientId,
      tokenInfoUrl: config.tokenInfoUrl,
      userInfoUrl: config.userInfoUrl,
      allowedDomain: config.allowedDomain,
      allowTestProviderEndpoints:
        config.allowTestProviderEndpoints,
      resolveUser: async (candidate) => {
        resolverCalls += 1;
        if (resolverCalls !== 1) {
          throw oauthError(
            "access_denied",
            "This Google account is not approved for the HCN console.",
            403
          );
        }
        const safeCandidate = normalizeGoogleCandidate(candidate);
        const approved = await resolveApprovedUser(safeCandidate);
        resolution = { candidate: safeCandidate, approved };
        return approved;
      },
      fetchImpl
    });
  } catch (error) {
    if (error instanceof HcnConsoleOAuthError) throw error;
    const statusCode = Number(error?.statusCode) === 403 ? 403 : 401;
    throw oauthError(
      "access_denied",
      "This Google account is not approved for the HCN console.",
      statusCode
    );
  }

  if (!resolution || resolverCalls !== 1) {
    throw oauthError(
      "access_denied",
      "This Google account is not approved for the HCN console.",
      403
    );
  }
  return normalizeApprovedIdentity(
    identity,
    resolution.candidate,
    resolution.approved,
    config.allowedDomain
  );
}

function normalizeGoogleCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw oauthError(
      "access_denied",
      "This Google account is not approved for the HCN console.",
      403
    );
  }
  return Object.freeze({
    subject: boundedIdentityValue(value.subject, "Google subject"),
    email: normalizeEmail(value.email),
    name: boundedIdentityValue(
      value.name || value.email,
      "Google display name"
    ),
    hostedDomain: normalizeDomain(value.hostedDomain)
  });
}

function normalizeApprovedIdentity(
  identity,
  candidate,
  approved,
  allowedDomain
) {
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    identity.type !== "google_oauth" ||
    !approved ||
    typeof approved !== "object" ||
    Array.isArray(approved) ||
    approved.enabled === false
  ) {
    throw oauthError(
      "access_denied",
      "This Google account is not approved for the HCN console.",
      403
    );
  }

  const subject = boundedIdentityValue(
    identity.subject,
    "Google subject"
  );
  const email = normalizeEmail(identity.email);
  const hostedDomain = normalizeDomain(identity.hostedDomain);
  const approvedEmail = normalizeEmail(approved.email);
  const role = normalizeRole(approved.role);
  const identityRole = normalizeRole(identity.role);
  const approvedSubject = boundedIdentityValue(
    approved.googleSubject || approved.subject,
    "approved subject"
  );

  if (
    subject !== candidate.subject ||
    email !== candidate.email ||
    approvedEmail !== candidate.email ||
    hostedDomain !== candidate.hostedDomain ||
    identityRole !== role ||
    approvedSubject !== subject ||
    (allowedDomain &&
      hostedDomain !== String(allowedDomain).trim().toLowerCase())
  ) {
    throw oauthError(
      "access_denied",
      "This Google account is not approved for the HCN console.",
      403
    );
  }

  // The currently approved email is the internal session subject so every
  // request can re-check the live approval registry. The session store keeps
  // it non-enumerable; provider tokens, codes, PKCE data, scopes, and client
  // data cannot enter the browser-visible session projection.
  return Object.freeze({
    subject: approvedEmail,
    googleSubject: subject,
    role
  });
}

function normalizeGoogleConfig(
  google,
  allowTestProviderEndpoints
) {
  if (!google || typeof google !== "object" || Array.isArray(google)) {
    throw new TypeError("google must be a configuration object");
  }
  const clientId = requiredConfigText(google.clientId, "Google client id");
  const clientSecret = requiredConfigText(
    google.clientSecret,
    "Google client secret"
  );
  const allowedDomain = String(google.allowedDomain || "")
    .trim()
    .toLowerCase();
  if (
    allowedDomain &&
    (!/^[a-z0-9.-]+$/.test(allowedDomain) ||
      allowedDomain.startsWith(".") ||
      allowedDomain.endsWith("."))
  ) {
    throw new TypeError("Google allowed domain is invalid");
  }
  const prompt = String(google.prompt || "select_account").trim();
  if (prompt !== "select_account" && prompt !== "consent") {
    throw new TypeError(
      "Google prompt must be select_account or consent"
    );
  }
  return Object.freeze({
    clientId,
    clientSecret,
    allowedDomain,
    prompt,
    allowTestProviderEndpoints,
    authorizationUrl: resolveGoogleProviderEndpoint(
      "authorize",
      google.authorizationUrl ||
        GOOGLE_PROVIDER_ENDPOINTS.authorize,
      { allowLoopbackForTests: allowTestProviderEndpoints }
    ),
    tokenUrl: resolveGoogleProviderEndpoint(
      "token",
      google.tokenUrl || GOOGLE_PROVIDER_ENDPOINTS.token,
      { allowLoopbackForTests: allowTestProviderEndpoints }
    ),
    tokenInfoUrl: resolveGoogleProviderEndpoint(
      "tokenInfo",
      google.tokenInfoUrl ||
        GOOGLE_PROVIDER_ENDPOINTS.tokenInfo,
      { allowLoopbackForTests: allowTestProviderEndpoints }
    ),
    userInfoUrl: resolveGoogleProviderEndpoint(
      "userInfo",
      google.userInfoUrl ||
        GOOGLE_PROVIDER_ENDPOINTS.userInfo,
      { allowLoopbackForTests: allowTestProviderEndpoints }
    )
  });
}

function normalizeCanonicalOrigin(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("canonicalOrigin must be configured");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("canonicalOrigin must be an absolute origin");
  }
  if (
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("canonicalOrigin must be an exact origin");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname
  );
  if (parsed.protocol !== "https:" && !loopback) {
    throw new TypeError(
      "canonicalOrigin must use HTTPS outside loopback development"
    );
  }
  return parsed.origin;
}

function createPkceVerifier(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(PKCE_BYTES);
  } catch {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is temporarily unavailable.",
      503
    );
  }
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) ||
    bytes.byteLength !== PKCE_BYTES
  ) {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is temporarily unavailable.",
      503
    );
  }
  return Buffer.from(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function assertPkceVerifier(value) {
  if (
    typeof value !== "string" ||
    !PKCE_VERIFIER_PATTERN.test(value)
  ) {
    throw oauthError(
      "invalid_request",
      "The HCN console sign-in request is invalid or expired.",
      400
    );
  }
  return value;
}

function assertStoredReturnPath(value) {
  try {
    return validateHcnReturnTo(value);
  } catch {
    throw oauthError(
      "invalid_request",
      "The HCN console sign-in request is invalid or expired.",
      400
    );
  }
}

function parseStoreExpiry(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is temporarily unavailable.",
      503
    );
  }
  return timestamp;
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is temporarily unavailable.",
      503
    );
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is temporarily unavailable.",
      503
    );
  }
  return timestamp;
}

function boundedOpaqueValue(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw oauthError(
      "temporarily_unavailable",
      `${label} could not be created.`,
      503
    );
  }
  return value;
}

function assertStateOpaqueValue(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw oauthError(
      "invalid_request",
      "The HCN console sign-in request is invalid or expired.",
      400
    );
  }
  return value;
}

function boundedText(value, maxBytes, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw oauthError(
      "invalid_request",
      `${label} is missing or invalid.`,
      400
    );
  }
  return value;
}

function boundedIdentityValue(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw oauthError(
      "access_denied",
      `${label} is invalid.`,
      403
    );
  }
  return value;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (
    !email ||
    email.length > 320 ||
    !email.includes("@") ||
    /[\u0000-\u0020\u007f]/u.test(email)
  ) {
    throw oauthError(
      "access_denied",
      "Google account identity is invalid.",
      403
    );
  }
  return email;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !/^[a-z0-9.-]+$/.test(domain)
  ) {
    throw oauthError(
      "access_denied",
      "Google account identity is invalid.",
      403
    );
  }
  return domain;
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!ROLE_PATTERN.test(role)) {
    throw oauthError(
      "access_denied",
      "This Google account has no supported HCN console role.",
      403
    );
  }
  return role;
}

function requiredConfigText(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is not configured`);
  }
  return value.trim();
}

function assertStore(store) {
  if (!store || typeof store !== "object") {
    throw new TypeError("store must be configured");
  }
  for (const name of [
    "createLoginTransaction",
    "consumeLoginTransaction",
    "createSession"
  ]) {
    assertFunction(store[name], `store.${name}`);
  }
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function oauthError(code, message, statusCode) {
  return new HcnConsoleOAuthError(code, message, statusCode);
}
