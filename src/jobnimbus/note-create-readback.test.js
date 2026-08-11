import assert from "node:assert/strict";
import test from "node:test";

import {
  JobNimbusNoteCreateVerificationError,
  verifyCreatedJobNimbusNote
} from "./note-create-readback.js";

const FILE_ID = "provider-file-private";
const NOTE_ID = "provider-created-note-private";
const NOTE = "Approved exact note text.";

test("created JobNimbus note succeeds only after one exact fresh readback", async () => {
  const calls = [];
  const record = noteRecord();
  const verified = await verifyCreatedJobNimbusNote({
    createResult: { data: { jnid: NOTE_ID } },
    expectedFileId: FILE_ID,
    expectedNote: NOTE,
    readActivity: async (providerRecordId) => {
      calls.push(providerRecordId);
      return record;
    }
  });

  assert.deepEqual(calls, [NOTE_ID]);
  assert.equal(verified.providerRecordId, NOTE_ID);
  assert.equal(verified.record, record);
});

test("created JobNimbus note rejects a wrong record id, type, file, or note", async (t) => {
  const cases = [
    ["record id", { jnid: "different-created-note" }, "created_record_id_mismatch"],
    ["record type", { type_name: "Event" }, "created_record_type_mismatch"],
    ["selected file", { primary: { id: "different-file" } }, "created_record_file_mismatch"],
    ["approved text", { note: "Different note text." }, "note_material_mismatch"]
  ];

  for (const [name, override, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyCreatedJobNimbusNote({
          createResult: { jnid: NOTE_ID },
          expectedFileId: FILE_ID,
          expectedNote: NOTE,
          readActivity: async () => ({ ...noteRecord(), ...override })
        }),
        verificationError(code)
      );
    });
  }
});

test("created JobNimbus note requires one unambiguous returned provider id", async () => {
  let readCount = 0;
  for (const createResult of [
    {},
    { jnid: NOTE_ID, id: "different-created-note" },
    { jnid: " padded-created-note " }
  ]) {
    await assert.rejects(
      verifyCreatedJobNimbusNote({
        createResult,
        expectedFileId: FILE_ID,
        expectedNote: NOTE,
        readActivity: async () => {
          readCount += 1;
          return noteRecord();
        }
      }),
      verificationError("missing_created_record_id")
    );
  }
  assert.equal(readCount, 0);
});

test("created JobNimbus note converts readback timeout or malformed JSON into no-retry reconciliation", async () => {
  for (const failure of [
    new Error("fixture timeout detail must not escape"),
    new SyntaxError("fixture malformed JSON detail must not escape")
  ]) {
    await assert.rejects(
      verifyCreatedJobNimbusNote({
        createResult: { jnid: NOTE_ID },
        expectedFileId: FILE_ID,
        expectedNote: NOTE,
        readActivity: async () => { throw failure; }
      }),
      (error) => {
        assert.ok(error instanceof JobNimbusNoteCreateVerificationError);
        assert.equal(error.code, "readback_unavailable");
        assert.equal(error.outcome, "reconciliation_required");
        assert.equal(error.automaticRetry, false);
        assert.doesNotMatch(error.message, /fixture|timeout|malformed/i);
        return true;
      }
    );
  }
});

function noteRecord() {
  return {
    jnid: NOTE_ID,
    record_type_name: "Note",
    note: NOTE,
    primary: { id: FILE_ID }
  };
}

function verificationError(code) {
  return (error) => (
    error instanceof JobNimbusNoteCreateVerificationError
    && error.code === code
    && error.outcome === "reconciliation_required"
    && error.automaticRetry === false
  );
}
