import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_NOTE_RELEASE, APPROVED_NOTES_ENABLED, RICHARD_MENTION_RECIPIENT, approvedNoteMentionIntent, validateApprovedNoteRelease, validateApprovedNoteOperation } from "./approved-note-release.mjs";
import { PDF_UPLOAD_RELEASE, PDF_UPLOADS_ENABLED } from "./pdf-upload-release.mjs";
import { CHANCE_RUN_ACTION_TYPES, CHANCE_RUN_POLICY, EXPECTED_BRIDGE_BUILD, scopedOperations } from "./scope.mjs";

const operation = (payload = { query: "#2745", note: "Paused due to license." }) => [{ type: "jobnimbus.create_note", payload }];
const release = { enabled: true, policyId: "chance-58-files-notes-v1", policySha256: "a".repeat(64), bridgeCommit: "b".repeat(40) };
const EFFECTIVE_NOTES_ENABLED = APPROVED_NOTES_ENABLED || PDF_UPLOADS_ENABLED;
const ACTIVE_RELEASE = PDF_UPLOADS_ENABLED ? PDF_UPLOAD_RELEASE : APPROVED_NOTE_RELEASE;

test("compiled release requires exact pins and keeps disabled releases closed", () => {
  assert.equal(Object.isFrozen(APPROVED_NOTE_RELEASE), true);
  assert.equal(CHANCE_RUN_ACTION_TYPES.includes("jobnimbus.create_note"), EFFECTIVE_NOTES_ENABLED);
  if (EFFECTIVE_NOTES_ENABLED) {
    assert.equal(CHANCE_RUN_POLICY.id, ACTIVE_RELEASE.policyId);
    assert.equal(CHANCE_RUN_POLICY.sha256, ACTIVE_RELEASE.policySha256);
    assert.equal(EXPECTED_BRIDGE_BUILD.sourceCommit, ACTIVE_RELEASE.bridgeCommit);
    assert.match(CHANCE_RUN_POLICY.sha256, /^[a-f0-9]{64}$/);
    assert.match(EXPECTED_BRIDGE_BUILD.sourceCommit, /^[a-f0-9]{40}$/);
    assert.doesNotThrow(() => scopedOperations(operation(), "assigned"));
  } else {
    assert.equal(CHANCE_RUN_POLICY.id, "chance-58-files-v1");
    assert.equal(CHANCE_RUN_POLICY.sha256, "40c8a7d418d9349b0b3315b693ce70486040092dcef250043f3397dc10a1c458");
    assert.equal(EXPECTED_BRIDGE_BUILD.sourceCommit, "49465dded1707d5be6c019fd99de0baa90393c10");
    assert.throws(() => scopedOperations(operation(), "assigned"), /not activated/);
  }
  assert.throws(() => validateApprovedNoteOperation(operation(), "assigned", { enabled: false }), /not activated/);
});

test("activation needs exact reviewed pins rather than a boolean toggle", () => {
  assert.equal(validateApprovedNoteRelease(release), true);
  for (const patch of [{ policySha256: "" }, { bridgeCommit: "" }, { policyId: "chance-58-files-v1" }, { enabled: "true" }]) {
    assert.throws(() => validateApprovedNoteRelease({ ...release, ...patch }), /reviewed exact/);
  }
});

test("note validation preserves exact approved body and rejects extra authority", () => {
  const operations = operation();
  const before = JSON.stringify(operations);
  validateApprovedNoteOperation(operations, "assigned", { enabled: true });
  assert.equal(JSON.stringify(operations), before);
  for (const query of ["#2628", "2628", "Marc Maldonado", "#2745 extra", 2745, ""]) {
    assert.throws(() => validateApprovedNoteOperation(operation({ query, note: "Test" }), "assigned", { enabled: true }));
  }
  for (const key of ["execute", "runPolicy", "mentions", "notificationIds", "primary", "operatorScope", "date_created"]) {
    assert.throws(() => validateApprovedNoteOperation(operation({ query: "#2745", note: "Test", [key]: true }), "assigned", { enabled: true }));
  }
});

test("notes remain one-operation and only accept one canonical Richard mention request", () => {
  assert.throws(() => validateApprovedNoteOperation([...operation(), ...operation()], "assigned", { enabled: true }), /sole/);
  assert.throws(() => validateApprovedNoteOperation(operation(), "company", { enabled: true }), /sole/);
  for (const note of ["", "  ", "x".repeat(4001), "Hello\u0000", "@Accounting Check issued.", "<span data-mention-id='x'>@Person</span>", "@richard", "@Richard", "@RichardR2", "name@RichardR", "@RichardR @RichardR", "@RichardR name@example.com"]) {
    assert.throws(() => validateApprovedNoteOperation(operation({ query: "#2745", note }), "assigned", { enabled: true }));
  }
  for (const note of ["@RichardR", "Check received. @RichardR", "@RichardR: check received.", "Check received.\n@RichardR, please review."]) {
    assert.doesNotThrow(() => validateApprovedNoteOperation(operation({ query: "#2745", note }), "assigned", { enabled: true }));
    assert.deepEqual(approvedNoteMentionIntent(note), { mentionRequested: true, intendedRecipient: RICHARD_MENTION_RECIPIENT });
  }
  assert.deepEqual(approvedNoteMentionIntent("Check received."), { mentionRequested: false, intendedRecipient: null });
});
