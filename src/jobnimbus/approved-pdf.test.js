import assert from "node:assert/strict";
import test from "node:test";
import { createApprovedPdfService, pdfRecordChecks, assertPdfRecord, pdfDocumentMetadata } from "./approved-pdf.js";
import { pdfHash } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

const bytes = Buffer.from("%PDF-1.4\nSynthetic reviewed bytes\n%%EOF\n");
const fileId = "synthetic-client-1";
const id = "synthetic-document-1";
const metadata = { filename: "Reviewed.pdf", contentType: "application/pdf", sizeBytes: bytes.length,
  sha256: pdfHash(bytes), isPrivate: true };
const record = () => ({ jnid: id, name: metadata.filename, size: bytes.length, is_private: true, related: [{ id: fileId }] });
const intent = { fileId, reconciliation: { ...metadata, beforeIds: [] } };

function fixture(inventories = [[record()], [record()]], download = bytes) {
  const calls = [];
  const service = createApprovedPdfService({
    listFiles: async (target) => { calls.push(["list", target]); return inventories.shift(); },
    readBytes: async (target) => { calls.push(["bytes", target]); return download; },
    readDocument: async () => assert.fail("Undocumented single-file metadata route called"),
    reserve: async () => assert.fail("Recovery reserved an upload"),
    put: async () => assert.fail("Recovery uploaded bytes"),
    complete: async () => assert.fail("Recovery completed an upload")
  });
  return { service, calls };
}

test("read-only recovery uses exact-file list metadata before and after byte verification", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.reconcile(intent, id), { applied: true, externalId: id });
  assert.deepEqual(calls, [["list", fileId], ["bytes", id], ["list", fileId]]);
});

for (const [name, rows] of [
  ["missing", []], ["non-array", {}], ["over-bound", Array(5001).fill(record())],
  ["duplicate ID", [record(), record()]],
  ["conflicting ID", [{ ...record(), id: "other-document" }]],
  ["cross-file", [{ ...record(), related: [{ id: "other-client" }] }]],
  ["mixed-file", [{ ...record(), primary: { id: "other-client" } }]],
  ["unbound", [{ ...record(), related: [] }]],
  ["wrong filename", [{ ...record(), name: "Other.pdf" }]],
  ["wrong privacy", [{ ...record(), is_private: false }]],
  ["conflicting privacy", [{ ...record(), isPrivate: false }]],
  ["wrong size", [{ ...record(), size: bytes.length + 1 }]],
  ["deleted", [{ ...record(), is_deleted: true }]],
  ["archived", [{ ...record(), is_archived: true }]]
]) {
  test(`recovery rejects ${name} inventory before reading bytes`, async () => {
    const { service, calls } = fixture([rows]);
    await assert.rejects(service.reconcile(intent, id), { statusCode: 409 });
    assert.deepEqual(calls, [["list", fileId]]);
  });
  test(`recovery rejects ${name} inventory after reading bytes`, async () => {
    const { service } = fixture([[record()], rows]);
    await assert.rejects(service.reconcile(intent, id), { statusCode: 409 });
  });
}

test("recovery rejects altered bytes and does not issue another metadata read", async () => {
  const { service, calls } = fixture([[record()]], Buffer.from("altered"));
  await assert.rejects(service.reconcile(intent, id), { statusCode: 409 });
  assert.deepEqual(calls, [["list", fileId], ["bytes", id]]);
});

test("recovery refuses an ID that predates the approved upload", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.reconcile({ ...intent, reconciliation: { ...metadata, beforeIds: [id] } }, id), { statusCode: 409 });
  assert.deepEqual(calls, []);
});

test("metadata diagnostics distinguish an absent privacy flag from a mismatch without weakening either guard", () => {
  const missing = record(); delete missing.is_private;
  for (const [row, expected] of [[missing, ["privacy_present", "privacy_matches"]],
    [{ ...record(), is_private: false }, ["privacy_matches"]],
    [{ ...record(), is_private: "true" }, ["privacy_matches"]]]) {
    const failures = Object.entries(pdfRecordChecks(row, id, fileId, metadata)).filter(([, ok]) => !ok).map(([key]) => key);
    assert.deepEqual(failures, expected);
    assert.throws(() => assertPdfRecord(row, id, fileId, metadata), (error) => error.statusCode === 409
      && expected.every((key) => error.message.includes(key)));
  }
});

test("diagnostic messages contain only static check labels, never provider bodies or filenames", () => {
  const secret = "https://private.example/?token=synthetic-secret";
  assert.throws(() => assertPdfRecord({ ...record(), name: secret, filename: secret, is_private: secret }, id, fileId, metadata), (error) => {
    assert.match(error.message, /filename_matches, privacy_matches/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("exact-document metadata exposes only typed allowlisted fields and grants no receipt resolution", () => {
  const row = { ...record(), downloadUrl: "https://private.example/signed", token: "synthetic-secret", description: "untrusted text" };
  const result = pdfDocumentMetadata(row, fileId);
  assert.deepEqual(result, { providerId: id, exactFileBinding: true,
    filenameFields: [{ field: "name", valueType: "string", value: metadata.filename }],
    privacyFields: [{ field: "is_private", valueType: "boolean", value: true }],
    sizeFields: [{ field: "size", valueType: "number", value: bytes.length }],
    diagnosticOnly: true, receiptResolved: false });
  assert.equal(JSON.stringify(result).includes("private.example"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  const malformed = pdfDocumentMetadata({ ...record(), name: "https://private.example/signed", is_private: "true", size: "123" }, fileId);
  assert.equal(malformed.filenameFields[0].value, null);
  assert.equal(malformed.privacyFields[0].value, null);
  assert.equal(malformed.privacyFields[0].valueType, "string");
  assert.equal(malformed.sizeFields[0].value, null);
});
