import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { refreshFileSnapshot } from "./fileSnapshot.js";
import {
  createOperationalAdvisory,
  operationalState,
  reconcileOperationalState
} from "./operationalBrain.js";

function fixtureSnapshot(config, overrides = {}) {
  const now = "2026-07-24T12:00:00.000Z";
  return refreshFileSnapshot(config, {
    subjectKey: "fixture-contact",
    file: {
      id: "fixture-contact",
      number: "2733",
      name: "Fixture Homeowner",
      status: "Negotiating",
      carrier: "Fixture Carrier",
      claimNumber: "CLAIM-1",
      policyNumber: "POLICY-1",
      ...overrides.file
    },
    liveJobNimbus: {
      recentActivities: [],
      openTasks: [{
        id: "task-appointment",
        title: "Adjuster appointment",
        createdAt: "2026-07-23T14:00:00.000Z",
        dateStart: "2026-07-25T13:00:00.000Z",
        dateEnd: "2026-07-25T15:00:00.000Z",
        completed: false
      }],
      operationalDocuments: [],
      ...(overrides.liveJobNimbus || {})
    },
    gmail: { status: "fresh", messages: [], threads: [], ...(overrides.gmail || {}) },
    quo: { status: "fresh", timeline: [], transcripts: [], ...(overrides.quo || {}) },
    sourceStatus: {
      jobNimbus: { status: "fresh", at: now },
      gmail: { status: "fresh", at: now },
      quo: { status: "fresh", at: now },
      ...(overrides.sourceStatus || {})
    },
    factualSignals: {},
    actionReceipts: []
  });
}

test("scheduled inspection without homeowner confirmation creates one durable approval-gated loop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-brain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const snapshot = fixtureSnapshot(config);

  const first = reconcileOperationalState(config, snapshot, { now: "2026-07-24T12:00:00.000Z" });
  const loop = first.openLoops.find((item) => item.ruleId === "appointment.homeowner_confirmation");
  assert.ok(loop);
  assert.equal(loop.priority, "high");
  assert.equal(loop.proposedAction.type, "quo.send_text");
  assert.equal(loop.requiresSeparateApproval, true);
  assert.equal(loop.authority.automaticExternalActions, false);

  const second = reconcileOperationalState(config, snapshot, { now: "2026-07-24T12:05:00.000Z" });
  assert.equal(second.openLoops.filter((item) => item.ruleId === loop.ruleId).length, 1);
  assert.equal(second.openLoops.find((item) => item.ruleId === loop.ruleId).id, loop.id);
});

test("fresh affirmative Quo response resolves the appointment loop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const unconfirmed = fixtureSnapshot(config);
  const initial = reconcileOperationalState(config, unconfirmed, { now: "2026-07-24T12:00:00.000Z" });
  assert.equal(initial.openLoops.some((item) => item.ruleId === "appointment.homeowner_confirmation"), true);

  const confirmed = fixtureSnapshot(config, {
    quo: {
      timeline: [
        {
          id: "text-out",
          at: "2026-07-24T12:10:00.000Z",
          direction: "outgoing",
          status: "delivered",
          text: "Your adjuster inspection is Friday between 8:00 AM and 10:00 AM. Will you be available for access?"
        },
        {
          id: "text-in",
          at: "2026-07-24T12:12:00.000Z",
          direction: "incoming",
          status: "received",
          text: "Yes, I will be available."
        }
      ]
    }
  });
  const result = reconcileOperationalState(config, confirmed, { now: "2026-07-24T12:15:00.000Z" });
  assert.equal(result.openLoops.some((item) => item.ruleId === "appointment.homeowner_confirmation"), false);
  assert.equal(result.recentResolvedLoops.some((item) => item.ruleId === "appointment.homeowner_confirmation"), true);
});

test("source outage preserves an existing loop instead of falsely resolving it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-outage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  reconcileOperationalState(config, fixtureSnapshot(config), { now: "2026-07-24T12:00:00.000Z" });

  const unavailable = fixtureSnapshot(config, {
    quo: { status: "unavailable", error: "fixture outage" },
    sourceStatus: { quo: { status: "unavailable", at: "2026-07-24T12:10:00.000Z" } }
  });
  const result = reconcileOperationalState(config, unavailable, { now: "2026-07-24T12:10:00.000Z" });
  assert.equal(result.openLoops.some((item) => item.ruleId === "appointment.homeowner_confirmation"), true);
  assert.equal(result.indeterminateRules.some((item) => item.ruleId === "appointment.homeowner_confirmation"), true);
});

test("Ready for PA Review creates a claim-path review loop rather than assuming a new claim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-pa-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const snapshot = fixtureSnapshot(config, {
    file: { status: "Ready for PA Review", claimNumber: "" },
    liveJobNimbus: { openTasks: [] }
  });
  const result = reconcileOperationalState(config, snapshot, { now: "2026-07-24T12:00:00.000Z" });
  const loop = result.openLoops.find((item) => item.ruleId === "thresher.ready_for_pa_review");
  assert.ok(loop);
  assert.match(loop.proposedAction.draftGuidance, /do not assume/i);
});

test("optional provider-neutral advisory is source-cited, approval-gated, data-minimized, and cached", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const snapshot = fixtureSnapshot(config);
  const operational = reconcileOperationalState(config, snapshot, { now: "2026-07-24T12:00:00.000Z" });
  const primary = operational.openLoops.find((item) => item.ruleId === "appointment.homeowner_confirmation");
  let request;
  let calls = 0;
  const provider = {
    provider: "zai",
    model: "glm-4.7-flash",
    async generate(input) {
      calls++;
      request = input;
      const providerLoop = input.userPayload.openLoops.find((loop) => loop.ruleId === primary.ruleId);
      const sourceId = providerLoop.sourceIds[0];
      return {
        output: {
          summary: "The appointment is scheduled but homeowner confirmation is missing.",
          primaryLoopId: providerLoop.id,
          recommendedAction: "Prepare a confirmation text for Chance's approval.",
          rationale: "The scheduled task is current and no confirmed response is present.",
          uncertainties: ["Access availability is unknown."],
          sourceIds: [sourceId],
          requiresSeparateApproval: true
        },
        provenance: {
          provider: "zai",
          requestedModel: "glm-4.7-flash",
          toolCallCount: 0,
          executionAuthority: false,
          externalActionAuthorized: false
        }
      };
    }
  };

  const first = await createOperationalAdvisory(config, snapshot, operational, {
    providers: [provider]
  });
  assert.equal(first.status, "created");
  assert.equal(first.advisory.advisory.requiresSeparateApproval, true);
  assert.equal(first.advisory.provider, "zai");
  assert.equal(first.advisory.model, "glm-4.7-flash");
  assert.equal(first.advisory.provenance.toolCallCount, 0);
  assert.equal(first.advisory.advisory.primaryLoopId, primary.id);
  assert.equal(first.advisory.advisory.sourceIds[0], primary.evidence[0].id);
  assert.equal(request.userPayload.file.name, undefined);
  assert.equal(JSON.stringify(request.userPayload).includes("Fixture Homeowner"), false);
  assert.equal(JSON.stringify(request.userPayload).includes(primary.id), false);
  assert.equal(JSON.stringify(request.userPayload).includes(primary.evidence[0].id), false);
  assert.match(request.userPayload.openLoops[0].id, /^loop-\d+$/);
  assert.match(request.userPayload.sources[0].id, /^source-\d+$/);
  assert.equal(request.userPayload.dataPolicy, "private_exact_client_operational_evidence");

  const second = await createOperationalAdvisory(config, snapshot, operational, {
    providers: [provider]
  });
  assert.equal(second.status, "cached");
  assert.equal(calls, 1);
  assert.equal(operationalState(config, snapshot.subjectKey).openLoops.length > 0, true);
});

test("operational advisory uses an explicitly configured fallback once without granting authority", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave-operational-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root, memoryRoot: root };
  const snapshot = fixtureSnapshot(config);
  const operational = reconcileOperationalState(config, snapshot, { now: "2026-07-24T12:00:00.000Z" });
  const primary = operational.openLoops.find((item) => item.ruleId === "appointment.homeowner_confirmation");
  const failed = {
    provider: "zai",
    model: "glm-4.7-flash",
    async generate() {
      const error = new Error("fixture rate limit");
      error.code = "rate_limit";
      throw error;
    }
  };
  const fallback = {
    provider: "openai",
    model: "gpt-5.6-luna",
    async generate(input) {
      const providerLoop = input.userPayload.openLoops.find((loop) => loop.ruleId === primary.ruleId);
      return {
        output: {
          summary: "Confirmation remains missing.",
          primaryLoopId: providerLoop.id,
          recommendedAction: "Prepare a confirmation message for approval.",
          rationale: "The appointment task is current.",
          uncertainties: ["Access is unconfirmed."],
          sourceIds: [providerLoop.sourceIds[0]],
          requiresSeparateApproval: true
        },
        provenance: {
          provider: "openai",
          requestedModel: "gpt-5.6-luna",
          toolCallCount: 0,
          executionAuthority: false,
          externalActionAuthorized: false
        }
      };
    }
  };

  const result = await createOperationalAdvisory(config, snapshot, operational, {
    providers: [failed, fallback]
  });
  assert.equal(result.status, "created");
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.failedProviders, [{
    provider: "zai",
    model: "glm-4.7-flash",
    code: "rate_limit"
  }]);
  assert.equal(result.advisory.provider, "openai");
  assert.equal(result.advisory.authority.automaticExternalActions, false);
});
