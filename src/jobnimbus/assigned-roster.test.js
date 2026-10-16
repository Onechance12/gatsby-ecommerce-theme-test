import test from "node:test";
import assert from "node:assert/strict";
import { assignedRoster, liveAssignedContactAllowed } from "./assigned-roster.js";

const OWNER = "synthetic-owner";
const contact = (number, patch = {}) => ({
  number: String(number), jnid: `synthetic-file-${number}`,
  record_type_name: "Insurance", owners: [{ id: OWNER }],
  is_active: true, is_archived: false, is_closed: false, ...patch
});
const options = {
  ownerId: OWNER, insurance: (row) => row.record_type_name === "Insurance",
  assigned: (row, id) => row.owners?.some((owner) => owner.id === id),
  active: (row) => row.is_active && !row.is_archived && !row.is_closed,
  actionAllowed: (row) => Number(row.number) < 1057
};

test("72 assigned files never get mislabeled as the 57 returned manifest files", () => {
  const rows = Array.from({ length: 72 }, (_, i) => contact(1000 + i));
  rows.push(contact(2000, { owners: [{ id: "another-owner" }] }));
  const result = assignedRoster(rows, options);
  assert.deepEqual(result.counts, {
    assignedInsurance: 72, assignedOpenActiveInsurance: 72,
    matchingRequestedFilters: 72, returned: 57, restrictedByActionScope: 15
  });
  assert.equal(result.countScope, "fixed_manifest_subset");
  assert.equal(result.files.length, 57);
  assert.equal(result.coverage.countIsExact, true);
});

test("live assignment follows additions/reassignments and keeps excluded/closed records out", () => {
  const rows = [contact(2804), contact(2805), contact(2628), contact(2806, { is_closed: true })];
  const live = { ...options, assignmentMode: "live_assigned",
    actionAllowed: (row) => liveAssignedContactAllowed(row, OWNER) };
  assert.equal(assignedRoster(rows, live).files.length, 2);
  rows.push(contact(2807));
  rows[0].owners = [{ id: "another-owner" }];
  assert.deepEqual(assignedRoster(rows, live).files.map((row) => row.number), ["2805", "2807"]);
  for (const patch of [
    { owners: [] }, { owners: undefined }, { is_active: undefined }, { is_active: false },
    { is_archived: true }, { is_closed: true }, { is_deleted: true },
    { record_type_name: "Retail" }, { id: "different-synthetic-id" },
    { status_name: "Closed" }, { is_deleted: "unknown" }
  ]) assert.equal(liveAssignedContactAllowed(contact(2804, patch), OWNER), false);
  assert.equal(liveAssignedContactAllowed(contact(2804, { owners: [OWNER],
    is_active: "true", is_archived: "false", is_closed: "0" }), OWNER), true);
  assert.equal(liveAssignedContactAllowed(contact(2804, { owners: [{ jnid: OWNER }],
    is_active: 1, is_archived: 0, is_closed: false }), OWNER), true);
});

test("duplicate identities fail rather than inflate the book; missing ownership is explicitly incomplete", () => {
  assert.throws(() => assignedRoster([contact(2804), contact(2804)], options), /duplicate/);
  assert.throws(() => assignedRoster([contact(2804), contact(2805, { jnid: "synthetic-file-2804" })], options), /duplicate/);
  const result = assignedRoster([contact(2804), contact(2805, { owners: undefined })], options);
  assert.equal(result.coverage.countIsExact, false);
  assert.deepEqual(result.limitations, ["missing_ownership_fields", "assigned_files_restricted_by_action_scope"]);
  assert.throws(() => assignedRoster([], { ...options, ownerId: "" }), /configured owner/);
  const unknownActivity = assignedRoster([contact(1000, { is_active: undefined })], options);
  assert.equal(unknownActivity.coverage.countIsExact, false);
  assert.deepEqual(unknownActivity.limitations, ["missing_activity_fields"]);
});
