import assert from "node:assert/strict";
import test from "node:test";
import { createCompanyRosterClient, CompanyRosterAttestationError } from "./company-roster-client.js";
import { COMPANY_ROSTER_LIMITS, readCompanyRoster } from "./company-roster.js";
import { COMPANY_ROSTER_ROUTES, COMPANY_ROSTER_SCOPE, COMPANY_ROSTER_SUBJECT } from "../auth/hcn-company-roster-auth.js";
import { createHcnReferenceFactory } from "../hcn-ops/references.js";

const profile = {
  schema: "hcn.company-roster-profile.v1", baseUrl: "https://hcn-operations-platform.onrender.com",
  expectedCommit: "b".repeat(40), tenantId: "tenant_0123456789abcdef",
  grantExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
};
const build = { service: "hcn-operations-platform", sourceCommit: profile.expectedCommit, sourceCommitTrust: "provider_attested", attested: true };
const session = {
  schema: "hcn.company-roster-session.v1", ready: true, readOnly: true, externalWrites: false,
  scope: "configured_jobnimbus_account_metadata", anchorVerification: "existing_active_chance_jobnimbus_identity",
  identity: { type: "hcn_company_roster_token", subject: COMPANY_ROSTER_SUBJECT, role: "company_roster_reader", tenantId: profile.tenantId, grantExpiresAt: profile.grantExpiresAt, scopes: [COMPANY_ROSTER_SCOPE] },
  routes: COMPANY_ROSTER_ROUTES, limits: COMPANY_ROSTER_LIMITS, build
};
function client({ status = session, roster = {}, statusCode = 200, options = {} } = {}) {
  const calls = [];
  return {
    calls,
    api: createCompanyRosterClient({ profile, credential: "c".repeat(64), ...options,
      fetchImpl: async (url, request) => {
        calls.push({ url, method: request.method, body: request.body, redirect: request.redirect });
        return new Response(JSON.stringify(request.method === "GET" ? status : roster), { status: statusCode, headers: { "content-type": "application/json" } });
      }
    })
  };
}

test("failed build, scope, company or grant attestation never advances to inventory or retries", async () => {
  for (const change of [
    { ready: false }, { readOnly: false }, { externalWrites: true },
    { build: { ...build, sourceCommit: "a".repeat(40) } },
    { build: { ...build, sourceCommitTrust: "declared", attested: false } },
    { routes: [...COMPANY_ROSTER_ROUTES, "POST /gmail/send"] },
    { identity: { ...session.identity, tenantId: "tenant_fedcba9876543210" } },
    { identity: { ...session.identity, scopes: [COMPANY_ROSTER_SCOPE, "writes"] } },
    { identity: { ...session.identity, grantExpiresAt: new Date(Date.now() + 7_200_000).toISOString() } }
  ]) {
    const fixture = client({ status: { ...session, ...change } });
    await assert.rejects(fixture.api.readRoster(), CompanyRosterAttestationError);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].method, "GET");
  }
  const offline = client({ statusCode: 503 });
  await assert.rejects(offline.api.readRoster(), CompanyRosterAttestationError);
  assert.equal(offline.calls.length, 1);
});

test("only reviewed origin and unexpired private profile are accepted", () => {
  for (const bad of [
    { baseUrl: "https://foreign.invalid" }, { baseUrl: profile.baseUrl + "?token=private" },
    { baseUrl: "https://user:password@hcn-operations-platform.onrender.com" },
    { expectedCommit: "short" }, { grantExpiresAt: new Date(0).toISOString() }
  ]) assert.throws(() => client({ options: { profile: { ...profile, ...bad } } }), CompanyRosterAttestationError);
});

test("complete response is accepted only after status, with exact deployed build and inventory integrity", async () => {
  const data = await readCompanyRoster({
    referenceFactory: createHcnReferenceFactory({ tenantId: profile.tenantId, hmacKey: Buffer.alloc(32, 42) }),
    anchorEmail: "chance@example.test", anchorUserId: "fixture-user",
    fetchPage: async () => ({ users: [{ jnid: "fixture-user", email: "chance@example.test", is_active: true }] })
  }).catch(() => null);
  assert.equal(data, null, "a malformed catalog must not fabricate an empty roster");
  const roster = await readCompanyRoster({
    referenceFactory: createHcnReferenceFactory({ tenantId: profile.tenantId, hmacKey: Buffer.alloc(32, 42) }),
    anchorEmail: "chance@example.test", anchorUserId: "fixture-user",
    fetchPage: async endpoint => endpoint === "/account/users"
      ? { users: [{ jnid: "fixture-user", email: "chance@example.test", is_active: true }] }
      : { results: [], total: 0 }
  });
  roster.build = build;
  const fixture = client({ roster });
  assert.equal((await fixture.api.readRoster()).complete, true);
  assert.deepEqual(fixture.calls.map(c => c.method), ["GET", "POST"]);
  assert.equal(fixture.calls[1].body, "{}");
  assert.equal(fixture.calls.every(c => c.redirect === "error"), true);
  for (const change of [
    { complete: false }, { inventorySha256: "bad" },
    { build: { ...build, sourceCommit: "a".repeat(40) } },
    { totals: { ...roster.totals, contacts: 1 } },
    { coverage: { ...roster.coverage, ownerFilterApplied: true } }
  ]) {
    const rejected = client({ roster: { ...roster, ...change } });
    await assert.rejects(rejected.api.readRoster(), CompanyRosterAttestationError);
    assert.equal(rejected.calls.length, 2);
  }
});
