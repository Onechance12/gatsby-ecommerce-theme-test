import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_EMPLOYEE_AUTHORIZATION_BINDING_SCHEMA,
  HCN_EMPLOYEE_BROWSER_PROFILE_SCHEMA,
  HCN_EMPLOYEE_PRINCIPAL_SCHEMA,
  HcnEmployeePrincipalError,
  assertHcnEmployeeAuthorizationBinding,
  assertHcnEmployeePrincipal,
  assertHcnEmployeePrincipalTransition,
  computeHcnEmployeeAuthorizationVersion,
  createHcnEmployeeAuthorizationBinding,
  hcnEmployeeAuthorizationBindingMatches,
  normalizeAutoEnrolledHcnEmployeePrincipal,
  normalizeExplicitHcnEmployeePrincipal,
  projectHcnEmployeeBrowserProfile
} from "./hcn-employee-principal.js";

function explicit(overrides = {}) {
  return normalizeExplicitHcnEmployeePrincipal({
    email: "  Adjuster.One@WavePA.com ",
    name: "  Adjuster   One  ",
    googleSubject: "google-subject-001",
    jobNimbusOwnerId: "jobnimbus-owner-001",
    ...overrides
  });
}

function autoEnrolled(overrides = {}) {
  return normalizeAutoEnrolledHcnEmployeePrincipal({
    email: "new.adjuster@wavepa.com",
    name: "New Adjuster",
    googleSubject: "google-subject-002",
    jobNimbusOwnerId: "jobnimbus-owner-002",
    ...overrides
  });
}

test("ordinary explicit principals default to employee and assigned scope", () => {
  const principal = explicit();
  assert.deepEqual(principal, {
    schemaVersion: HCN_EMPLOYEE_PRINCIPAL_SCHEMA,
    source: "explicit",
    email: "adjuster.one@wavepa.com",
    displayName: "Adjuster One",
    enabled: true,
    role: "employee",
    googleSubject: "google-subject-001",
    jobNimbusOwnerId: "jobnimbus-owner-001",
    jobNimbusScope: "assigned",
    authorizationVersion: principal.authorizationVersion
  });
  assert.match(
    principal.authorizationVersion,
    /^authz_v1_[a-f0-9]{64}$/
  );
  assert.equal(Object.isFrozen(principal), true);
});

test("unrestricted HCN login accepts any canonical active-employee email domain", () => {
  const principal = normalizeExplicitHcnEmployeePrincipal({
    email: "richard@titanrecon.com",
    name: "Richard",
    role: "manager",
    googleSubject: "richard-google-subject",
    jobNimbusOwnerId: "richard-owner",
    jobNimbusScope: "assigned"
  }, {
    allowedDomain: ""
  });
  assert.equal(principal.email, "richard@titanrecon.com");
  assert.throws(
    () => normalizeExplicitHcnEmployeePrincipal({
      email: "not-an-email",
      name: "Invalid",
      role: "employee",
      googleSubject: "invalid-subject",
      jobNimbusOwnerId: "owner",
      jobNimbusScope: "assigned"
    }, {
      allowedDomain: ""
    }),
    /email/i
  );
});

test("explicit management principals may receive reviewed company scope", () => {
  const manager = explicit({
    role: " Manager ",
    jobNimbusScope: " COMPANY "
  });
  assert.equal(manager.role, "manager");
  assert.equal(manager.jobNimbusScope, "company");

  const administrator = explicit({
    role: "administrator",
    jobNimbusScope: "company"
  });
  assert.equal(administrator.role, "administrator");

  const chance = explicit({
    role: "chance",
    jobNimbusScope: "company"
  });
  assert.equal(chance.role, "chance");
});

test("ordinary explicit roles cannot receive company scope", () => {
  for (const role of ["employee", "client_coordinator"]) {
    assert.throws(
      () => explicit({ role, jobNimbusScope: "company" }),
      (error) =>
        error instanceof HcnEmployeePrincipalError
        && /management role/.test(error.message)
    );
  }
});

test("auto-enrollment always resolves to employee and assigned scope", () => {
  const principal = autoEnrolled();
  assert.equal(principal.source, "auto_enrolled");
  assert.equal(principal.role, "employee");
  assert.equal(principal.jobNimbusScope, "assigned");
  assert.equal(principal.enabled, true);

  const explicitDefaults = autoEnrolled({
    role: " EMPLOYEE ",
    jobNimbusScope: " ASSIGNED "
  });
  assert.equal(explicitDefaults.role, "employee");
  assert.equal(explicitDefaults.jobNimbusScope, "assigned");
});

test("auto-enrollment rejects role and company-scope escalation", () => {
  for (const role of [
    "manager",
    "administrator",
    "chance",
    "client_coordinator"
  ]) {
    assert.throws(
      () => autoEnrolled({ role }),
      /must use role employee and assigned JobNimbus scope/
    );
  }
  assert.throws(
    () => autoEnrolled({ jobNimbusScope: "company" }),
    /must use role employee and assigned JobNimbus scope/
  );
  assert.throws(
    () => autoEnrolled({
      role: "manager",
      jobNimbusScope: "company"
    }),
    /must use role employee and assigned JobNimbus scope/
  );

  const explicitlyProvisionedManager = explicit({
    role: "manager",
    jobNimbusScope: "company"
  });
  assert.throws(
    () => assertHcnEmployeePrincipal({
      ...explicitlyProvisionedManager,
      source: "auto_enrolled"
    }),
    /must use role employee and assigned JobNimbus scope/
  );
});

test("unsupported roles, scopes, and unknown fields fail closed", () => {
  assert.throws(
    () => explicit({ role: "owner" }),
    /role is unsupported/
  );
  assert.throws(
    () => explicit({ role: "onboarding" }),
    /role is unsupported/
  );
  assert.throws(
    () => explicit({ jobNimbusScope: "all" }),
    /scope is unsupported/
  );
  assert.throws(
    () => normalizeExplicitHcnEmployeePrincipal({
      email: "adjuster@wavepa.com",
      name: "Adjuster",
      googleSubject: "google-subject",
      jobNimbusOwnerId: "owner-id",
      tenantId: "not-accepted"
    }),
    /unsupported field/
  );
  assert.throws(
    () => normalizeExplicitHcnEmployeePrincipal([]),
    /plain object/
  );
});

test("Google subject and JobNimbus owner id are mandatory exact identifiers", () => {
  for (const googleSubject of [
    "",
    " subject",
    "subject ",
    "subject with space",
    "subject\nvalue",
    "a".repeat(256)
  ]) {
    assert.throws(
      () => explicit({ googleSubject }),
      /exact immutable provider subject/
    );
  }
  for (const jobNimbusOwnerId of [
    "",
    " owner",
    "owner ",
    "owner id",
    "owner\nid",
    "a".repeat(513)
  ]) {
    assert.throws(
      () => explicit({ jobNimbusOwnerId }),
      /exact provider identifier/
    );
  }
});

test("email is canonicalized and confined to the configured company domain", () => {
  assert.equal(
    explicit().email,
    "adjuster.one@wavepa.com"
  );
  assert.throws(
    () => explicit({ email: "adjuster@example.com" }),
    /outside the approved domain/
  );
  const otherDomain = normalizeExplicitHcnEmployeePrincipal(
    {
      email: "adjuster@hcn.example",
      name: "Adjuster",
      googleSubject: "subject-003",
      jobNimbusOwnerId: "owner-003"
    },
    { allowedDomain: "hcn.example" }
  );
  assert.equal(otherDomain.email, "adjuster@hcn.example");
  assert.throws(
    () => assertHcnEmployeePrincipal(otherDomain),
    /outside the approved domain/
  );
  assert.deepEqual(
    assertHcnEmployeePrincipal(
      otherDomain,
      { allowedDomain: "hcn.example" }
    ),
    otherDomain
  );
});

test("authorization version changes with every authorization-bearing field", () => {
  const base = explicit();
  const versions = new Set([
    base.authorizationVersion,
    explicit({ enabled: false }).authorizationVersion,
    explicit({ role: "manager" }).authorizationVersion,
    explicit({
      googleSubject: "google-subject-001-changed"
    }).authorizationVersion,
    explicit({
      jobNimbusOwnerId: "jobnimbus-owner-001-changed"
    }).authorizationVersion,
    explicit({
      role: "manager",
      jobNimbusScope: "company"
    }).authorizationVersion,
    normalizeExplicitHcnEmployeePrincipal({
      email: "another.adjuster@wavepa.com",
      name: "Adjuster One",
      googleSubject: "google-subject-001",
      jobNimbusOwnerId: "jobnimbus-owner-001"
    }).authorizationVersion,
    autoEnrolled({
      email: "adjuster.one@wavepa.com",
      name: "Adjuster One",
      googleSubject: "google-subject-001",
      jobNimbusOwnerId: "jobnimbus-owner-001"
    }).authorizationVersion
  ]);
  assert.equal(versions.size, 8);

  const renamed = explicit({ name: "Adjusted Display Name" });
  assert.equal(
    renamed.authorizationVersion,
    base.authorizationVersion
  );
  assert.equal(
    computeHcnEmployeeAuthorizationVersion(base),
    base.authorizationVersion
  );
});

test("normalized-principal validation is exact and detects tampering", () => {
  const principal = explicit();
  assert.deepEqual(
    assertHcnEmployeePrincipal(principal),
    principal
  );
  assert.throws(
    () => assertHcnEmployeePrincipal({
      ...principal,
      unexpected: true
    }),
    /exactly the reviewed fields/
  );
  assert.throws(
    () => assertHcnEmployeePrincipal({
      ...principal,
      jobNimbusOwnerId: "other-owner"
    }),
    /authorizationVersion does not match/
  );
  assert.throws(
    () => assertHcnEmployeePrincipal({
      ...principal,
      authorizationVersion:
        `authz_v1_${"0".repeat(64)}`
    }),
    /authorizationVersion does not match/
  );
  assert.throws(
    () => assertHcnEmployeePrincipal({
      ...principal,
      email: " Adjuster.One@wavepa.com "
    }),
    /not canonical/
  );
});

test("authorization bindings are exact, private, and fail closed", () => {
  const principal = explicit();
  const binding =
    createHcnEmployeeAuthorizationBinding(principal);
  assert.deepEqual(binding, {
    schemaVersion:
      HCN_EMPLOYEE_AUTHORIZATION_BINDING_SCHEMA,
    email: principal.email,
    googleSubject: principal.googleSubject,
    authorizationVersion: principal.authorizationVersion
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(
    hcnEmployeeAuthorizationBindingMatches(
      binding,
      principal
    ),
    true
  );
  assert.deepEqual(
    assertHcnEmployeeAuthorizationBinding(
      binding,
      principal
    ),
    principal
  );

  for (const invalid of [
    { ...binding, authorizationVersion: `authz_v1_${"0".repeat(64)}` },
    { ...binding, googleSubject: "another-google-subject" },
    { ...binding, email: "someone.else@wavepa.com" },
    { ...binding, extra: true },
    null
  ]) {
    assert.equal(
      hcnEmployeeAuthorizationBindingMatches(
        invalid,
        principal
      ),
      false
    );
    assert.throws(
      () => assertHcnEmployeeAuthorizationBinding(
        invalid,
        principal
      ),
      /invalid or no longer current/
    );
  }
});

test("changed authorization invalidates an existing session binding", () => {
  const original = explicit();
  const binding =
    createHcnEmployeeAuthorizationBinding(original);

  for (const changed of [
    explicit({ enabled: false }),
    explicit({ role: "manager" }),
    explicit({
      googleSubject: "different-google-subject"
    }),
    explicit({
      jobNimbusOwnerId: "different-owner-id"
    })
  ]) {
    assert.equal(
      hcnEmployeeAuthorizationBindingMatches(binding, changed),
      false
    );
  }
});

test("registry transitions preserve immutable email and Google subject", () => {
  const original = explicit();
  const reassigned = explicit({
    enabled: false,
    role: "manager",
    jobNimbusOwnerId: "new-owner-id"
  });
  assert.deepEqual(
    assertHcnEmployeePrincipalTransition(
      original,
      reassigned
    ),
    reassigned
  );
  assert.throws(
    () => assertHcnEmployeePrincipalTransition(
      original,
      explicit({
        email: "different@wavepa.com"
      })
    ),
    /email is immutable/
  );
  assert.throws(
    () => assertHcnEmployeePrincipalTransition(
      original,
      explicit({
        googleSubject: "different-subject"
      })
    ),
    /Google subject is immutable/
  );
});

test("browser projection exposes only safe operating profile fields", () => {
  const principal = explicit();
  const profile = projectHcnEmployeeBrowserProfile(principal);
  assert.deepEqual(profile, {
    schemaVersion: HCN_EMPLOYEE_BROWSER_PROFILE_SCHEMA,
    displayName: "Adjuster One",
    role: "employee",
    jobNimbusScope: "assigned"
  });
  assert.deepEqual(
    Object.keys(profile).sort(),
    [
      "displayName",
      "jobNimbusScope",
      "role",
      "schemaVersion"
    ]
  );
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(
    serialized,
    /adjuster\.one@|google-subject|jobnimbus-owner|authz_v1|auto_enrolled|explicit/
  );
  assert.equal(Object.isFrozen(profile), true);
});

test("disabled principals cannot be projected or authorize a session", () => {
  const principal = explicit({ enabled: false });
  const binding =
    createHcnEmployeeAuthorizationBinding(principal);
  assert.equal(
    hcnEmployeeAuthorizationBindingMatches(
      binding,
      principal
    ),
    true
  );
  assert.throws(
    () => assertHcnEmployeeAuthorizationBinding(
      binding,
      principal
    ),
    /principal is disabled/
  );
  assert.throws(
    () => projectHcnEmployeeBrowserProfile(principal),
    /principal is disabled/
  );
});
