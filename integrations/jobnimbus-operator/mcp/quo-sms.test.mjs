import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  QUO_SMS_TYPE,
  assertQuoSmsPlan,
  assertQuoSmsReceipt,
  quoSmsHash,
  validateQuoSmsPayload
} from "./quo-sms-contract.mjs";
import {
  QUO_SMS_ENABLED,
  QUO_SMS_RELEASE,
  validateQuoSmsRelease
} from "./quo-sms-release.mjs";

const SMS = Object.freeze({
  query: "#990001",
  from: "+12025550101",
  to: "+12025550102",
  content: "Synthetic inspection scheduling message — reply with a convenient time. Saturday at 11:00 or 12:00 also works."
});

test("Quo SMS candidate stays inactive until exact release pins are reviewed", () => {
  assert.equal(QUO_SMS_ENABLED, false);
  assert.equal(validateQuoSmsRelease(QUO_SMS_RELEASE), false);
  const candidate = {
    enabled: true,
    policyId: "chance-58-files-sms-v1",
    policySha256: "a".repeat(64),
    bridgeCommit: "b".repeat(40)
  };
  assert.equal(validateQuoSmsRelease(candidate), true);
  for (const patch of [
    { policyId: "chance-58-files-pdf-v1" },
    { policySha256: "" },
    { bridgeCommit: "" },
    { enabled: "true" }
  ]) assert.throws(() => validateQuoSmsRelease({ ...candidate, ...patch }));
  const live = { ...candidate, policyId: "chance-live-assigned-sms-v1",
    assignmentMode: "live_assigned", assignmentOwnerId: "synthetic-owner" };
  assert.equal(validateQuoSmsRelease(live), true);
  assert.throws(() => validateQuoSmsRelease({ ...live, assignmentOwnerId: "" }));
  assert.throws(() => validateQuoSmsRelease({ ...live, assignmentMode: "company" }));
  assert.throws(() => validateQuoSmsRelease({ ...candidate, assignmentMode: "live_assigned" }));
});

test("Quo SMS contract rejects hidden authority and attests exact plans and receipts", () => {
  const expected = validateQuoSmsPayload({ ...SMS });
  const response = smsPlan();
  assertQuoSmsPlan(response, [{ type: QUO_SMS_TYPE, payload: { ...SMS } }]);
  const receipt = smsReceipt();
  assertQuoSmsReceipt(receipt, SMS);
  for (const mutate of [
    (value) => { value.operations[0].plan.plan.from = "+12025550103"; },
    (value) => { value.operations[0].plan.plan.to = "+12025550104"; },
    (value) => { value.operations[0].plan.plan.content = "Changed"; },
    (value) => { value.operations[0].plan.plan.contentSha256 = "0".repeat(64); },
    (value) => { value.files[0].number = "990002"; }
  ]) {
    const changed = smsPlan();
    mutate(changed);
    assert.throws(() => assertQuoSmsPlan(changed, [{ type: QUO_SMS_TYPE, payload: { ...SMS } }]));
  }
  assert.equal(expected.contentSha256, quoSmsHash(SMS.content));
  for (const patch of [
    { externalId: "" },
    { sender: "+12025550103" },
    { recipient: "+12025550104" },
    { contentSha256: "0".repeat(64) },
    { characterCount: 1 },
    { verifiedByReadback: false },
    { deliveryStatus: "" }
  ]) assert.throws(() => assertQuoSmsReceipt({ ...receipt, ...patch }, SMS));
});

function smsPlan() {
  const expected = validateQuoSmsPayload(SMS);
  return {
    mode: "dry_run",
    batchMode: "assigned_single_file_v2",
    fileCount: 1,
    operationCount: 1,
    displayComplete: true,
    files: [{
      id: "contact-synthetic-alpha",
      number: "990001",
      operationIndexes: [0],
      operationTypes: [QUO_SMS_TYPE]
    }],
    operations: [{
      type: QUO_SMS_TYPE,
      plan: {
        mode: "dry_run",
        file: { id: "contact-synthetic-alpha", number: "990001" },
        plan: {
          from: expected.from,
          to: expected.to,
          content: expected.content,
          characterCount: expected.characterCount,
          contentSha256: expected.contentSha256
        },
        approvalDigest: "2".repeat(64)
      }
    }]
  };
}

function smsReceipt() {
  const expected = validateQuoSmsPayload(SMS);
  return {
    mode: "executed",
    fileId: "contact-synthetic-alpha",
    fileNumber: "990001",
    externalId: "MSG_synthetic_alpha",
    conversationId: "CONV_synthetic_alpha",
    sender: expected.from,
    recipient: expected.to,
    contentSha256: expected.contentSha256,
    characterCount: expected.characterCount,
    verifiedByReadback: true,
    deliveryStatus: "queued",
    deliveryConfirmed: false,
    manualVerificationRequired: false
  };
}

async function enabledCandidate(t, { live = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "enabled-quo-sms-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    "scope.mjs",
    "communications-sweep-release.mjs",
    "gmail-rejected-review-release.mjs",
    "operator-coordinator.mjs",
    "pdf-receipt-resolution.mjs",
    "pdf-receipt-resolution-release.mjs",
    "reviewed-claim-packet.mjs",
    "approved-note-release.mjs",
    "approved-note-plan.mjs",
    "pdf-upload-release.mjs",
    "pdf-upload-contract.mjs",
    "local-pdf.mjs",
    "quo-sms-contract.mjs"
  ]) await copyFile(new URL(`./${file}`, import.meta.url), path.join(root, file));
  const inactiveResolution = await readFile(new URL("./pdf-receipt-resolution-release.mjs", import.meta.url), "utf8");
  await writeFile(path.join(root, "pdf-receipt-resolution-release.mjs"), inactiveResolution.replace(/enabled: (?:true|false)/, "enabled: false"));
  const release = await readFile(new URL("./quo-sms-release.mjs", import.meta.url), "utf8");
  const testRelease = { enabled: true, policyId: live ? "chance-live-assigned-sms-v1" : "chance-58-files-sms-v1",
    policySha256: "a".repeat(64), bridgeCommit: "b".repeat(40),
    ...(live ? { assignmentMode: "live_assigned", assignmentOwnerId: "synthetic-owner" } : {}) };
  await writeFile(
    path.join(root, "quo-sms-release.mjs"),
    release.replace(/export const QUO_SMS_RELEASE = Object.freeze\(\{[\s\S]*?\}\);/,
      `export const QUO_SMS_RELEASE = Object.freeze(${JSON.stringify(testRelease)});`)
  );
  const source = await readFile(new URL("./operator-coordinator.test.mjs", import.meta.url), "utf8");
  const cut = source.indexOf('\ntest("verified session');
  assert.ok(cut > 0);
  await writeFile(
    path.join(root, "fixtures.mjs"),
    source.slice(0, cut)
      + `\nconst originalRunPolicy = runPolicy; runPolicy = () => ({...originalRunPolicy(), ${live ? 'schemaVersion:2, assignmentMode:"live_assigned", assignmentOwnerId:"synthetic-owner", freshAssignmentRequired:true,' : ''} noteCreationAllowed:true, noteMentionsAllowed:false, noteMentionRequestsAllowed:true, noteCreationSoleOperation:true, pdfUploadAllowed:true, pdfUploadSoleOperation:true, pdfUploadContentReadbackRequired:true, pdfUploadMaxBytes:8388608, quoSmsAllowed:true, quoSmsSoleOperation:true, quoSmsExactSenderRequired:true, quoSmsProviderReadbackRequired:true, quoSmsDuplicateProtectionRequired:true});\nexport {whoamiFixture,sessionFixture,policyFixture};`
  );
  const fixtures = await import(pathToFileURL(path.join(root, "fixtures.mjs")));
  const scope = await import(pathToFileURL(path.join(root, "scope.mjs")));
  const { createOperatorCoordinator } = await import(pathToFileURL(path.join(root, "operator-coordinator.mjs")));
  const state = {
    whoami: fixtures.whoamiFixture(),
    session: fixtures.sessionFixture(),
    policy: fixtures.policyFixture(),
    corruptPlan: null,
    corruptReceipt: null,
    now: Date.parse("2090-01-01T00:00:00.000Z")
  };
  const requests = [];
  if (live) state.whoami.identity.jobNimbusOwnerId = "synthetic-owner";
  const approvals = new Map();
  const coordinator = createOperatorCoordinator({
    version: "synthetic",
    approvals,
    now: () => state.now,
    bridgeRequest: async (method, route, body) => {
      requests.push({ method, route, body: structuredClone(body) });
      if (method === "GET") {
        return structuredClone(
          route === "/auth/whoami" ? state.whoami
            : route === "/api/v1/session" ? state.session : state.policy
        );
      }
      if (!body.execute) {
        const result = {
          ...smsPlan(),
          runPolicy: state.policy.runPolicy,
          approvalDigest: "1".repeat(64),
          approvalChallenge: "hidden-challenge",
          approvalExpiresAt: new Date(state.now + 60_000).toISOString()
        };
        state.corruptPlan?.(result);
        return result;
      }
      const expected = validateQuoSmsPayload(SMS);
      const result = {
        mode: "executed",
        batch: {
          schemaVersion: 2,
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          principalHash: "c".repeat(64),
          operatorScope: "assigned",
          bootId: state.policy.bridgeBootId,
          status: "completed",
          operationCount: 1,
          fileCount: 1,
          batchMode: "assigned_single_file_v2",
          runPolicyId: scope.CHANCE_RUN_POLICY.id,
          runPolicySha256: scope.CHANCE_RUN_POLICY.sha256,
          runPolicyExpiresAt: "2099-09-23T05:00:00.000Z",
          approvalDigest: body.approvalDigest,
          files: smsPlan().files,
          intents: [{
            index: 0,
            type: QUO_SMS_TYPE,
            fileId: "contact-synthetic-alpha",
            fileNumber: "990001",
            reconciliation: {
              sender: expected.from,
              recipient: expected.to,
              contentSha256: expected.contentSha256,
              characterCount: expected.characterCount,
              channelApprovalDigest: "2".repeat(64)
            },
            intentDigest: "d".repeat(64)
          }],
          completed: [{ index: 0, type: QUO_SMS_TYPE, status: "executed", receipt: smsReceipt() }],
          notAttempted: [],
          completedAt: new Date(state.now).toISOString()
        }
      };
      state.corruptReceipt?.(result);
      return result;
    }
  });
  return { approvals, coordinator, requests, scope, state };
}

test("reviewed live-assignment plugin binds its owner, not a hardcoded count, and retains one-use approval", async (t) => {
  const f = await enabledCandidate(t, { live: true });
  assert.equal(f.scope.CHANCE_RUN_FILE_COUNT, null);
  const plan = await f.coordinator.planQuoSms(SMS);
  const result = await f.coordinator.executeQuoSms(plan.approvalDigest, f.approvals.get(plan.approvalDigest)?.approvalId);
  assertQuoSmsReceipt(result.batch.completed[0].receipt, SMS);
  assert.equal(f.requests.filter((request) => request.body?.execute === true).length, 1);
  await assert.rejects(f.coordinator.executeQuoSms(plan.approvalDigest, f.approvals.get(plan.approvalDigest)?.approvalId), /No unconsumed local approval/);
});

test("live-assignment owner drift blocks execution and consumes approval", async (t) => {
  const f = await enabledCandidate(t, { live: true });
  const plan = await f.coordinator.planQuoSms(SMS);
  f.state.whoami.identity.jobNimbusOwnerId = "another-synthetic-owner";
  await assert.rejects(f.coordinator.executeQuoSms(plan.approvalDigest, f.approvals.get(plan.approvalDigest)?.approvalId), /owner/);
  assert.equal(f.requests.filter((request) => request.body?.execute === true).length, 0);
  assert.equal(f.approvals.size, 0);
});

test("activated Quo SMS plan survives an async host handoff in one persistent coordinator, then executes once", async (t) => {
  const fixture = await enabledCandidate(t);
  const firstInvocation = () => fixture.coordinator.planQuoSms(SMS);
  const secondInvocation = (approvalDigest) => fixture.coordinator.executeQuoSms(approvalDigest, fixture.approvals.get(approvalDigest)?.approvalId);
  const plan = await firstInvocation();
  assert.equal(JSON.stringify(plan).includes("hidden-challenge"), false);
  assert.equal(plan.operations[0].plan.plan.content, SMS.content);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.approvals.has(plan.approvalDigest), true);
  const result = await secondInvocation(plan.approvalDigest);
  assertQuoSmsReceipt(result.batch.completed[0].receipt, SMS);
  assert.equal(fixture.requests.filter((request) => request.body?.execute === true).length, 1);
  assert.equal(fixture.requests.filter((request) => request.method === "GET").length, 6);
  assert.equal(fixture.approvals.size, 0);
  await assert.rejects(fixture.coordinator.executeQuoSms(plan.approvalDigest, fixture.approvals.get(plan.approvalDigest)?.approvalId), /No unconsumed local approval/);
  assert.equal(fixture.requests.filter((request) => request.body?.execute === true).length, 1);
});

for (const scenario of ["changed_text", "changed_sender", "changed_recipient", "restart", "bad_readback"]) {
  test(`activated Quo SMS lifecycle ${scenario} preserves the appropriate one-use boundary`, async (t) => {
    const fixture = await enabledCandidate(t);
    const plan = await fixture.coordinator.planQuoSms(SMS);
    let operations = [{ type: QUO_SMS_TYPE, payload: { ...SMS } }];
    if (scenario === "changed_text") operations[0].payload.content += " changed";
    if (scenario === "changed_sender") operations[0].payload.from = "+12025550103";
    if (scenario === "changed_recipient") operations[0].payload.to = "+12025550104";
    if (scenario === "restart") await fixture.coordinator.restartVerifiedBridgeSession();
    if (scenario === "bad_readback") {
      fixture.state.corruptReceipt = (result) => {
        result.batch.completed[0].receipt.verifiedByReadback = false;
      };
    }
    if (scenario === "restart") {
      const result = await fixture.coordinator.executeQuoSms(plan.approvalDigest, plan.approvalId);
      assert.equal(result.mode, "executed");
      assert.equal(fixture.requests.filter(r => r.body?.execute).length, 1);
      return;
    }
    await assert.rejects(
      scenario === "changed_text" || scenario === "changed_sender" || scenario === "changed_recipient"
        ? fixture.coordinator.executeActionBatch(plan.approvalDigest, operations, "assigned", fixture.approvals.get(plan.approvalDigest)?.approvalId)
        : fixture.coordinator.executeQuoSms(plan.approvalDigest, fixture.approvals.get(plan.approvalDigest)?.approvalId)
    );
    assert.equal(fixture.approvals.size, 0);
    assert.equal(
      fixture.requests.filter((request) => request.body?.execute === true).length,
      scenario === "bad_readback" ? 1 : 0
    );
  });
}
