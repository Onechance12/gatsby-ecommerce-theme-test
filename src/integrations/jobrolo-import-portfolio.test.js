import assert from "node:assert/strict";
import test from "node:test";
import { resolveJobroloPortfolioGrant, jobroloPortfolioPage, jobroloPortfolioSourceOwners } from "./jobrolo-import-portfolio.js";
import { createHash } from "node:crypto";

const now = Date.parse("2026-10-07T15:00:00.000Z");
const grantRef = `grant_${"a".repeat(32)}`;
const value = { grantRef, tenantId: "tenant_fixture", clientId: "import-fixture",
  connectionRef: `connection_${"b".repeat(32)}`, issuedAt: new Date(now - 1_000).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(),
  providerFileIds: Array.from({ length: 259 }, (_, i) => `fixture_${i}`) };
const profile = { ready: true, clientId: value.clientId, connectionRef: value.connectionRef };
const referenceFactory = { subjectId: (_, id) => `subject_${createHash("sha256").update(id).digest("hex").slice(0, 32)}` };
function resolve(overrides = {}, grant = value) {
  return resolveJobroloPortfolioGrant({ environment: {
    HCN_JOBROLO_IMPORT_PORTFOLIO_ENABLED: "true",
    HCN_JOBROLO_IMPORT_PORTFOLIO_GRANTS_JSON: JSON.stringify({ schema: "hcn.jobrolo.import-portfolio-grants.v1", grants: [grant] }),
  }, profile, tenantId: value.tenantId, grantRef, referenceFactory, now, ...overrides });
}
test("selected grant pages completely without exposing raw source IDs in authorization", () => {
  const grant = resolve(); let cursor = null; const files = [];
  do { const page = jobroloPortfolioPage(grant, cursor); files.push(...page.files); cursor = page.nextCursor;
    assert.ok(page.files.length <= 25); } while (cursor !== null);
  assert.equal(files.length, 259); assert.equal(new Set(files.map(file => file.sourceFileRef)).size, 259);
  assert.deepEqual(Object.keys(grant.authorization).sort(), ["expiresAt", "grantDigest", "grantRef"]);
  assert.throws(() => jobroloPortfolioPage(grant, `subject_${"f".repeat(32)}`));
});
test("tenant/profile/ref, expiry, duplicates, bounds and renewal change fail closed", () => {
  for (const flag of [undefined, "false", "yes"]) assert.throws(() => resolve({ environment: {
    HCN_JOBROLO_IMPORT_PORTFOLIO_ENABLED: flag,
    HCN_JOBROLO_IMPORT_PORTFOLIO_GRANTS_JSON: JSON.stringify({ schema: "hcn.jobrolo.import-portfolio-grants.v1", grants: [value] }),
  } }));
  for (const overrides of [{ tenantId: "foreign" }, { profile: { ...profile, clientId: "foreign" } },
    { grantRef: `grant_${"f".repeat(32)}` }, { now: Date.parse(value.expiresAt) }]) assert.throws(() => resolve(overrides));
  for (const grant of [{ ...value, providerFileIds: [...value.providerFileIds, value.providerFileIds[0]] },
    { ...value, providerFileIds: Array.from({ length: 501 }, (_, i) => `fixture_${i}`) },
    { ...value, expiresAt: new Date(now + 25 * 3_600_000).toISOString() }, { ...value, arbitrary: true }]) {
    assert.throws(() => resolve({}, grant));
  }
  const renewed = resolve({}, { ...value, expiresAt: new Date(now + 7_200_000).toISOString() });
  assert.notEqual(renewed.grantDigest, resolve().grantDigest);
});
test("source owners require an exact complete directory identity, retain inactive facts and never impersonate the importer", () => {
  const factory = { sourceRecordRef: (_, id) => `ref_${createHash("sha256").update(id).digest("hex").slice(0, 32)}` };
  const users = [{ jnid: "private_source_owner", display_name: "Original source adjuster", is_active: false }];
  const owners = jobroloPortfolioSourceOwners({ owners: [{ id: users[0].jnid }] }, users, factory);
  assert.equal(owners[0].displayName, "Original source adjuster");
  assert.equal(owners[0].isActive, false);
  assert.doesNotMatch(JSON.stringify(owners), /private_source_owner/);
  for (const contact of [{ owners: [] }, { owners: [{ id: "unknown" }] },
    { owners: [{ id: users[0].jnid }, { id: users[0].jnid }] }]) {
    assert.throws(() => jobroloPortfolioSourceOwners(contact, users, factory));
  }
  assert.throws(() => jobroloPortfolioSourceOwners({ owners: [{ id: users[0].jnid }] }, [...users, users[0]], factory));
});
