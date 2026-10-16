import assert from "node:assert/strict";
import test from "node:test";
import { createApprovedPdfService } from "./approved-pdf.js";
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
