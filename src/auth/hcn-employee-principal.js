import { createHash } from "node:crypto";

export const HCN_EMPLOYEE_PRINCIPAL_SCHEMA =
  "hcn.employee-principal.v1";
export const HCN_EMPLOYEE_AUTHORIZATION_BINDING_SCHEMA =
  "hcn.employee-authorization-binding.v1";
export const HCN_EMPLOYEE_BROWSER_PROFILE_SCHEMA =
  "hcn.employee-browser-profile.v1";

export const HCN_EMPLOYEE_PRINCIPAL_SOURCES = Object.freeze([
  "explicit",
  "auto_enrolled"
]);

export const HCN_EMPLOYEE_ROLES = Object.freeze([
  "employee",
  "client_coordinator",
  "manager",
  "administrator",
  "chance"
]);

export const HCN_EMPLOYEE_JOBNIMBUS_SCOPES = Object.freeze([
  "assigned",
  "company"
]);

const SOURCE_SET = new Set(HCN_EMPLOYEE_PRINCIPAL_SOURCES);
const ROLE_SET = new Set(HCN_EMPLOYEE_ROLES);
const JOBNIMBUS_SCOPE_SET =
  new Set(HCN_EMPLOYEE_JOBNIMBUS_SCOPES);
const COMPANY_SCOPE_ROLES = new Set([
  "manager",
  "administrator",
  "chance"
]);

const INPUT_FIELDS = Object.freeze([
  "email",
  "name",
  "enabled",
  "role",
  "googleSubject",
  "jobNimbusOwnerId",
  "jobNimbusScope"
]);
const PRINCIPAL_FIELDS = Object.freeze([
  "schemaVersion",
  "source",
  "email",
  "displayName",
  "enabled",
  "role",
  "googleSubject",
  "jobNimbusOwnerId",
  "jobNimbusScope",
  "authorizationVersion"
]);
const AUTHORIZATION_BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "email",
  "googleSubject",
  "authorizationVersion"
]);
const BROWSER_PROFILE_FIELDS = Object.freeze([
  "schemaVersion",
  "displayName",
  "role",
  "jobNimbusScope"
]);

const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const PROVIDER_OWNER_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const AUTHORIZATION_VERSION_PATTERN = /^authz_v1_[a-f0-9]{64}$/;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const AUTHORIZATION_HASH_CONTEXT =
  "hcn-employee-principal:authorization:v1";
const DEFAULT_ALLOWED_DOMAIN = "wavepa.com";
const MAX_EMAIL_BYTES = 254;
const MAX_DISPLAY_NAME_CHARACTERS = 120;

/**
 * Normalize an explicitly provisioned HCN employee.
 *
 * Explicit provisioning may grant company scope only to the reviewed
 * management roles. Omitting role and scope always produces the least
 * privileged ordinary employee: employee + assigned.
 */
export function normalizeExplicitHcnEmployeePrincipal(
  input,
  options = {}
) {
  return normalizePrincipal(input, {
    ...normalizeOptions(options),
    source: "explicit",
    autoEnrollment: false
  });
}

/**
 * Normalize a first-use employee enrollment.
 *
 * Auto-enrollment can never assign a management role or company scope. A
 * caller may provide the defaults explicitly, but any attempted escalation
 * fails closed.
 */
export function normalizeAutoEnrolledHcnEmployeePrincipal(
  input,
  options = {}
) {
  return normalizePrincipal(input, {
    ...normalizeOptions(options),
    source: "auto_enrolled",
    autoEnrollment: true
  });
}

/**
 * Validate an already-normalized principal with exact keys and a current,
 * internally consistent authorization version.
 */
export function assertHcnEmployeePrincipal(
  value,
  options = {}
) {
  const config = normalizeOptions(options);
  assertExactKeys(value, PRINCIPAL_FIELDS, "HCN employee principal");
  if (value.schemaVersion !== HCN_EMPLOYEE_PRINCIPAL_SCHEMA) {
    fail("HCN employee principal schemaVersion is unsupported");
  }
  if (!SOURCE_SET.has(value.source)) {
    fail("HCN employee principal source is unsupported");
  }

  const normalized = normalizePrincipalFields({
    source: value.source,
    email: value.email,
    displayName: value.displayName,
    enabled: value.enabled,
    role: value.role,
    googleSubject: value.googleSubject,
    jobNimbusOwnerId: value.jobNimbusOwnerId,
    jobNimbusScope: value.jobNimbusScope,
    allowedDomain: config.allowedDomain,
    requireCanonical: true
  });
  const expectedVersion = authorizationVersion(normalized);
  if (
    typeof value.authorizationVersion !== "string"
    || !AUTHORIZATION_VERSION_PATTERN.test(
      value.authorizationVersion
    )
    || value.authorizationVersion !== expectedVersion
  ) {
    fail(
      "HCN employee principal authorizationVersion does not match its authorization fields"
    );
  }

  return freezePrincipal({
    schemaVersion: HCN_EMPLOYEE_PRINCIPAL_SCHEMA,
    ...normalized,
    authorizationVersion: expectedVersion
  });
}

/**
 * Compute the authorization version for a normalized principal.
 *
 * The version is intentionally sensitive to the identity source, email,
 * enabled state, role, immutable Google subject, JobNimbus owner, and
 * JobNimbus scope. Display-name changes do not invalidate authority.
 */
export function computeHcnEmployeeAuthorizationVersion(
  value,
  options = {}
) {
  const principal = principalAuthorizationMaterial(
    value,
    normalizeOptions(options)
  );
  return authorizationVersion(principal);
}

/**
 * Create the exact private binding a server session should retain.
 *
 * This value is not a browser projection: it intentionally includes the
 * immutable Google subject and must remain inside the trusted server boundary.
 */
export function createHcnEmployeeAuthorizationBinding(
  principal,
  options = {}
) {
  const normalized = assertHcnEmployeePrincipal(principal, options);
  return Object.freeze({
    schemaVersion: HCN_EMPLOYEE_AUTHORIZATION_BINDING_SCHEMA,
    email: normalized.email,
    googleSubject: normalized.googleSubject,
    authorizationVersion: normalized.authorizationVersion
  });
}

/**
 * Fail-closed session/registry comparison suitable for an HTTP auth boundary.
 *
 * Malformed input returns false rather than leaking validation detail.
 */
export function hcnEmployeeAuthorizationBindingMatches(
  binding,
  principal,
  options = {}
) {
  try {
    const normalized = assertHcnEmployeePrincipal(principal, options);
    assertExactKeys(
      binding,
      AUTHORIZATION_BINDING_FIELDS,
      "HCN employee authorization binding"
    );
    if (
      binding.schemaVersion
        !== HCN_EMPLOYEE_AUTHORIZATION_BINDING_SCHEMA
      || binding.email !== normalized.email
      || binding.googleSubject !== normalized.googleSubject
      || binding.authorizationVersion
        !== normalized.authorizationVersion
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert an authorized session binding and return the normalized principal.
 */
export function assertHcnEmployeeAuthorizationBinding(
  binding,
  principal,
  options = {}
) {
  const normalized = assertHcnEmployeePrincipal(principal, options);
  if (
    !hcnEmployeeAuthorizationBindingMatches(
      binding,
      normalized,
      options
    )
  ) {
    fail(
      "HCN employee authorization binding is invalid or no longer current"
    );
  }
  if (!normalized.enabled) {
    fail("HCN employee principal is disabled");
  }
  return normalized;
}

/**
 * Validate a registry replacement while preserving the immutable login pin.
 *
 * Role, assignment, scope, display name, and enabled state may be updated by
 * an authorized registry process. Email and Google subject changes require a
 * distinct re-enrollment rather than an in-place principal mutation.
 */
export function assertHcnEmployeePrincipalTransition(
  previous,
  next,
  options = {}
) {
  const before = assertHcnEmployeePrincipal(previous, options);
  const after = assertHcnEmployeePrincipal(next, options);
  if (before.email !== after.email) {
    fail("HCN employee email is immutable");
  }
  if (before.googleSubject !== after.googleSubject) {
    fail("HCN employee Google subject is immutable");
  }
  return after;
}

/**
 * Exact browser-safe employee projection.
 *
 * Email, provider owner id, Google subject, authorization version, enrollment
 * source, and all credential or connector state are deliberately omitted.
 */
export function projectHcnEmployeeBrowserProfile(
  principal,
  options = {}
) {
  const normalized = assertHcnEmployeePrincipal(principal, options);
  if (!normalized.enabled) {
    fail("HCN employee principal is disabled");
  }
  const profile = {
    schemaVersion: HCN_EMPLOYEE_BROWSER_PROFILE_SCHEMA,
    displayName: normalized.displayName,
    role: normalized.role,
    jobNimbusScope: normalized.jobNimbusScope
  };
  assertExactKeys(
    profile,
    BROWSER_PROFILE_FIELDS,
    "HCN employee browser profile"
  );
  return Object.freeze(profile);
}

export class HcnEmployeePrincipalError extends Error {
  constructor(message) {
    super(message);
    this.name = "HcnEmployeePrincipalError";
    this.code = "hcn_employee_principal_invalid";
  }
}

function normalizePrincipal(input, config) {
  assertAllowedKeys(input, INPUT_FIELDS, "HCN employee input");
  const role = normalizeRole(input.role ?? "employee");
  const jobNimbusScope = normalizeJobNimbusScope(
    input.jobNimbusScope ?? "assigned"
  );
  if (
    config.autoEnrollment
    && (role !== "employee" || jobNimbusScope !== "assigned")
  ) {
    fail(
      "Auto-enrolled HCN employees must use role employee and assigned JobNimbus scope"
    );
  }

  const normalized = normalizePrincipalFields({
    source: config.source,
    email: input.email,
    displayName: input.name,
    enabled: input.enabled ?? true,
    role,
    googleSubject: input.googleSubject,
    jobNimbusOwnerId: input.jobNimbusOwnerId,
    jobNimbusScope,
    allowedDomain: config.allowedDomain,
    requireCanonical: false
  });
  return freezePrincipal({
    schemaVersion: HCN_EMPLOYEE_PRINCIPAL_SCHEMA,
    ...normalized,
    authorizationVersion: authorizationVersion(normalized)
  });
}

function normalizePrincipalFields({
  source,
  email,
  displayName,
  enabled,
  role,
  googleSubject,
  jobNimbusOwnerId,
  jobNimbusScope,
  allowedDomain,
  requireCanonical
}) {
  if (!SOURCE_SET.has(source)) {
    fail("HCN employee principal source is unsupported");
  }
  const normalizedEmail = normalizeEmail(email, allowedDomain);
  const normalizedName = normalizeDisplayName(displayName);
  const normalizedRole = normalizeRole(role);
  const normalizedScope =
    normalizeJobNimbusScope(jobNimbusScope);
  const normalizedSubject = normalizeGoogleSubject(googleSubject);
  const normalizedOwnerId =
    normalizeJobNimbusOwnerId(jobNimbusOwnerId);
  if (typeof enabled !== "boolean") {
    fail("HCN employee enabled must be a boolean");
  }
  assertRoleScope(normalizedRole, normalizedScope);
  assertSourceRoleScope(
    source,
    normalizedRole,
    normalizedScope
  );

  if (
    requireCanonical
    && (
      email !== normalizedEmail
      || displayName !== normalizedName
      || role !== normalizedRole
      || googleSubject !== normalizedSubject
      || jobNimbusOwnerId !== normalizedOwnerId
      || jobNimbusScope !== normalizedScope
    )
  ) {
    fail("HCN employee principal fields are not canonical");
  }

  return {
    source,
    email: normalizedEmail,
    displayName: normalizedName,
    enabled,
    role: normalizedRole,
    googleSubject: normalizedSubject,
    jobNimbusOwnerId: normalizedOwnerId,
    jobNimbusScope: normalizedScope
  };
}

function principalAuthorizationMaterial(value, config) {
  if (!isPlainObject(value)) {
    fail("HCN employee authorization material must be a plain object");
  }
  return normalizePrincipalFields({
    source: value.source,
    email: value.email,
    displayName: value.displayName,
    enabled: value.enabled,
    role: value.role,
    googleSubject: value.googleSubject,
    jobNimbusOwnerId: value.jobNimbusOwnerId,
    jobNimbusScope: value.jobNimbusScope,
    allowedDomain: config.allowedDomain,
    requireCanonical: true
  });
}

function authorizationVersion(principal) {
  const material = JSON.stringify({
    source: principal.source,
    email: principal.email,
    enabled: principal.enabled,
    role: principal.role,
    googleSubject: principal.googleSubject,
    jobNimbusOwnerId: principal.jobNimbusOwnerId,
    jobNimbusScope: principal.jobNimbusScope
  });
  return `authz_v1_${createHash("sha256")
    .update(AUTHORIZATION_HASH_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(material, "utf8")
    .digest("hex")}`;
}

function normalizeOptions(options) {
  if (
    options === undefined
    || options === null
    || !isPlainObject(options)
  ) {
    if (options !== undefined && options !== null) {
      fail("HCN employee principal options must be a plain object");
    }
    return { allowedDomain: DEFAULT_ALLOWED_DOMAIN };
  }
  assertAllowedKeys(
    options,
    ["allowedDomain"],
    "HCN employee principal options"
  );
  const allowedDomain = String(
    Object.hasOwn(options, "allowedDomain")
      ? options.allowedDomain
      : DEFAULT_ALLOWED_DOMAIN
  ).trim().toLowerCase();
  if (allowedDomain && !DOMAIN_PATTERN.test(allowedDomain)) {
    fail("HCN employee allowedDomain is invalid");
  }
  return { allowedDomain };
}

function normalizeEmail(value, allowedDomain) {
  if (typeof value !== "string") {
    fail("HCN employee email is required");
  }
  const email = value.trim().toLowerCase();
  if (
    !email
    || Buffer.byteLength(email, "utf8") > MAX_EMAIL_BYTES
    || /[\x00-\x20\x7f]/.test(email)
  ) {
    fail("HCN employee email is invalid");
  }
  const at = email.lastIndexOf("@");
  const local = at > 0 ? email.slice(0, at) : "";
  const domain = at > 0 ? email.slice(at + 1) : "";
  if (
    !LOCAL_EMAIL_PATTERN.test(local)
    || !DOMAIN_PATTERN.test(domain)
    || (allowedDomain && domain !== allowedDomain)
  ) {
    fail("HCN employee email is outside the approved domain");
  }
  return email;
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    fail("HCN employee name is required");
  }
  const name = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !name
    || Array.from(name).length > MAX_DISPLAY_NAME_CHARACTERS
  ) {
    fail("HCN employee name is invalid");
  }
  return name;
}

function normalizeRole(value) {
  if (typeof value !== "string") {
    fail("HCN employee role is required");
  }
  const role = value.trim().toLowerCase();
  if (!ROLE_SET.has(role)) {
    fail("HCN employee role is unsupported");
  }
  return role;
}

function normalizeJobNimbusScope(value) {
  if (typeof value !== "string") {
    fail("HCN employee JobNimbus scope is required");
  }
  const scope = value.trim().toLowerCase();
  if (!JOBNIMBUS_SCOPE_SET.has(scope)) {
    fail("HCN employee JobNimbus scope is unsupported");
  }
  return scope;
}

function normalizeGoogleSubject(value) {
  if (
    typeof value !== "string"
    || !GOOGLE_SUBJECT_PATTERN.test(value)
  ) {
    fail(
      "HCN employee Google subject must be an exact immutable provider subject"
    );
  }
  return value;
}

function normalizeJobNimbusOwnerId(value) {
  if (
    typeof value !== "string"
    || !PROVIDER_OWNER_ID_PATTERN.test(value)
  ) {
    fail(
      "HCN employee JobNimbus owner id must be an exact provider identifier"
    );
  }
  return value;
}

function assertRoleScope(role, scope) {
  if (scope === "company" && !COMPANY_SCOPE_ROLES.has(role)) {
    fail(
      "Company JobNimbus scope requires an explicit HCN management role"
    );
  }
}

function assertSourceRoleScope(source, role, scope) {
  if (
    source === "auto_enrolled"
    && (role !== "employee" || scope !== "assigned")
  ) {
    fail(
      "Auto-enrolled HCN employees must use role employee and assigned JobNimbus scope"
    );
  }
}

function assertAllowedKeys(value, allowed, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a plain object`);
  }
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key)) {
      fail(`${label} contains an unsupported field`);
    }
  }
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string")
    || actual.length !== expected.length
    || expected.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    )
  ) {
    fail(`${label} must contain exactly the reviewed fields`);
  }
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

function freezePrincipal(value) {
  return Object.freeze(value);
}

function fail(message) {
  throw new HcnEmployeePrincipalError(message);
}
