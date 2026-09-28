import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedNoteContentHash, approvedNoteCreatedId, approvedNoteIntentMatches, approvedNoteRecordMatches, validateApprovedNotePayload
} from "./approved-note.js";

test("plain approved note binds exact text and rejects mutation controls or fake mentions", () => {
  const payload = { query: "#2739", note: "Paused due to license." };
  assert.deepEqual(validateApprovedNotePayload(payload), {
    note: payload.note, noteSha256: approvedNoteContentHash(payload.note), mentionRequested: false, intendedRecipient: null
  });
  for (const bad of [
    { ...payload, note: "" }, { ...payload, note: " x " },
    { ...payload, note: "x".repeat(4001) }, { ...payload, note: "<b>Text</b>" },
    { ...payload, note: "@Accounting payment issued" },
    { ...payload, mentions: ["accounting-id"] }, { ...payload, notification: true },
    { ...payload, execute: true }, { ...payload, expectedFileId: "other" },
    { ...payload, operatorScope: "company" }, { ...payload, query: "Client Name" }
  ]) assert.throws(() => validateApprovedNotePayload(bad));
});

test("only one canonical Richard tag binds a requested, not verified, mention", () => {
  const note = "@RichardR: Carrier reports payment issued. Please track the check.";
  const approved = validateApprovedNotePayload({ query: "2739", note });
  assert.equal(approved.note, note);
  assert.equal(approved.mentionRequested, true);
  assert.deepEqual(approved.intendedRecipient, {
    id: "kyd3walzugh6dlji6wpygdj", displayName: "Richard R", tag: "@RichardR"
  });
  for (const bad of [
    "@richard", "@Richard", "@RichardR @RichardR", "@RichardR @Other",
    "email@RichardR", "@RichardRextra", "@RichardR_", "@RichardR-else", "@RichardR\u200b"
  ]) assert.throws(() => validateApprovedNotePayload({ query: "2739", note: bad }));
  const intent = { type: "jobnimbus.create_note", fileId: "exact-file", reconciliation: approved };
  assert.equal(approvedNoteIntentMatches(intent, "exact-file", note), true);
  assert.equal(approvedNoteIntentMatches(intent, "other-file", note), false);
  assert.equal(approvedNoteIntentMatches(intent, "exact-file", note.replace("@RichardR", "Richard")), false);
  for (const changes of [
    { mentionRequested: false }, { intendedRecipient: null },
    { intendedRecipient: { ...approved.intendedRecipient, id: "different-user" } },
    { intendedRecipient: { ...approved.intendedRecipient, tag: "@Other" } }
  ]) assert.equal(approvedNoteIntentMatches({ ...intent, reconciliation: { ...approved, ...changes } }, "exact-file", note), false);
});

test("created note IDs reject missing, short, conflicting and unrelated envelope IDs", () => {
  assert.equal(approvedNoteCreatedId({ jnid: "created-note-1" }), "created-note-1");
  assert.equal(approvedNoteCreatedId({ jnid: "created-note-1", id: "created-note-1" }), "created-note-1");
  for (const result of [{}, { id: "short" }, { jnid: "created-note-1", id: "other-note-01" }, { id: "created-note-1", data: { id: "other-note-01" } }, { message: { id: "created-note-1" } }]) {
    assert.equal(approvedNoteCreatedId(result), "");
  }
});

test("approved note provider proof requires exact ID, primary file, text, Note type and active record", () => {
  const expected = { id: "note-id-001", fileId: "file-id", note: "Payment issued." };
  const record = { jnid: "note-id-001", primary: { id: "file-id" }, note: "Payment issued.", record_type_name: "Note" };
  assert.equal(approvedNoteRecordMatches(record, expected), true);
  for (const changes of [
    { jnid: "wrong" }, { id: "conflicting-id" }, { primary: { id: "wrong" } }, { note: "Payment received." },
    { record_type_name: "Task" }, { is_active: false }, { is_deleted: true },
    { is_archived: true }
  ]) assert.equal(approvedNoteRecordMatches({ ...record, ...changes }, expected), false);
});
