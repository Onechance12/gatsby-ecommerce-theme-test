import {
  fetchBoundedProviderJson,
  resolveGoogleProviderEndpoint
} from "./google-provider-http.js";

export const WAVE_ROLE_POLICIES = {
  chance: { allRoutes: true },
  administrator: { allRoutes: true },
  employee: { allRoutes: true },
  onboarding: {
    allowedRoutes: [
      "GET /auth/whoami",
      "GET /api/v1/session",
      "POST /auth/quo-line"
    ]
  },
  client_coordinator: {
    allowedRoutes: [
      "GET /auth/whoami",
      "GET /api/v1/session",
      "POST /auth/quo-line",
      "POST /brain/context",
      "POST /memory/file-actions",
      "POST /jobnimbus/search",
      "POST /jobnimbus/document-review",
      "POST /jobnimbus/document-file",
      "POST /jobnimbus/photo-review",
      "POST /gmail/search",
      "POST /gmail/thread",
      "POST /gmail/attachment-review",
      "POST /scheduling/availability",
      "POST /quo/history",
      "POST /quo/transcript",
      "POST /retell/client-coordinator-call",
      "POST /retell/client-coordinator-call-result"
    ]
  },
  manager: {
    allowedRoutes: [
      "GET /auth/whoami",
      "GET /api/v1/session",
      "POST /auth/quo-line",
      "POST /brain/context",
      "POST /memory/file-actions",
      "POST /jobnimbus/search",
      "POST /jobnimbus/document-review",
      "POST /jobnimbus/document-file",
      "POST /jobnimbus/photo-review",
      "POST /gmail/search",
      "POST /gmail/thread",
      "POST /gmail/attachment-review",
      "POST /scheduling/availability",
      "POST /quo/history",
      "POST /quo/transcript"
    ]
  }
};

export const CODEX_OPERATOR_ALLOWED_ROUTES = new Set([
  "GET /auth/whoami",
  "GET /api/v1/session",
  "POST /ops/start-session",
  "POST /ops/review-chance-files",
  "POST /ops/action-batch",
  "POST /scheduling/availability",
  "POST /jobnimbus/search",
  "POST /jobnimbus/review-file",
  "POST /jobnimbus/document-text",
  "POST /jobnimbus/document-review",
  "POST /jobnimbus/document-file",
  "POST /gmail/search",
  "POST /gmail/thread",
  "POST /gmail/attachment-review",
  "POST /quo/numbers",
  "POST /quo/history",
  "POST /quo/transcript"
]);

export const HCN_BROWSER_ALLOWED_ROUTES = new Set([
  "GET /api/v1/session",
  "GET /hcn/auth/session",
  "POST /hcn/auth/logout",
  "POST /hcn/api/v1/work-center",
  "POST /hcn/api/v1/file-review"
]);

export const HCN_BROWSER_CHANCE_ONLY_ROUTES = new Set([
  "POST /hcn/api/v1/work-center",
  "POST /hcn/api/v1/file-review"
]);

export function parseWaveUsers(raw, defaults = []) {
  const users = new Map();
  for (const entry of defaults) addUser(users, entry);
  const text = String(raw || "").trim();
  if (!text) return users;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("WAVE_AUTH_USERS_JSON must be valid JSON");
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) addUser(users, entry);
  } else if (parsed && typeof parsed === "object") {
    for (const [email, settings] of Object.entries(parsed)) {
      addUser(users, { email, ...(settings && typeof settings === "object" ? settings : {}) });
    }
  } else {
    throw new Error("WAVE_AUTH_USERS_JSON must be an object or array");
  }
  return users;
}

export function hcnConsoleChanceUserConfigured(users, chanceEmail) {
  if (!(users instanceof Map)) return false;
  const email = String(chanceEmail || "").trim().toLowerCase();
  if (!email) return false;
  const user = users.get(email);
  return Boolean(
    user
    && user.enabled !== false
    && user.role === "chance"
    && user.googleSubject
  );
}

export function hcnConsoleSessionMatchesApprovedUser(session, user) {
  return Boolean(
    session
    && user
    && user.enabled !== false
    && session.role === user.role
    && session.googleSubject
    && user.googleSubject
    && session.googleSubject === user.googleSubject
  );
}

export async function authenticateGoogleAccessToken({
  token,
  clientId,
  tokenInfoUrl = "https://www.googleapis.com/oauth2/v2/tokeninfo",
  userInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo",
  allowedDomain,
  users,
  resolveUser,
  allowTestProviderEndpoints = false,
  fetchImpl = fetch
}) {
  const accessToken = String(token || "").trim();
  if (!accessToken) throw authError("Missing Google OAuth access token", 401);
  if (!clientId) throw authError("Google OAuth client id is not configured", 503);

  const safeTokenInfoUrl = resolveGoogleProviderEndpoint(
    "tokenInfo",
    tokenInfoUrl,
    { allowLoopbackForTests: allowTestProviderEndpoints }
  );
  const safeUserInfoUrl = resolveGoogleProviderEndpoint(
    "userInfo",
    userInfoUrl,
    { allowLoopbackForTests: allowTestProviderEndpoints }
  );
  const tokenUrl = new URL(safeTokenInfoUrl);
  tokenUrl.searchParams.set("access_token", accessToken);
  let tokenResult;
  let userResult;
  try {
    [tokenResult, userResult] = await Promise.all([
      fetchBoundedProviderJson(fetchImpl, tokenUrl, {
        headers: { accept: "application/json" }
      }),
      fetchBoundedProviderJson(fetchImpl, safeUserInfoUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json"
        }
      })
    ]);
  } catch {
    throw authError("Google OAuth token validation failed", 401);
  }
  const tokenResponse = tokenResult.response;
  const userResponse = userResult.response;
  const tokenInfo = tokenResult.payload;
  const profile = userResult.payload;
  if (!tokenResponse.ok || !userResponse.ok) throw authError("Google OAuth token validation failed", 401);

  const audience = String(tokenInfo.audience || tokenInfo.aud || tokenInfo.issued_to || "");
  if (audience !== clientId) throw authError("Google OAuth token was issued to a different application", 401);
  if (Number(tokenInfo.expires_in || 0) <= 0) throw authError("Google OAuth token is expired", 401);

  const subject = String(profile.sub || tokenInfo.user_id || "").trim();
  const email = String(profile.email || tokenInfo.email || "").trim().toLowerCase();
  const verified = profile.email_verified === true || tokenInfo.verified_email === true || tokenInfo.verified_email === "true";
  const hostedDomain = String(profile.hd || "").trim().toLowerCase();
  if (!subject || !email || !verified) throw authError("Google account identity could not be verified", 403);
  if (allowedDomain && hostedDomain !== String(allowedDomain).trim().toLowerCase()) {
    throw authError("Google account is outside the approved Workspace domain", 403);
  }

  let user = users instanceof Map ? users.get(email) : null;
  if (!user && typeof resolveUser === "function") {
    user = await resolveUser({ email, name: String(profile.name || email).trim(), subject, hostedDomain });
  }
  if (!user || user.enabled === false) throw authError("This Google account is not approved for the Wave Ops bridge", 403);
  const role = String(user.role || "").trim().toLowerCase();
  if (!WAVE_ROLE_POLICIES[role]) throw authError("This employee has an unsupported Wave Ops role", 403);
  let approvedGoogleSubject;
  try {
    approvedGoogleSubject = configuredGoogleSubject(user);
  } catch {
    throw authError("This Google account is not approved for the Wave Ops bridge", 403);
  }
  if (approvedGoogleSubject && approvedGoogleSubject !== subject) {
    throw authError("This Google account is not approved for the Wave Ops bridge", 403);
  }

  return {
    type: "google_oauth",
    subject,
    email,
    name: user.name || profile.name || email,
    role,
    hostedDomain,
    scopes: String(tokenInfo.scope || "").split(/\s+/).filter(Boolean),
    googleAccessToken: accessToken,
    jobNimbusOwnerId: String(user.jobNimbusOwnerId || ""),
    jobNimbusScope: String(user.jobNimbusScope || defaultJobNimbusScope(role)),
    quoLineId: String(user.quoLineId || ""),
    enabled: true
  };
}

export function routeAllowed(identity, method, pathname) {
  if (!identity) return false;
  const route = `${String(method || "").toUpperCase()} ${pathname}`;
  if (HCN_BROWSER_CHANCE_ONLY_ROUTES.has(route)) {
    return identity.type === "hcn_browser_session" && identity.role === "chance";
  }
  if (identity.type === "bridge_token") {
    return route !== "GET /api/v1/session";
  }
  if (identity.type === "codex_operator_token") {
    return identity.role === "codex_operator"
      && CODEX_OPERATOR_ALLOWED_ROUTES.has(route);
  }
  if (identity.type === "hcn_browser_session") {
    return Boolean(WAVE_ROLE_POLICIES[identity.role])
      && HCN_BROWSER_ALLOWED_ROUTES.has(route);
  }
  const policy = WAVE_ROLE_POLICIES[identity.role];
  if (!policy) return false;
  if (policy.allRoutes) return true;
  return policy.allowedRoutes.includes(route);
}

export function publicIdentity(identity) {
  if (!identity) return null;
  return {
    type: identity.type,
    subject: identity.subject || "",
    email: identity.email || "",
    name: identity.name || "",
    role: identity.role || "",
    hostedDomain: identity.hostedDomain || "",
    scopes: identity.scopes || [],
    jobNimbusOwnerId: identity.jobNimbusOwnerId || "",
    jobNimbusScope: identity.jobNimbusScope || "",
    quoLineConfigured: Boolean(identity.quoLineId)
  };
}

function addUser(users, entry = {}) {
  const email = String(entry.email || "").trim().toLowerCase();
  if (!email) return;
  const role = String(entry.role || "").trim().toLowerCase();
  if (!WAVE_ROLE_POLICIES[role]) throw new Error(`Unsupported Wave Ops role for ${email}: ${role || "missing"}`);
  const existing = users.get(email);
  const hasConfiguredSubject = Object.hasOwn(entry, "googleSubject")
    || Object.hasOwn(entry, "subject");
  users.set(email, {
    email,
    name: String(entry.name || email).trim(),
    role,
    enabled: entry.enabled !== false,
    jobNimbusOwnerId: String(entry.jobNimbusOwnerId || "").trim(),
    jobNimbusScope: String(entry.jobNimbusScope || defaultJobNimbusScope(role)).trim(),
    quoLineId: String(entry.quoLineId || "").trim(),
    googleSubject: hasConfiguredSubject
      ? configuredGoogleSubject(entry)
      : String(existing?.googleSubject || "")
  });
}

function configuredGoogleSubject(entry) {
  const hasGoogleSubject = Object.hasOwn(entry, "googleSubject");
  const hasSubjectAlias = Object.hasOwn(entry, "subject");
  const googleSubject = hasGoogleSubject
    ? normalizeConfiguredGoogleSubject(entry.googleSubject)
    : "";
  const subjectAlias = hasSubjectAlias
    ? normalizeConfiguredGoogleSubject(entry.subject)
    : "";
  if (googleSubject && subjectAlias && googleSubject !== subjectAlias) {
    throw new Error("Configured Google subject aliases do not match");
  }
  return googleSubject || subjectAlias;
}

function normalizeConfiguredGoogleSubject(value) {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9._~-]{1,255}$/.test(value)
  ) {
    throw new Error("Configured Google subject is invalid");
  }
  return value;
}

function defaultJobNimbusScope(role) {
  return role === "chance" ? "assigned" : "company";
}

function authError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
