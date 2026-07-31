import assert from "node:assert/strict";
import test from "node:test";

import {
  createHcnInvitationApprovalStore
} from "./hcn-invitation-approvals.js";

const SESSION = "a".repeat(64);
const ACTOR = `principal_${"b".repeat(64)}`;

test("invitation approval consumes an unchanged hidden-challenge plan once", () => {
  const fixture = createFixture();
  const plan = createPlan();
  const approval = fixture.store.prepare({
    sessionBinding: SESSION,
    actorRef: ACTOR,
    action: "create",
    plan
  });
  assert.match(
    approval.approvalId,
    /^invite_approval_[a-f0-9]{32}$/
  );
  assert.match(approval.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(approval).includes("challenge"), false);

  const consumed = fixture.store.consume({
    sessionBinding: SESSION,
    actorRef: ACTOR,
    action: "create",
    approvalId: approval.approvalId,
    approvalDigest: approval.approvalDigest
  });
  assert.deepEqual(consumed.plan, plan);
  assert.equal(Object.isFrozen(consumed.plan), true);
  assert.throws(
    () => fixture.store.consume({
      sessionBinding: SESSION,
      actorRef: ACTOR,
      action: "create",
      approvalId: approval.approvalId,
      approvalDigest: approval.approvalDigest
    }),
    (error) => error.code === "approval_not_available"
  );
});

test("changed digest, action, actor, or session consumes and blocks approval", () => {
  for (const changed of [
    { approvalDigest: "0".repeat(64) },
    { action: "revoke" },
    { actorRef: `principal_${"c".repeat(64)}` },
    { sessionBinding: "d".repeat(64) }
  ]) {
    const fixture = createFixture();
    const approval = fixture.store.prepare({
      sessionBinding: SESSION,
      actorRef: ACTOR,
      action: "create",
      plan: createPlan()
    });
    assert.throws(
      () => fixture.store.consume({
        sessionBinding: SESSION,
        actorRef: ACTOR,
        action: "create",
        approvalId: approval.approvalId,
        approvalDigest: approval.approvalDigest,
        ...changed
      }),
      (error) => error.code === "approval_changed_or_expired"
    );
    assert.throws(
      () => fixture.store.consume({
        sessionBinding: SESSION,
        actorRef: ACTOR,
        action: "create",
        approvalId: approval.approvalId,
        approvalDigest: approval.approvalDigest
      }),
      (error) => error.code === "approval_not_available"
    );
  }
});

test("expired and superseded approvals fail closed", () => {
  const fixture = createFixture();
  const first = fixture.store.prepare({
    sessionBinding: SESSION,
    actorRef: ACTOR,
    action: "create",
    plan: createPlan()
  });
  const second = fixture.store.prepare({
    sessionBinding: SESSION,
    actorRef: ACTOR,
    action: "revoke",
    plan: {
      action: "revoke",
      invitationRef: `invite_${"1".repeat(32)}`,
      email: "employee@example.com"
    }
  });
  assert.throws(
    () => fixture.store.consume({
      sessionBinding: SESSION,
      actorRef: ACTOR,
      action: "create",
      approvalId: first.approvalId,
      approvalDigest: first.approvalDigest
    }),
    (error) => error.code === "approval_not_available"
  );
  fixture.advance(5 * 60_000);
  assert.throws(
    () => fixture.store.consume({
      sessionBinding: SESSION,
      actorRef: ACTOR,
      action: "revoke",
      approvalId: second.approvalId,
      approvalDigest: second.approvalDigest
    }),
    (error) =>
      ["approval_not_available", "approval_changed_or_expired"]
        .includes(error.code)
  );
});

test("digest covers hidden provider binding and management privilege", () => {
  const fixture = createFixture();
  const base = createPlan();
  const first = fixture.store.prepare({
    sessionBinding: SESSION,
    actorRef: ACTOR,
    action: "create",
    plan: base
  });
  const second = fixture.store.prepare({
    sessionBinding: "e".repeat(64),
    actorRef: ACTOR,
    action: "create",
    plan: {
      ...base,
      jobNimbusOwnerId: "different-owner"
    }
  });
  const third = fixture.store.prepare({
    sessionBinding: "f".repeat(64),
    actorRef: ACTOR,
    action: "create",
    plan: {
      ...base,
      managementVisibility:
        "company_configured_adjuster_activity_sweep_read"
    }
  });
  assert.notEqual(first.approvalDigest, second.approvalDigest);
  assert.notEqual(first.approvalDigest, third.approvalDigest);
});

function createPlan() {
  return {
    action: "create",
    email: "employee@example.com",
    displayName: "Employee",
    role: "employee",
    jobNimbusOwnerId: "jn-owner",
    jobNimbusScope: "assigned",
    managementVisibility: "none",
    invitationExpiresAt: "2026-08-02T12:00:00.000Z",
    jobNimbusMatch: {
      verified: true,
      active: true
    }
  };
}

function createFixture() {
  let now = Date.parse("2026-07-30T12:00:00.000Z");
  let counter = 0;
  const store = createHcnInvitationApprovalStore({
    now: () => now,
    randomBytes: (count) => {
      counter += 1;
      return Buffer.alloc(count, counter);
    }
  });
  return {
    store,
    advance(milliseconds) {
      now += milliseconds;
    }
  };
}
