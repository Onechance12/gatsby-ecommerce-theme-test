import test from "node:test";
import assert from "node:assert/strict";
import { contactWithWorkflowClosure } from "./workflow-closure.js";
import { liveAssignedContactAllowed } from "./assigned-roster.js";

const OWNER = "synthetic-owner";
const contact = () => ({
  jnid: "synthetic-contact-alpha", number: "990001",
  record_type: 1, record_type_name: "Insurance", status: 375,
  status_name: "Ready for PA Review", owners: [{ id: OWNER }],
  is_active: true, is_archived: false
});
const settings = () => ({ workflows: [{
  id: 1, name: "Insurance", object_type: "contact", is_active: true,
  status: [{ id: 375, name: "Ready for PA Review", is_active: true,
    is_archived: false, is_closed: false }]
}] });

test("an omitted contact closure flag comes from its exact active provider workflow and status", () => {
  const original = contact();
  const configuration = settings();
  assert.equal(liveAssignedContactAllowed(original, OWNER), false);
  const verified = contactWithWorkflowClosure(original, configuration);
  assert.equal(verified.is_closed, false);
  assert.equal(liveAssignedContactAllowed(verified, OWNER), true);
  assert.deepEqual(verified.closureVerification, {
    schemaVersion: 1, source: "jobnimbus_workflow_status",
    workflowId: "1", statusId: "375", isClosed: false,
    basis: "explicit_closed_flag"
  });
  assert.equal(Object.hasOwn(original, "is_closed"), false);
  assert.deepEqual(configuration, settings());
  assert.deepEqual(contactWithWorkflowClosure(original, configuration.workflows), verified);
});

test("modern workflow stages verify omitted closure flags without guessing from custom status names", () => {
  for (const stage of ["Lead", "Estimating", "Sold", "In Production", "Accounts Receivable", "Completed", "Lost"]) {
    const configuration = settings();
    const status = configuration.workflows[0].status[0];
    delete status.is_closed;
    status.stage = stage;
    const original = contact();
    const verified = contactWithWorkflowClosure(original, configuration.workflows);
    const closed = ["Completed", "Lost"].includes(stage);
    assert.equal(verified.is_closed, closed);
    assert.equal(liveAssignedContactAllowed(verified, OWNER), !closed);
    assert.deepEqual(verified.closureVerification, {
      schemaVersion: 1, source: "jobnimbus_workflow_status", workflowId: "1",
      statusId: "375", isClosed: closed, basis: "workflow_stage", workflowStage: stage
    });
    assert.equal(Object.hasOwn(original, "is_closed"), false);
  }
});

test("unknown stages and contradictory legacy flags never establish closure eligibility", () => {
  for (const stage of [undefined, null, "", "None", "Unknown", "Estimating-ish", "estimating", 2, {}, []]) {
    const configuration = settings();
    const status = configuration.workflows[0].status[0];
    delete status.is_closed;
    status.stage = stage;
    const original = contact();
    assert.equal(contactWithWorkflowClosure(original, configuration), original);
  }
  for (const [is_closed, stage] of [[false, "Completed"], [false, "Lost"], [true, "Estimating"], [null, "Estimating"], ["unknown", "Estimating"], [false, "None"]]) {
    const configuration = settings();
    Object.assign(configuration.workflows[0].status[0], { is_closed, stage });
    const original = contact();
    assert.equal(contactWithWorkflowClosure(original, configuration), original);
  }
});

test("explicit contact closure flags are never overridden, including invalid values", () => {
  for (const is_closed of [true, false, "true", "false", 0, 1, null, "", "unknown", undefined]) {
    const original = { ...contact(), is_closed };
    assert.equal(contactWithWorkflowClosure(original, settings()), original);
  }
});

test("missing, malformed, duplicate, mismatched or inactive workflow evidence never supplies a default", () => {
  const patches = [
    (s) => { delete s.workflows; },
    (s) => { s.workflows = []; },
    (s) => { s.workflows = {}; },
    (s) => { s.workflows.push(structuredClone(s.workflows[0])); },
    (s) => { s.workflows[0].id = 2; },
    (s) => { s.workflows[0].name = "Retail"; },
    (s) => { s.workflows[0].object_type = "job"; },
    (s) => { delete s.workflows[0].is_active; },
    (s) => { s.workflows[0].is_active = false; },
    (s) => { s.workflows[0].status = []; },
    (s) => { s.workflows[0].status.push(structuredClone(s.workflows[0].status[0])); },
    (s) => { s.workflows[0].status[0].id = 376; },
    (s) => { s.workflows[0].status[0].name = "Another status"; },
    (s) => { delete s.workflows[0].status[0].is_closed; },
    (s) => { s.workflows[0].status[0].is_closed = null; },
    (s) => { s.workflows[0].status[0].is_closed = "unknown"; },
    (s) => { delete s.workflows[0].status[0].is_active; },
    (s) => { s.workflows[0].status[0].is_active = false; },
    (s) => { delete s.workflows[0].status[0].is_archived; },
    (s) => { s.workflows[0].status[0].is_archived = true; }
  ];
  for (const patch of patches) {
    const original = contact();
    const configuration = settings();
    patch(configuration);
    assert.equal(contactWithWorkflowClosure(original, configuration), original);
    assert.equal(liveAssignedContactAllowed(original, OWNER), false);
  }
  for (const configuration of [null, [], false, {}, { workflows: [null] }]) {
    const original = contact();
    assert.equal(contactWithWorkflowClosure(original, configuration), original);
  }
  for (const key of ["record_type", "record_type_name", "status", "status_name"]) {
    const original = contact();
    delete original[key];
    assert.equal(contactWithWorkflowClosure(original, settings()), original);
  }
});

test("workflow closure evidence preserves closed, owner, active, archived, deleted and excluded-file denials", () => {
  const closed = settings();
  closed.workflows[0].status[0].is_closed = true;
  assert.equal(liveAssignedContactAllowed(contactWithWorkflowClosure(contact(), closed), OWNER), false);
  for (const patch of [
    { number: "2628" }, { owners: [{ id: "other-owner" }] }, { owners: [] },
    { is_active: false }, { is_archived: true }, { is_deleted: true },
    { is_deleted: "unknown" }, { status_name: "Closed" },
    { id: "different-synthetic-id" }, { record_type_name: "Retail" }
  ]) {
    const verified = contactWithWorkflowClosure({ ...contact(), ...patch }, settings());
    assert.equal(liveAssignedContactAllowed(verified, OWNER), false);
  }
});
