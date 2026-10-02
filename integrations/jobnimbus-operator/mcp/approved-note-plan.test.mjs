import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertApprovedNotePlan } from "./approved-note-plan.mjs";
import { approvedNoteMentionIntent } from "./approved-note-release.mjs";

const note = "Paused due to license.";
const operations = [{ type: "jobnimbus.create_note", payload: { query: "#2739", note } }];
const options = { enabled: true };
const fixture = (text = note) => ({
  mode: "dry_run", batchMode: "assigned_single_file_v2", fileCount: 1, operationCount: 1,
  displayComplete: true, executionSemantics: "sequential_fail_stop_no_rollback",
  files: [{ id: "contact-chance", number: "2739", operationIndexes: [0], operationTypes: ["jobnimbus.create_note"] }],
  operations: [{ type: "jobnimbus.create_note", plan: {
    mode: "dry_run", file: { id: "contact-chance", number: 2739, name: "Fixture Client" },
    plan: {
      endpoint: "/activities", note: text, noteSha256: createHash("sha256").update(text).digest("hex"),
      ...approvedNoteMentionIntent(text),
      mentionsVerified: false, accountingNotified: false, beforeIds: ["existing-note-1"],
      notificationNotice: text.includes("@")
        ? "The exact @RichardR tag will be saved. Notification delivery to Richard is not confirmed by the API."
        : "No notification requested.",
      body: { note: text, record_type_name: "Note", primary: { id: "contact-chance" } }
    }
  } }]
});

test("note plan attestation fails when disabled and accepts only the exact enabled plain-note display", () => {
  const response = fixture();
  assert.throws(() => assertApprovedNotePlan(response, operations, "assigned", { enabled: false }), /not activated/);
  assertApprovedNotePlan(response, operations, "assigned", options);
  assertApprovedNotePlan(response, [{ ...operations[0], payload: { query: "2739", note } }], "assigned", options);
  assert.throws(() => assertApprovedNotePlan(response, operations, "company", options));
  assert.doesNotThrow(() => assertApprovedNotePlan({}, [{ type: "jobnimbus.update_contact" }], "assigned"));
});

test("note plans reject omitted, altered, mixed-file, and notification-bearing displays", async (t) => {
  const cases = [
    ["missing display", (r) => { delete r.operations; }],
    ["missing file", (r) => { delete r.files; }],
    ["executed result", (r) => { r.mode = "executed"; }],
    ["wrong count", (r) => { r.operationCount = 2; }],
    ["extra operation", (r) => { r.operations.push(structuredClone(r.operations[0])); }],
    ["wrong batch file", (r) => { r.files[0].number = "2741"; }],
    ["wrong operation descriptor", (r) => { r.files[0].operationIndexes = [1]; }],
    ["wrong prepared file", (r) => { r.operations[0].plan.file.id = "other-contact"; }],
    ["wrong prepared number", (r) => { r.operations[0].plan.file.number = 2741; }],
    ["wrong endpoint", (r) => { r.operations[0].plan.plan.endpoint = "/tasks"; }],
    ["changed display text", (r) => { r.operations[0].plan.plan.note += " Changed."; }],
    ["changed display hash", (r) => { r.operations[0].plan.plan.noteSha256 = "a".repeat(64); }],
    ["changed provider text", (r) => { r.operations[0].plan.plan.body.note += " Changed."; }],
    ["changed provider file", (r) => { r.operations[0].plan.plan.body.primary.id = "other-contact"; }],
    ["changed provider type", (r) => { r.operations[0].plan.plan.body.record_type_name = "Task"; }],
    ["extra provider field", (r) => { r.operations[0].plan.plan.body.mentions = ["richard"]; }],
    ["extra plan field", (r) => { r.operations[0].plan.plan.notifications = true; }],
    ["claimed mention", (r) => { r.operations[0].plan.plan.mentionsVerified = true; }],
    ["claimed notification", (r) => { r.operations[0].plan.plan.accountingNotified = true; }],
    ["omitted notification truth", (r) => { delete r.operations[0].plan.plan.accountingNotified; }],
    ["omitted mention intent", (r) => { delete r.operations[0].plan.plan.mentionRequested; }],
    ["omitted plain-note recipient", (r) => { delete r.operations[0].plan.plan.intendedRecipient; }],
    ["misleading notification notice", (r) => { r.operations[0].plan.plan.notificationNotice = "Richard will be notified."; }],
    ["ambiguous inventory", (r) => { r.operations[0].plan.plan.beforeIds.push("existing-note-1"); }]
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => {
      const response = fixture();
      change(response);
      assert.throws(() => assertApprovedNotePlan(response, operations, "assigned", options), /approval display/);
    });
  }
});

test("Richard mention approval binds exact canonical text, recipient and unverified-delivery notice", () => {
  const text = "Check received. @RichardR Please review.";
  const requested = [{ type: "jobnimbus.create_note", payload: { query: "#2739", note: text } }];
  assertApprovedNotePlan(fixture(text), requested, "assigned", options);
  for (const mutate of [
    (p) => { p.mentionRequested = false; },
    (p) => { p.intendedRecipient = null; },
    (p) => { p.intendedRecipient.id = "different-user"; },
    (p) => { p.intendedRecipient.tag = "@Richard"; },
    (p) => { p.intendedRecipient.displayName = "Another Richard"; },
    (p) => { p.intendedRecipient.notificationIds = ["extra-id"]; },
    (p) => { p.notificationNotice = "Richard was notified."; },
    (p) => { p.mentionsVerified = true; },
    (p) => { p.accountingNotified = true; }
  ]) {
    const invalid = fixture(text);
    mutate(invalid.operations[0].plan.plan);
    assert.throws(() => assertApprovedNotePlan(invalid, requested, "assigned", options), /approval display/);
  }
});

test("the coordinator never stores or executes an altered note display", async () => {
  const url = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  // Activate only in-memory source for this contract test. Existing coordinator
  // tests cover the complete boundary; mock it here to isolate approval storage.
  const releaseSource = await readFile(new URL("./approved-note-release.mjs", import.meta.url), "utf8");
  const releaseUrl = url(releaseSource.replace(/enabled: (?:false|true)/, "enabled: true")
    .replace(/policySha256: "[a-f0-9]*"/, `policySha256: "${"a".repeat(64)}"`)
    .replace(/bridgeCommit: "[a-f0-9]*"/, `bridgeCommit: "${"b".repeat(40)}"`));
  const helperSource = await readFile(new URL("./approved-note-plan.mjs", import.meta.url), "utf8");
  const helperUrl = url(helperSource.replace('"./approved-note-release.mjs"', JSON.stringify(releaseUrl)));
  const scopeUrl = url(`
    export const CHANCE_RUN_ACTION_TYPES = ["jobnimbus.create_note"],
      CHANCE_RUN_ALLOWED_CONTACT_FIELDS = [], CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES = [],
      CHANCE_RUN_EXCLUDED_FILE_NUMBERS = ["2628"], CHANCE_RUN_FILE_COUNT = 58,
      CHANCE_LEGACY_ISOLATION = {entries: []}, CHANCE_RUN_POLICY = {}, EXPECTED_BRIDGE_BUILD = {};
    export const assertDedicatedMacOperatorIdentity = () => {}, assertExecutionReceiptAttestation = () => {},
      assertLegacyIsolationAttestation = () => {}, assertPlatformSessionAttestation = () => {},
      assertReconciliationReceiptAttestation = () => {}, assertRunPolicyAttestation = () => {};
    export const approvalBoundary = () => ({bridgeBootId: "fixture-boot"}),
      assertRestartBoundary = () => ({ready: true}), scopedOperations = (operations) => operations;
  `);
  const source = await readFile(new URL("./operator-coordinator.mjs", import.meta.url), "utf8");
  const { createOperatorCoordinator } = await import(url(source
    .replace('"./scope.mjs"', JSON.stringify(scopeUrl))
    .replace('"./pdf-upload-contract.mjs"', JSON.stringify(new URL("./pdf-upload-contract.mjs", import.meta.url).href))
    .replace('"./pdf-upload-release.mjs"', JSON.stringify(new URL("./pdf-upload-release.mjs", import.meta.url).href))
    .replace('"./local-pdf.mjs"', JSON.stringify(new URL("./local-pdf.mjs", import.meta.url).href))
    .replace('"./approved-note-plan.mjs"', JSON.stringify(helperUrl))));
  for (const mutation of [null,
    (r) => { delete r.operations; },
    (r) => { r.operations[0].plan.plan.note = "Another note."; },
    (r) => { r.operations[0].plan.plan.body.note = "Another note."; }
  ]) {
    const response = { ...fixture(), approvalDigest: "fixture-digest", approvalChallenge: "fixture-challenge", approvalExpiresAt: "2099-01-01T00:00:00Z" };
    mutation?.(response);
    const approvals = new Map([["old-plan", {}]]);
    const posts = [];
    const coordinator = createOperatorCoordinator({ version: "fixture", approvals,
      bridgeRequest: async (method, pathname, body) => {
        if (method === "GET") return {};
        posts.push({ pathname, body });
        return structuredClone(response);
      }
    });
    if (mutation) {
      await assert.rejects(coordinator.planActionBatch(operations), /approval display/);
      assert.equal(approvals.size, 0);
      await assert.rejects(coordinator.executeActionBatch("fixture-digest", operations, "assigned"), /No unconsumed local approval/);
    } else {
      const shown = await coordinator.planActionBatch(operations);
      assert.equal(approvals.size, 1);
      assert.equal(shown.operations[0].plan.plan.note, note);
      assert.equal(Object.hasOwn(shown, "approvalChallenge"), false);
    }
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.execute, false);
  }
});
