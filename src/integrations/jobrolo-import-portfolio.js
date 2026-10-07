import { createHash } from "node:crypto";
import { canonicalJson } from "./jobrolo-import-service-auth.js";

export const HCN_JOBROLO_PORTFOLIO_SCHEMA = "hcn.jobrolo.import-portfolio-grants.v1";
export const JOBROLO_PORTFOLIO_CATALOG_SCHEMA = "jobrolo.jobnimbus-import.portfolio-catalog.v1";
export const JOBROLO_PORTFOLIO_REQUEST_SCHEMA = "jobrolo.jobnimbus-import.portfolio-request.v1";
export const HCN_JOBROLO_PORTFOLIO_LIMITS = Object.freeze({ maximumFiles: 500, pageSize: 25,
  maximumLifetimeMs: 24 * 60 * 60_000, maximumConfigurationBytes: 128 * 1024 });

const GRANT = /^grant_[a-f0-9]{32}$/;
const CONNECTION = /^connection_[a-f0-9]{32}$/;
const SUBJECT = /^subject_[a-f0-9]{32}$/;
const PROVIDER = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fail() { const error = new Error("Reviewed portfolio admission is unavailable.");
  error.statusCode = 403; throw error; }
const instant = value => typeof value === "string" && ISO.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

export function resolveJobroloPortfolioGrant({ environment = {}, profile, tenantId, grantRef,
  referenceFactory, now = Date.now() } = {}) {
  if (environment.HCN_JOBROLO_IMPORT_PORTFOLIO_ENABLED !== "true") fail();
  const raw = String(environment.HCN_JOBROLO_IMPORT_PORTFOLIO_GRANTS_JSON || "");
  if (!raw || Buffer.byteLength(raw, "utf8") > HCN_JOBROLO_PORTFOLIO_LIMITS.maximumConfigurationBytes
    || !GRANT.test(String(grantRef || "")) || !profile?.ready || !tenantId
    || typeof referenceFactory?.subjectId !== "function" || !Number.isSafeInteger(now)) fail();
  let registry;
  try { registry = JSON.parse(raw); } catch { fail(); }
  if (!exact(registry, ["schema", "grants"]) || registry.schema !== HCN_JOBROLO_PORTFOLIO_SCHEMA
    || !Array.isArray(registry.grants) || registry.grants.length < 1 || registry.grants.length > 10) fail();
  const seen = new Set();
  const grants = registry.grants.map(value => {
    if (!exact(value, ["grantRef", "tenantId", "clientId", "connectionRef", "issuedAt", "expiresAt", "providerFileIds"])
      || !GRANT.test(value.grantRef) || seen.has(value.grantRef)
      || typeof value.tenantId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.tenantId)
      || typeof value.clientId !== "string" || !/^[A-Za-z0-9._-]{3,64}$/.test(value.clientId)
      || !CONNECTION.test(value.connectionRef) || !instant(value.issuedAt) || !instant(value.expiresAt)
      || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
      || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > HCN_JOBROLO_PORTFOLIO_LIMITS.maximumLifetimeMs
      || !Array.isArray(value.providerFileIds) || value.providerFileIds.length < 1
      || value.providerFileIds.length > HCN_JOBROLO_PORTFOLIO_LIMITS.maximumFiles
      || value.providerFileIds.some(id => typeof id !== "string" || !PROVIDER.test(id))
      || new Set(value.providerFileIds).size !== value.providerFileIds.length) fail();
    seen.add(value.grantRef);
    const providerFileIds = [...value.providerFileIds].sort();
    const grantDigest = createHash("sha256").update(canonicalJson({
      schema: HCN_JOBROLO_PORTFOLIO_SCHEMA, ...value, providerFileIds,
    }), "utf8").digest("hex");
    return { ...value, providerFileIds, grantDigest };
  });
  const matches = grants.filter(value => value.grantRef === grantRef && value.tenantId === tenantId
    && value.clientId === profile.clientId && value.connectionRef === profile.connectionRef);
  if (matches.length !== 1) fail();
  const grant = matches[0];
  if (Date.parse(grant.issuedAt) > now || Date.parse(grant.expiresAt) <= now) fail();
  const files = grant.providerFileIds.map(providerFileId => ({ providerFileId,
    sourceFileRef: referenceFactory.subjectId("jobnimbus", providerFileId) }))
    .sort((a, b) => a.sourceFileRef.localeCompare(b.sourceFileRef));
  if (files.some(file => !SUBJECT.test(file.sourceFileRef))
    || new Set(files.map(file => file.sourceFileRef)).size !== files.length) fail();
  return Object.freeze({ ...grant, providerFileIds: Object.freeze(grant.providerFileIds),
    files: Object.freeze(files.map(Object.freeze)),
    authorization: Object.freeze({ grantRef: grant.grantRef, grantDigest: grant.grantDigest, expiresAt: grant.expiresAt }) });
}

export function jobroloPortfolioPage(grant, afterRef = null) {
  if (afterRef !== null && !SUBJECT.test(afterRef)) fail();
  const index = afterRef === null ? -1 : grant.files.findIndex(file => file.sourceFileRef === afterRef);
  if (afterRef !== null && index < 0) fail();
  const files = grant.files.slice(index + 1, index + 1 + HCN_JOBROLO_PORTFOLIO_LIMITS.pageSize);
  return { files, afterRef, nextCursor: index + 1 + files.length < grant.files.length
    ? files[files.length - 1].sourceFileRef : null };
}

export function jobroloPortfolioSourceOwners(contact, users, referenceFactory) {
  if (!Array.isArray(contact?.owners) || !contact.owners.length || contact.owners.length > 50
    || !Array.isArray(users) || typeof referenceFactory?.sourceRecordRef !== "function") fail();
  const seen = new Set();
  return contact.owners.map(owner => {
    const id = String(owner?.id || owner?.jnid || "");
    if (!PROVIDER.test(id) || seen.has(id)) fail();
    seen.add(id);
    const matches = users.filter(user => String(user?.jnid || user?.id || user?.user_id || "") === id);
    if (matches.length !== 1) fail();
    const user = matches[0];
    const displayName = String(user.display_name || user.name
      || [user.first_name, user.last_name].filter(Boolean).join(" ")).trim();
    if (!displayName || displayName.length > 120 || /[\x00-\x1f\x7f]/.test(displayName)
      || Buffer.byteLength(displayName, "utf8") > 480) fail();
    const disabled = [user.is_active, user.active, user.enabled].some(value => value === false)
      || user.is_disabled === true || user.is_archived === true || user.deleted === true
      || [user.status, user.status_name, user.state].some(value =>
        ["inactive", "disabled", "archived", "deleted", "terminated"].includes(String(value || "").trim().toLowerCase()));
    const active = [user.is_active, user.active, user.enabled].some(value => value === true);
    const sourceUserRef = referenceFactory.sourceRecordRef("jobnimbus", id);
    if (!/^ref_[a-f0-9]{32}$/.test(sourceUserRef)) fail();
    return { sourceUserRef, displayName, isActive: disabled ? false : active ? true : null };
  }).sort((a, b) => a.sourceUserRef.localeCompare(b.sourceUserRef));
}
