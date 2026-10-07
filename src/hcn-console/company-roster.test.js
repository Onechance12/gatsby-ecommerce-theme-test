import assert from "node:assert/strict";
import test from "node:test";
import { createHcnReferenceFactory } from "../hcn-ops/references.js";
import { readCompanyRoster, validateCompanyRosterInput, CompanyRosterError } from "./company-roster.js";

const references = createHcnReferenceFactory({ tenantId: "tenant_0123456789abcdef", hmacKey: Buffer.alloc(32, 42) });
const users = [
  { jnid: "chance-fixture", email: "chance@example.test", display_name: "Chance Fixture", is_active: true },
  { jnid: "other-fixture", email: "other@example.test", display_name: "Other Fixture", is_active: true },
  { jnid: "inactive-fixture", email: "old@example.test", display_name: "Past Fixture", is_active: false }
];
export const contact = (index, overrides = {}) => ({
  jnid: `file-${index}`, number: 1000 + index, customer: "fixture-account",
  display_name: "Same Multi-Property Client", address_line1: `${index} Example Street`,
  record_type_name: "Insurance", status_name: "Ready for Review", is_active: true,
  owners: [{ id: index % 2 ? "other-fixture" : "chance-fixture" }],
  date_created: 1700000000 + index, date_updated: 1700001000 + index,
  description: "PRIVATE NOTE MUST NOT ENTER INVENTORY", email: "private@example.test",
  financial_total: 999999, policy_number: "PRIVATE POLICY",
  ...overrides
});

function reader({ contacts = Array.from({ length: 5 }, (_, i) => contact(i)), jobs = [], mutate = x => x, cap = 2, anchorUserId = "chance-fixture" } = {}) {
  const requests = [];
  return {
    requests,
    run: () => readCompanyRoster({
      referenceFactory: references, anchorEmail: "chance@example.test", anchorUserId,
      fetchPage: async (endpoint, budget) => {
        budget.used += 1;
        if (budget.used > budget.maximum) throw new CompanyRosterError();
        requests.push(endpoint);
        if (endpoint === "/account/users") return { users, total: users.length };
        const url = new URL(endpoint, "https://fixture.invalid");
        const all = url.pathname === "/contacts" ? contacts : jobs;
        const offset = Number(url.searchParams.get("from"));
        const size = Math.min(cap, Number(url.searchParams.get("size")));
        return mutate({ results: all.slice(offset, offset + size), total: all.length }, { url, offset });
      }
    })
  };
}

test("inventory preserves five client/property files, every owner and source kind, no private field spill", async () => {
  const fixture = reader({
    contacts: Array.from({ length: 5 }, (_, i) => contact(i, i === 4 ? { owners: [] } : {})),
    jobs: [{ ...contact(90), name: "Related Work", related: [{ id: "file-0" }], is_archived: true }]
  });
  const result = await fixture.run();
  assert.equal(result.complete, true);
  assert.equal(result.totals.contacts, 5);
  assert.equal(result.totals.jobs, 1);
  assert.equal(result.totals.insuranceContacts, 5);
  assert.equal(result.totals.unassigned, 1);
  assert.equal(new Set(result.rows.filter(r => r.sourceKind === "contact").map(r => r.propertyAddress)).size, 5);
  assert.equal(new Set(result.rows.filter(r => r.sourceKind === "contact").map(r => r.clientName)).size, 1);
  assert.equal(result.rows.find(r => r.sourceKind === "job").lifecycle, "archived");
  assert.deepEqual(result.rows.find(r => r.sourceKind === "job").relatedContactIds, ["file-0"]);
  assert.equal(result.coverage.contacts.pages, 4);
  assert.equal(result.coverage.jobs.pages, 2);
  assert.equal(result.coverage.contacts.endProof, "empty_page_at_next_offset");
  assert.equal(fixture.requests.some(p => /filter=|actor=/.test(p)), false);
  for (const forbidden of ["PRIVATE NOTE", "private@example.test", "999999", "PRIVATE POLICY", "description", "policy_number"]) {
    assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
  }
});

test("unassigned, inactive, closed, non-insurance, unknown owner and missing address stay visible", async () => {
  const result = await reader({ contacts: [
    contact(0, { is_active: false, owners: [{ id: "inactive-fixture" }] }),
    contact(1, { is_closed: true }),
    contact(2, { record_type_name: "Contractor", owners: [{ id: "missing-user" }], address_line1: "" }),
    contact(3, { owners: [] })
  ] }).run();
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].lifecycle, "inactive");
  assert.equal(result.rows[1].lifecycle, "closed");
  assert.equal(result.totals.insuranceContacts, 3);
  assert.equal(result.totals.unknownOwner, 1);
  assert.equal(result.totals.missingPropertyAddress, 1);
  assert.equal(result.owners.find(o => o.id === "inactive-fixture").contacts, 1);
});

test("300-file capacity is metadata-only, not proof of a real roster", async () => {
  const result = await reader({ contacts: Array.from({ length: 300 }, (_, i) => contact(i)), cap: 37 }).run();
  assert.equal(result.rows.length, 300);
  assert.equal(result.coverage.contacts.pages, 10);
  assert.equal(new Set(result.rows.map(r => r.sourceId)).size, 300);
});

for (const [label, mutate] of [
  ["total changed", (p, { offset }) => ({ ...p, total: p.total + (offset ? 1 : 0) })],
  ["premature empty page", (p, { offset, url }) => offset && url.pathname === "/contacts" ? { ...p, results: [] } : p],
  ["repeated source id", p => ({ ...p, results: p.results.map(r => ({ ...r, jnid: "repeated-file" })) })],
  ["over bound", p => ({ ...p, total: 10001 })],
  ["ambiguous envelope", p => ({ ...p, contacts: p.results })],
  ["conflicting total aliases", p => ({ ...p, total_count: p.total + 1 })],
  ["invalid source id", p => ({ ...p, results: p.results.map(r => ({ ...r, jnid: "BAD PRIVATE / ID" })) })],
  ["mixed account records", p => ({ ...p, results: p.results.map((r, i) => ({ ...r, customer: i ? "foreign-account" : "fixture-account" })) })]
]) test(`incomplete or ambiguous provider data fails closed: ${label}`, async () => {
  await assert.rejects(reader({ mutate }).run(), error => error instanceof CompanyRosterError && !error.message.includes("PRIVATE"));
});

test("source connection anchor must match the existing active employee before any roster page", async () => {
  const fixture = reader({ anchorUserId: "foreign-user" });
  await assert.rejects(fixture.run(), CompanyRosterError);
  assert.deepEqual(fixture.requests, ["/account/users"]);
});

test("caller cannot select a tenant, owner, filter, URL, activity or effect", () => {
  validateCompanyRosterInput({});
  for (const bad of [null, [], "*", { tenantId: "other" }, { ownerId: "other" }, { filter: {} }, { includeNotes: true }, { operatorScope: "company" }]) {
    assert.throws(() => validateCompanyRosterInput(bad), e => e.statusCode === 400);
  }
});
