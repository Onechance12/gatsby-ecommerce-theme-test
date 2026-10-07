import { createHash } from "node:crypto";
import { fetchBoundedJson } from "../http/bounded-json.js";
import {
  COMPANY_ROSTER_ROUTES, COMPANY_ROSTER_ROUTE,
  COMPANY_ROSTER_SESSION_ROUTE, COMPANY_ROSTER_SCOPE, COMPANY_ROSTER_SUBJECT
} from "../auth/hcn-company-roster-auth.js";
import { COMPANY_ROSTER_LIMITS } from "./company-roster.js";

export class CompanyRosterAttestationError extends Error {
  constructor() {
    super("Company roster attestation failed; no inventory was accepted.");
    this.code = "hcn_company_roster_attestation_failed";
  }
}

// This client does not load an installed Operator credential or alter its pins.
// The new grant has its own exact reviewed release, tenant, expiry and Keychain
// entry. A failed status is terminal: there is no retry or fallback endpoint.
export function createCompanyRosterClient({ profile, credential, fetchImpl = fetch, allowInsecureTestOrigin = false, now = Date.now }) {
  const fail = () => { throw new CompanyRosterAttestationError(); };
  if (!profile || profile.schema !== "hcn.company-roster-profile.v1"
    || !/^[a-f0-9]{40}$/.test(profile.expectedCommit || "")
    || !/^tenant_[a-f0-9]{16}$/.test(profile.tenantId || "")
    || !Number.isFinite(Date.parse(profile.grantExpiresAt))
    || Date.parse(profile.grantExpiresAt) <= now()
    || !/^[a-f0-9]{64}$/.test(credential || "")) fail();
  let base;
  try { base = new URL(profile.baseUrl); } catch { fail(); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || (base.origin !== "https://hcn-operations-platform.onrender.com"
      && !(allowInsecureTestOrigin && base.protocol === "http:" && base.hostname === "127.0.0.1"))) fail();
  const pinned = Object.freeze({ ...profile });
  const checkGrant = () => { if (Date.parse(pinned.grantExpiresAt) <= now()) fail(); };
  const checkBuild = build => {
    if (build?.service !== "hcn-operations-platform"
      || build.sourceCommit !== pinned.expectedCommit
      || build.sourceCommitTrust !== "provider_attested"
      || build.attested !== true) fail();
  };
  async function request(route, method) {
    checkGrant();
    try {
      return await fetchBoundedJson(fetchImpl, `${base.origin}${route}`, {
        method,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {})
      }, {
        timeoutMs: method === "POST" ? 60_000 : 15_000,
        maxBytes: method === "POST" ? COMPANY_ROSTER_LIMITS.maxResponseBytes : 64 * 1024,
        errorCode: "HCN_COMPANY_ROSTER_CLIENT_READ_FAILED"
      });
    } catch { fail(); }
  }
  async function verifySession() {
    const session = await request(COMPANY_ROSTER_SESSION_ROUTE, "GET");
    checkGrant();
    checkBuild(session?.build);
    const identity = session?.identity;
    if (session.schema !== "hcn.company-roster-session.v1"
      || session.ready !== true || session.readOnly !== true || session.externalWrites !== false
      || session.scope !== "configured_jobnimbus_account_metadata"
      || session.anchorVerification !== "existing_active_chance_jobnimbus_identity"
      || JSON.stringify(session.routes) !== JSON.stringify(COMPANY_ROSTER_ROUTES)
      || JSON.stringify(session.limits) !== JSON.stringify(COMPANY_ROSTER_LIMITS)
      || identity?.type !== "hcn_company_roster_token"
      || identity.subject !== COMPANY_ROSTER_SUBJECT
      || identity.role !== "company_roster_reader"
      || identity.tenantId !== pinned.tenantId
      || identity.grantExpiresAt !== pinned.grantExpiresAt
      || JSON.stringify(identity.scopes) !== JSON.stringify([COMPANY_ROSTER_SCOPE])) fail();
    return session;
  }
  async function readRoster() {
    await verifySession();
    const roster = await request(COMPANY_ROSTER_ROUTE, "POST");
    checkGrant();
    checkBuild(roster?.build);
    if (roster.schema !== "hcn.company-roster.v1"
      || roster.tenantId !== pinned.tenantId || roster.source !== "jobnimbus"
      || roster.scope !== "configured_jobnimbus_account_metadata"
      || roster.readOnly !== true || roster.externalWrites !== false
      || roster.ephemeral !== true || roster.complete !== true
      || !Array.isArray(roster.rows) || !Array.isArray(roster.owners)
      || roster.coverage?.ownerFilterApplied !== false
      || roster.coverage.statusFilterApplied !== false
      || roster.coverage.transactionalSnapshot !== false) fail();
    for (const [key, kind] of [["contacts", "contact"], ["jobs", "job"]]) {
      const proof = roster.coverage[key];
      const total = roster.rows.filter(row => row.sourceKind === kind).length;
      if (proof?.complete !== true || proof.endProof !== "empty_page_at_next_offset"
        || proof.records !== total || roster.totals?.[key] !== total
        || total > COMPANY_ROSTER_LIMITS.maxRecordsPerCollection) fail();
    }
    if (roster.rows.some(row => !["contact", "job"].includes(row.sourceKind))
      || new Set(roster.rows.map(row => `${row.sourceKind}:${row.sourceId}`)).size !== roster.rows.length
      || roster.inventorySha256 !== createHash("sha256").update(JSON.stringify(roster.rows)).digest("hex")) fail();
    return roster;
  }
  return Object.freeze({ verifySession, readRoster });
}
