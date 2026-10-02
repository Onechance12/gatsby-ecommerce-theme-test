import { validatePdfPayload, validatePdfMetadata, pdfProviderBody, pdfHash, providerId } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

const conflict = (message) => { const error = new Error(message); error.statusCode = 409; throw error; };
const recordId = (row) => {
  const values = [row?.jnid, row?.id].filter((value) => value !== undefined);
  return values.length && values.every(providerId) && new Set(values).size === 1 ? values[0] : "";
};
function relatedToOnly(row, fileId) {
  const ids = [...(Array.isArray(row?.related) ? row.related.map((r) => typeof r === "string" ? r : r?.id || r?.jnid) : []),
    ...(row?.primary ? [row.primary.id || row.primary.jnid] : [])];
  return ids.length > 0 && ids.every((id) => id === fileId);
}
const fileNames = (row) => [row?.name, row?.filename, row?.file_name].filter((v) => v !== undefined);
const fileSizes = (row) => [row?.size, row?.sizeBytes, row?.size_bytes, row?.file_size].filter((v) => v !== undefined);

export function assertPdfRecord(row, id, fileId, metadata) {
  const names = fileNames(row);
  const privacy = [row?.isPrivate, row?.is_private].filter((v) => v !== undefined);
  if (recordId(row) !== id || !relatedToOnly(row, fileId) || !names.length || names.some((v) => v !== metadata.filename)
    || !privacy.length || privacy.some((v) => v !== metadata.isPrivate)
    || fileSizes(row).some((v) => Number(v) !== metadata.sizeBytes)
    || [row?.is_deleted, row?.deleted, row?.is_archived, row?.archived].some((v) => [true, 1, "true", "1"].includes(v))) {
    conflict("Uploaded document metadata does not prove the approved document, client and privacy. Never retry; reconcile the receipt.");
  }
}

// Provider I/O is injected; no model calls, background work, memory export, or
// legacy upload route. Only the action coordinator invokes the write method.
export function createApprovedPdfService(io) {
  async function prepare(input, expectedFileId = "") {
    let parsed;
    try { parsed = validatePdfPayload(input, { scoped: true }); }
    catch (error) { error.statusCode = 400; throw error; }
    const { metadata } = parsed;
    const file = await io.resolveFile(input.query, expectedFileId);
    if (!providerId(file.id) || String(file.number) !== input.query.replace(/^#/, "")) conflict("PDF target is not the exact requested file.");
    const rows = await io.listFiles(file.id);
    if (!Array.isArray(rows) || rows.length > 5000) conflict("Exact-file document inventory is incomplete.");
    const ids = new Set();
    for (const row of rows) {
      const id = recordId(row);
      if (!id || ids.has(id) || !relatedToOnly(row, file.id)) conflict("Exact-file document inventory is ambiguous.");
      ids.add(id);
      if (fileNames(row).some((name) => String(name).toLowerCase() === metadata.filename.toLowerCase())) {
        conflict("A document with this filename already exists. Review it; upload never overwrites or creates a same-name duplicate.");
      }
    }
    // Catch previously verified uploads even under a different new filename.
    if (await io.wasUploaded(file.id, metadata.sha256)) conflict("These exact PDF bytes were already uploaded to this file. Use the existing document ID.");
    const possibleDuplicates = rows.filter((row) => fileSizes(row).some((v) => Number(v) === metadata.sizeBytes));
    if (possibleDuplicates.length > 20) conflict("Duplicate comparison exceeds its reviewed bound; inspect the existing documents first.");
    for (const row of possibleDuplicates) {
      if (pdfHash(await io.readBytes(recordId(row))) === metadata.sha256) conflict("These PDF bytes already exist on this file under another filename.");
    }
    return { mode: "dry_run", file, plan: { endpoint: "/files/v1/uploads/url", ...metadata,
      beforeIds: [...ids].sort(), body: pdfProviderBody(file.id, metadata) } };
  }

  async function verify(id, fileId, metadata) {
    assertPdfRecord(await io.readDocument(id), id, fileId, metadata);
    const bytes = await io.readBytes(id);
    if (bytes.length !== metadata.sizeBytes || pdfHash(bytes) !== metadata.sha256) {
      conflict("Provider download differs from the approved PDF bytes. Never retry; reconcile the receipt.");
    }
    // Re-read after download so moved/renamed documents do not get a receipt.
    assertPdfRecord(await io.readDocument(id), id, fileId, metadata);
  }

  async function execute(input, prepared, recordProviderDocumentId) {
    const fresh = await prepare(input, prepared.file.id);
    if (JSON.stringify(fresh.plan) !== JSON.stringify(prepared.plan)) conflict("PDF or document inventory changed after approval. Nothing was uploaded.");
    if (typeof recordProviderDocumentId !== "function") conflict("Durable document receipt writer is unavailable. Nothing was uploaded.");
    const { bytes, metadata } = validatePdfPayload(input, { scoped: true });
    const reservation = await io.reserve(fresh.plan.body);
    const id = reservation?.id;
    if (!providerId(id) || fresh.plan.beforeIds.includes(id)) conflict("Provider returned no new document ID. Outcome uncertain; never retry the upload.");
    // Durable create-response identity BEFORE transmitting bytes. A failure to
    // save it stops here. Recovery never creates/completes/uploads anything.
    await recordProviderDocumentId(id);
    await io.put(reservation.url, bytes);
    await io.complete(id);
    await verify(id, fresh.file.id, metadata);
    return { mode: "executed", file: fresh.file, result: { id }, ...metadata,
      contentVerified: true, verifiedByReadback: true };
  }

  async function reconcile(intent, id) {
    const metadata = validatePdfMetadata(intent.reconciliation);
    if (!providerId(id) || !providerId(intent.fileId) || !Array.isArray(intent.reconciliation.beforeIds)
      || intent.reconciliation.beforeIds.includes(id)) conflict("No durable new provider document ID exists. Manual reconciliation required; never upload again.");
    await verify(id, intent.fileId, metadata);
    return { applied: true, externalId: id };
  }
  return { prepare, execute, reconcile };
}
