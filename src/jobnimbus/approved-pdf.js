import { validatePdfPayload, validatePdfMetadata, pdfProviderBody, pdfHash, providerId } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";
import { PdfProviderError } from "./pdf-upload-transport.js";

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

export function pdfRecordChecks(row, id, fileId, metadata) {
  const names = fileNames(row);
  const privacy = [row?.isPrivate, row?.is_private].filter((v) => v !== undefined);
  return {
    document_present: Boolean(row && typeof row === "object" && !Array.isArray(row)),
    document_id: recordId(row) === id,
    exact_file_binding: relatedToOnly(row, fileId),
    filename_present: names.length > 0,
    filename_matches: names.length > 0 && names.every((v) => v === metadata.filename),
    privacy_present: privacy.length > 0,
    privacy_matches: privacy.length > 0 && privacy.every((v) => v === metadata.isPrivate),
    metadata_size_matches: fileSizes(row).every((v) => Number(v) === metadata.sizeBytes),
    not_deleted_or_archived: ![row?.is_deleted, row?.deleted, row?.is_archived, row?.archived]
      .some((v) => [true, 1, "true", "1"].includes(v))
  };
}

export function assertPdfRecord(row, id, fileId, metadata) {
  const failures = Object.entries(pdfRecordChecks(row, id, fileId, metadata))
    .filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length) {
    // Labels only: never echo arbitrary provider bodies, URLs or credentials.
    conflict(`Uploaded document metadata verification failed: ${failures.join(", ")}. Never retry the upload.`);
  }
}

// Exact-document read diagnostics only. These facts do not resolve a receipt,
// relax a guard or grant any action, and never include provider download URLs.
export function pdfDocumentMetadata(row, fileId) {
  const fields = (names, valid) => names.filter((field) => Object.hasOwn(row || {}, field)).map((field) => ({
    field, valueType: row[field] === null ? "null" : typeof row[field],
    value: valid(row[field]) ? row[field] : null
  }));
  return {
    providerId: recordId(row) || null,
    exactFileBinding: relatedToOnly(row, fileId),
    filenameFields: fields(["name", "filename", "file_name"], (v) => typeof v === "string"
      && /^[A-Za-z0-9][A-Za-z0-9 _().-]{0,154}\.pdf$/i.test(v) && !v.includes("..")),
    privacyFields: fields(["isPrivate", "is_private"], (v) => typeof v === "boolean"),
    sizeFields: fields(["size", "sizeBytes", "size_bytes", "file_size"], (v) => Number.isSafeInteger(v) && v >= 0),
    diagnosticOnly: true,
    receiptResolved: false
  };
}

// Provider I/O is injected; no model calls, background work, memory export, or
// legacy upload route. Only the action coordinator invokes the write method.
export function createApprovedPdfService(io) {
  async function inventory(fileId) {
    const rows = await io.listFiles(fileId);
    if (!Array.isArray(rows) || rows.length > 5000) conflict("Exact-file document inventory is incomplete.");
    const ids = new Set();
    for (const row of rows) {
      const id = recordId(row);
      if (!id || ids.has(id) || !relatedToOnly(row, fileId)) conflict("Exact-file document inventory is ambiguous.");
      ids.add(id);
    }
    return { rows, ids };
  }

  async function prepare(input, expectedFileId = "") {
    let parsed;
    try { parsed = validatePdfPayload(input, { scoped: true }); }
    catch (error) { error.statusCode = 400; throw error; }
    const { metadata } = parsed;
    const file = await io.resolveFile(input.query, expectedFileId);
    if (!providerId(file.id) || String(file.number) !== input.query.replace(/^#/, "")) conflict("PDF target is not the exact requested file.");
    const { rows, ids } = await inventory(file.id);
    for (const row of rows) {
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
    // JobNimbus documents metadata via GET /api1/files, not /api1/files/:id.
    // Use a complete, exact-file inventory on both sides of the byte download.
    const before = await inventory(fileId);
    assertPdfRecord(before.rows.find((row) => recordId(row) === id), id, fileId, metadata);
    const bytes = await io.readBytes(id);
    if (bytes.length !== metadata.sizeBytes || pdfHash(bytes) !== metadata.sha256) {
      conflict("Provider download differs from the approved PDF bytes. Never retry; reconcile the receipt.");
    }
    // Re-read after download so moved/renamed documents do not get a receipt.
    const after = await inventory(fileId);
    assertPdfRecord(after.rows.find((row) => recordId(row) === id), id, fileId, metadata);
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

  // A diagnostic is not a disposition plan: it makes no approval challenge,
  // accepts no privacy change and has no reserve/PUT/complete or ledger path.
  async function diagnose(intent, id) {
    const metadata = validatePdfMetadata(intent.reconciliation);
    if (!providerId(id) || intent.reconciliation.beforeIds.includes(id)) conflict("The PDF diagnostic requires one new exact candidate, not an upload retry.");
    const query = `#${intent.fileNumber}`;
    const file = await io.resolveFile(query, intent.fileId);
    const before = await inventory(intent.fileId);
    const row = before.rows.find((item) => recordId(item) === id);
    const privacy = [row?.isPrivate, row?.is_private].filter((value) => value !== undefined);
    const observedIsPrivate = privacy.length && privacy.every((value) => typeof value === "boolean" && value === privacy[0]) ? privacy[0] : null;
    const sizes = fileSizes(row);
    const metadataChecks = { ...pdfRecordChecks(row, id, intent.fileId, metadata),
      unique_candidate: before.rows.filter((item) => fileNames(item).some((name) => typeof name === "string"
        && name.toLowerCase() === metadata.filename.toLowerCase())).length === 1,
      strict_size: sizes.length > 0 && sizes.every((size) => Number.isSafeInteger(size) && size === metadata.sizeBytes),
      privacy_boolean: observedIsPrivate !== null };
    const download = { status: "not_attempted", contentVerified: false, diagnostic: null };
    if (Object.entries(metadataChecks).every(([key, passed]) => key === "privacy_matches" || passed)) {
      try {
        const bytes = await io.readBytes(id);
        download.contentVerified = bytes.length === metadata.sizeBytes && pdfHash(bytes) === metadata.sha256;
        download.status = download.contentVerified ? "verified" : "bytes_mismatch";
      } catch (error) {
        if (!(error instanceof PdfProviderError)) conflict("PDF diagnostic download was unavailable. No approval, receipt or provider state changed.");
        download.status = "blocked";
        download.diagnostic = error.diagnostic;
      }
    }
    const after = await inventory(intent.fileId);
    const afterRow = after.rows.find((item) => recordId(item) === id);
    if (JSON.stringify(pdfRecordChecks(afterRow, id, intent.fileId, metadata)) !== JSON.stringify(pdfRecordChecks(row, id, intent.fileId, metadata))
      || JSON.stringify(pdfDocumentMetadata(afterRow, intent.fileId))
      !== JSON.stringify(pdfDocumentMetadata(row, intent.fileId))
      || after.rows.filter((item) => fileNames(item).some((name) => typeof name === "string"
        && name.toLowerCase() === metadata.filename.toLowerCase())).length !== before.rows.filter((item) => fileNames(item).some((name) => typeof name === "string"
        && name.toLowerCase() === metadata.filename.toLowerCase())).length) conflict("The PDF diagnostic candidate changed during review. The hold remains.");
    const current = await io.resolveFile(query, intent.fileId);
    if (current.id !== file.id || String(current.number) !== String(file.number)) conflict("The PDF diagnostic file binding changed.");
    return { observedIsPrivate, metadataChecks, download };
  }

  // Read-only evidence for a NEW human-approved disposition. This does not
  // reinterpret the old upload approval or reserve/PUT/complete a document.
  async function verifyResolution(intent, id) {
    const metadata = { ...validatePdfMetadata(intent.reconciliation), isPrivate: false };
    if (intent.reconciliation.isPrivate !== true || !providerId(id)
      || intent.reconciliation.beforeIds.includes(id)) conflict("PDF resolution is not an eligible new nonprivate candidate.");
    const check = (snapshot) => {
      const sameName = snapshot.rows.filter((row) => fileNames(row).some((name) =>
        typeof name === "string" && name.toLowerCase() === metadata.filename.toLowerCase()));
      if (sameName.length !== 1 || recordId(sameName[0]) !== id) conflict("The PDF resolution candidate is not unique.");
      assertPdfRecord(sameName[0], id, intent.fileId, metadata);
      const sizes = fileSizes(sameName[0]);
      if (!sizes.length || !sizes.every((size) => Number.isSafeInteger(size) && size === metadata.sizeBytes)) {
        conflict("The PDF resolution candidate lacks strict size metadata.");
      }
    };
    const query = `#${intent.fileNumber}`;
    const file = await io.resolveFile(query, intent.fileId);
    check(await inventory(intent.fileId));
    const bytes = await io.readBytes(id);
    if (bytes.length !== metadata.sizeBytes || pdfHash(bytes) !== metadata.sha256) conflict("PDF resolution bytes differ from the original approved PDF.");
    check(await inventory(intent.fileId));
    const after = await io.resolveFile(query, intent.fileId);
    if (after.id !== file.id || String(after.number) !== String(file.number)) conflict("PDF resolution file binding changed.");
    return file;
  }
  return { prepare, execute, reconcile, verifyResolution, diagnose };
}
