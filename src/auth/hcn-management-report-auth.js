import { createHash, timingSafeEqual } from "node:crypto";

export const MANAGEMENT_REPORT_SUBJECT = "codex-mac-management-report";
export const MANAGEMENT_REPORT_SCOPE = "management_sweep:read";
export const MANAGEMENT_REPORT_SESSION_ROUTE = "/hcn/api/v1/management-report-session";
export const MANAGEMENT_REPORT_ROUTES = Object.freeze([
  `GET ${MANAGEMENT_REPORT_SESSION_ROUTE}`,
  "POST /hcn/api/v1/management-sweep"
]);

export function isManagementReportIdentity(identity) {
  return Boolean(identity
    && identity.type === "hcn_management_report_token"
    && identity.subject === MANAGEMENT_REPORT_SUBJECT
    && identity.role === "management_report_reader"
    && Array.isArray(identity.scopes)
    && identity.scopes.length === 1
    && identity.scopes[0] === MANAGEMENT_REPORT_SCOPE);
}

// Separate, opt-in report credential. It never grants file reads or effects,
// and never falls back to either operational credential or the shared token.
export function createManagementReportAuthenticator(env = {}) {
  const hash = String(env.HCN_MANAGEMENT_REPORT_TOKEN_SHA256 || "").trim();
  if (!hash) return () => null;
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("HCN_MANAGEMENT_REPORT_TOKEN_SHA256 must be a SHA-256 digest.");
  }
  for (const name of ["CODEX_OPERATOR_TOKEN", "CODEX_MAC_OPERATOR_TOKEN", "JOBNIMBUS_BRIDGE_TOKEN"]) {
    if (env[name] && createHash("sha256").update(env[name]).digest("hex") === hash) {
      throw new Error("The management report credential must be isolated from operational credentials.");
    }
  }
  const expected = Buffer.from(hash, "hex");
  return token => {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), expected)) return null;
    return {
      type: "hcn_management_report_token",
      subject: MANAGEMENT_REPORT_SUBJECT,
      role: "management_report_reader",
      scopes: [MANAGEMENT_REPORT_SCOPE]
    };
  };
}
