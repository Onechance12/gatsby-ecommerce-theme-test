import { createHash, timingSafeEqual } from "node:crypto";

export const COMPANY_ROSTER_SUBJECT = "codex-mac-company-roster";
export const COMPANY_ROSTER_SCOPE = "company_roster:read";
export const COMPANY_ROSTER_SESSION_ROUTE = "/hcn/api/v1/company-roster-session";
export const COMPANY_ROSTER_ROUTE = "/hcn/api/v1/company-roster";
export const COMPANY_ROSTER_ROUTES = Object.freeze([
  `GET ${COMPANY_ROSTER_SESSION_ROUTE}`,
  `POST ${COMPANY_ROSTER_ROUTE}`
]);

export function isCompanyRosterIdentity(identity, now = Date.now()) {
  return Boolean(identity
    && identity.type === "hcn_company_roster_token"
    && identity.subject === COMPANY_ROSTER_SUBJECT
    && identity.role === "company_roster_reader"
    && /^tenant_[a-f0-9]{16}$/.test(identity.tenantId || "")
    && Number.isFinite(Date.parse(identity.grantExpiresAt))
    && Date.parse(identity.grantExpiresAt) > now
    && Array.isArray(identity.scopes)
    && identity.scopes.length === 1
    && identity.scopes[0] === COMPANY_ROSTER_SCOPE);
}

// This new credential is not an upgrade to any installed Operator identity.
// It is default-off, tenant-bound, expiring, and has exactly two metadata routes.
export function createCompanyRosterAuthenticator(env = {}, { now = Date.now } = {}) {
  if (env.HCN_COMPANY_ROSTER_ENABLED !== "true") return () => null;
  const hash = String(env.HCN_COMPANY_ROSTER_TOKEN_SHA256 || "");
  const tenantId = String(env.HCN_COMPANY_ROSTER_TENANT_ID || "");
  const grantExpiresAt = String(env.HCN_COMPANY_ROSTER_EXPIRES_AT || "");
  if (!/^[a-f0-9]{64}$/.test(hash)
    || !/^tenant_[a-f0-9]{16}$/.test(tenantId)
    || tenantId !== env.HCN_TENANT_ID
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(grantExpiresAt)
    || !Number.isFinite(Date.parse(grantExpiresAt))
    || new Date(Date.parse(grantExpiresAt)).toISOString() !== grantExpiresAt) {
    throw new Error("The company roster grant must have a digest, exact HCN tenant, and finite UTC expiry.");
  }
  const credentialKeys = [
    "CODEX_OPERATOR_TOKEN", "CODEX_MAC_OPERATOR_TOKEN", "JOBNIMBUS_BRIDGE_TOKEN",
    "JOBNIMBUS_API_KEY", "HCN_JOBROLO_SHARED_SECRET", "HCN_JOBROLO_IMPORT_SHARED_SECRET",
    "HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET", "HCN_JOBROLO_CLAIM_FILING_SHARED_SECRET",
    "QUO_API_KEY", "GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_SECRET", "HCN_GOOGLE_CLIENT_SECRET",
    "HCN_REFERENCE_KEY", "HCN_GOOGLE_GRANT_KEY", "OAUTH_SESSION_SECRET",
    "OPENAI_API_KEY", "RETELL_API_KEY", "TWILIO_AUTH_TOKEN"
  ];
  if (hash === env.HCN_MANAGEMENT_REPORT_TOKEN_SHA256
    || credentialKeys.some(key => env[key]
      && createHash("sha256").update(env[key]).digest("hex") === hash)) {
    throw new Error("The company roster credential must be isolated from existing credentials.");
  }
  for (const key of [
    "HCN_JOBROLO_ADDITIONAL_PROFILES_JSON", "HCN_JOBROLO_IMPORT_ADDITIONAL_PROFILES_JSON",
    "HCN_JOBROLO_NOTE_WRITEBACK_ADDITIONAL_PROFILES_JSON", "HCN_JOBROLO_CLAIM_FILING_ADDITIONAL_PROFILES_JSON"
  ]) {
    if (!env[key]) continue;
    let registry;
    try { registry = JSON.parse(env[key]); }
    catch { throw new Error("The company roster credential isolation check is unavailable."); }
    if (Array.isArray(registry?.profiles) && registry.profiles.some(profile =>
      typeof profile?.sharedSecret === "string"
      && createHash("sha256").update(profile.sharedSecret).digest("hex") === hash)) {
      throw new Error("The company roster credential must be isolated from existing credentials.");
    }
  }
  const expected = Buffer.from(hash, "hex");
  return token => {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), expected)) return null;
    const identity = {
      type: "hcn_company_roster_token",
      subject: COMPANY_ROSTER_SUBJECT,
      role: "company_roster_reader",
      tenantId,
      grantExpiresAt,
      scopes: [COMPANY_ROSTER_SCOPE]
    };
    return isCompanyRosterIdentity(identity, now()) ? identity : null;
  };
}
