import { createHash } from "node:crypto";
import { PDF_UPLOAD_TYPE, exactKeys, providerId, validatePdfMetadata, safePdfTransportDiagnostic } from "./pdf-upload-contract.mjs";

export const PDF_RESOLUTION_KIND = "pdf_receipt_resolution";
export const PDF_RESOLUTION_DISPOSITION = "accept_existing_nonprivate_pdf";
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const resolutionHash = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
const fail = () => { throw new Error("The PDF quarantine resolution proof is incomplete, changed or outside the reviewed scope. Keep the hold; never retry the upload."); };

export function validatePdfResolutionInput(input) {
  if (!exactKeys(input, ["batchId", "query", "documentId", "acceptedIsPrivate"])
    || !UUID.test(input.batchId) || typeof input.query !== "string" || !/^#?\d+$/.test(input.query)
    || input.query.replace(/^#/, "") === "2628" || !providerId(input.documentId)
    || input.acceptedIsPrivate !== false) fail();
  return { ...input, query: `#${input.query.replace(/^#/, "")}` };
}

export function validatePdfDiagnosticInput(input) {
  if (!exactKeys(input, ["batchId", "query", "documentId"])) fail();
  const { acceptedIsPrivate, ...request } = validatePdfResolutionInput({ ...input, acceptedIsPrivate: false });
  return request;
}

export const PDF_DIAGNOSTIC_CHECKS = Object.freeze(["document_present", "document_id", "exact_file_binding", "filename_present",
  "filename_matches", "privacy_present", "privacy_matches", "metadata_size_matches", "not_deleted_or_archived",
  "unique_candidate", "strict_size", "privacy_boolean"]);

export function assertPdfDiagnostic(response, input) {
  const request = validatePdfDiagnosticInput(input);
  const keys = ["mode", "batchId", "fileId", "fileNumber", "documentId", "sourceRowSha256", "sourceIntentDigest",
    "identityProvenance", "originalMetadata", "observedIsPrivate", "metadataChecks", "download", "readOnly",
    "providerWrites", "receiptWrites", "approvalRequired", "fileHoldReleased", "originalUploadReplayAllowed"];
  const download = response?.download;
  const checks = response?.metadataChecks;
  if (!exactKeys(response, keys) || response.mode !== "pdf_receipt_diagnostic" || response.batchId !== request.batchId
    || response.documentId !== request.documentId || response.fileNumber !== request.query.slice(1) || !providerId(response.fileId)
    || typeof response.sourceRowSha256 !== "string" || !SHA.test(response.sourceRowSha256)
    || typeof response.sourceIntentDigest !== "string" || !SHA.test(response.sourceIntentDigest)
    || !["preserved_reservation_id", "human_selected_live_candidate_no_durable_reservation_id"].includes(response.identityProvenance)
    || ![true, false, null].includes(response.observedIsPrivate) || response.readOnly !== true
    || ["providerWrites", "receiptWrites", "approvalRequired", "fileHoldReleased", "originalUploadReplayAllowed"].some((key) => response[key] !== false)
    || !exactKeys(checks, PDF_DIAGNOSTIC_CHECKS) || Object.values(checks).some((value) => typeof value !== "boolean")
    || !exactKeys(download, ["status", "contentVerified", "diagnostic"])
    || !["not_attempted", "verified", "blocked", "bytes_mismatch"].includes(download.status)
    || download.contentVerified !== (download.status === "verified")) fail();
  const metadata = validatePdfMetadata(response.originalMetadata);
  if (metadata.isPrivate !== true || typeof metadata.sha256 !== "string" || canonical(metadata) !== canonical(response.originalMetadata)) fail();
  if (download.status === "blocked") {
    if (!download.diagnostic || download.diagnostic.operation !== "read"
      || canonical(download.diagnostic) !== canonical(safePdfTransportDiagnostic(download.diagnostic))) fail();
  } else if (download.diagnostic !== null) fail();
  const metadataReady = Object.entries(checks).every(([key, passed]) => key === "privacy_matches" || passed);
  if ((download.status === "not_attempted") === metadataReady
    || checks.privacy_matches !== (response.observedIsPrivate === metadata.isPrivate)) fail();
}

// The original receipt is never rewritten, completed, resumed or replayed.
// A separate append-only resolution is hashed against this unchanged snapshot.
export function pdfResolutionSource(row) {
  const { pdfReceiptResolution, ...original } = row || {};
  const rawFile = original.files?.[0];
  const file = rawFile ? { ...rawFile, number: String(rawFile.number) } : null;
  const intent = original.intents?.[0];
  const quarantine = original.manualQuarantine;
  if (original.schemaVersion !== 2 || !UUID.test(original.id || "") || !UUID.test(original.bootId || "")
    || !UUID.test(original.approvalId || "") || original.failedAt !== 0 || !SHA.test(original.principalHash || "")
    || !SHA.test(original.approvalDigest || "") || original.operatorScope !== "assigned"
    || original.runPolicyId !== "chance-live-assigned-sms-v1" || !SHA.test(original.runPolicySha256 || "")
    || original.status !== "manual_quarantined" || original.current
    || original.operationCount !== 1 || original.fileCount !== 1
    || original.batchMode !== "assigned_single_file_v2" || original.files?.length !== 1
    || !providerId(file?.id) || !/^\d+$/.test(file?.number || "") || file.number === "2628"
    || canonical(file.operationIndexes) !== "[0]" || canonical(file.operationTypes) !== canonical([PDF_UPLOAD_TYPE])
    || original.intents?.length !== 1 || original.completed?.length !== 0 || original.notAttempted?.length !== 0
    || intent?.index !== 0 || intent.type !== PDF_UPLOAD_TYPE || intent.fileId !== file.id || intent.fileNumber !== file.number
    || original.recovery?.fileScopedQuarantine !== true || original.recovery?.resolvedOutcome !== "unknown_file_quarantined"
    || quarantine?.index !== 0 || quarantine.type !== PDF_UPLOAD_TYPE || quarantine.scope !== "file"
    || quarantine.reasonCode !== "provider_state_unprovable" || quarantine.fileId !== file.id || quarantine.fileNumber !== file.number
    || canonical(quarantine.fileIds) !== canonical([file.id]) || canonical(quarantine.fileNumbers) !== canonical([file.number])
    || !Number.isFinite(Date.parse(quarantine.quarantinedAt || ""))) fail();
  const metadata = validatePdfMetadata(intent.reconciliation);
  const ids = intent.reconciliation.beforeIds;
  if (metadata.isPrivate !== true || !Array.isArray(ids) || ids.length > 5000
    || !ids.every(providerId) || new Set(ids).size !== ids.length
    || (quarantine.providerDocumentId !== undefined && !providerId(quarantine.providerDocumentId))) fail();
  const { intentDigest, ...stable } = intent;
  if (resolutionHash({ version: 1, stable }) !== intentDigest) fail();
  return { original, file, intent, metadata, sourceRowSha256: resolutionHash(original) };
}

export function pdfResolutionProof(row, input) {
  const request = validatePdfResolutionInput(input);
  const source = pdfResolutionSource(row);
  const preservedId = source.original.manualQuarantine.providerDocumentId;
  if (row.pdfReceiptResolution || request.batchId !== row.id
    || request.query !== `#${source.file.number}` || source.intent.reconciliation.beforeIds.includes(request.documentId)
    || (preservedId && preservedId !== request.documentId)) fail();
  return {
    version: 1, disposition: PDF_RESOLUTION_DISPOSITION,
    batchId: row.id, sourceRowSha256: source.sourceRowSha256, sourceIntentDigest: source.intent.intentDigest,
    fileId: source.file.id, fileNumber: source.file.number, providerDocumentId: request.documentId,
    identityProvenance: preservedId ? "preserved_reservation_id" : "human_selected_live_candidate_no_durable_reservation_id",
    originalMetadata: source.metadata, acceptedMetadata: { ...source.metadata, isPrivate: false },
    exactFileBinding: true, uniqueCandidate: true, contentVerified: true, verifiedByReadback: true,
    providerWrites: false, accessChanged: false, originalReceiptPreserved: true, originalUploadReplayAllowed: false
  };
}

export function pdfResolutionDigest(proof, boundary) {
  return resolutionHash({ kind: PDF_RESOLUTION_KIND, version: 1, proof, boundary });
}

export function validPdfReceiptResolution(row) {
  try {
    const saved = row?.pdfReceiptResolution;
    if (!exactKeys(saved, ["id", "kind", "proof", "boundary", "approvalDigest", "approvalId", "resolvedAt", "resolutionSha256"])
      || !UUID.test(saved.id) || saved.kind !== PDF_RESOLUTION_KIND || !UUID.test(saved.approvalId)
      || !Number.isFinite(Date.parse(saved.resolvedAt))) return false;
    const { pdfReceiptResolution, ...original } = row;
    const expected = pdfResolutionProof(original, { batchId: row.id, query: `#${saved.proof.fileNumber}`,
      documentId: saved.proof.providerDocumentId, acceptedIsPrivate: false });
    const boundary = saved.boundary;
    if (!exactKeys(boundary, ["bridgeBootId", "runPolicyId", "runPolicySha256", "principalHash"])
      || !UUID.test(boundary.bridgeBootId) || boundary.runPolicyId !== row.runPolicyId
      || boundary.runPolicySha256 !== row.runPolicySha256 || boundary.principalHash !== row.principalHash
      || !SHA.test(boundary.runPolicySha256) || canonical(saved.proof) !== canonical(expected)
      || saved.approvalDigest !== pdfResolutionDigest(expected, boundary)) return false;
    const { resolutionSha256, ...material } = saved;
    return resolutionSha256 === resolutionHash(material);
  } catch { return false; }
}

export function assertPdfResolutionPlan(response, input, boundary) {
  const request = validatePdfResolutionInput(input);
  const proof = response?.proof;
  let metadata;
  try { metadata = validatePdfMetadata(proof?.originalMetadata); } catch { fail(); }
  const expectedAccepted = { ...metadata, isPrivate: false };
  const proofKeys = ["version", "disposition", "batchId", "sourceRowSha256", "sourceIntentDigest", "fileId", "fileNumber",
    "providerDocumentId", "identityProvenance", "originalMetadata", "acceptedMetadata", "exactFileBinding", "uniqueCandidate",
    "contentVerified", "verifiedByReadback", "providerWrites", "accessChanged", "originalReceiptPreserved", "originalUploadReplayAllowed"];
  if (response?.mode !== "pdf_resolution_plan" || response.displayComplete !== true || !exactKeys(proof, proofKeys)
    || proof.version !== 1 || proof.disposition !== PDF_RESOLUTION_DISPOSITION || proof.batchId !== request.batchId
    || proof.fileNumber !== request.query.slice(1) || !providerId(proof.fileId) || proof.providerDocumentId !== request.documentId
    || !SHA.test(proof.sourceRowSha256) || !SHA.test(proof.sourceIntentDigest) || metadata.isPrivate !== true
    || !exactKeys(proof.originalMetadata, Object.keys(metadata)) || !exactKeys(proof.acceptedMetadata, Object.keys(metadata))
    || canonical(proof.acceptedMetadata) !== canonical(expectedAccepted)
    || !["preserved_reservation_id", "human_selected_live_candidate_no_durable_reservation_id"].includes(proof.identityProvenance)
    || ["exactFileBinding", "uniqueCandidate", "contentVerified", "verifiedByReadback", "originalReceiptPreserved"].some((k) => proof[k] !== true)
    || ["providerWrites", "accessChanged", "originalUploadReplayAllowed"].some((k) => proof[k] !== false)
    || canonical(response.boundary) !== canonical(boundary)
    || response.approvalDigest !== pdfResolutionDigest(proof, boundary)
    || response.file?.id !== proof.fileId || String(response.file?.number) !== proof.fileNumber) fail();
}

export function assertPdfResolutionReceipt(response, plan) {
  const saved = response?.resolution;
  if (response?.mode !== "pdf_resolution_verified" || response.fileHoldReleased !== true || response.providerWrites !== false
    || response.originalUploadReplayAllowed !== false || response.originalReceiptStatus !== "manual_quarantined"
    || !exactKeys(saved, ["id", "kind", "proof", "boundary", "approvalDigest", "approvalId", "resolvedAt", "resolutionSha256"])
    || saved.kind !== PDF_RESOLUTION_KIND || !UUID.test(saved.id || "") || !UUID.test(saved.approvalId || "")
    || canonical(saved.proof) !== canonical(plan.proof) || canonical(saved.boundary) !== canonical(plan.boundary)
    || saved.approvalDigest !== plan.approvalDigest || !Number.isFinite(Date.parse(saved.resolvedAt || ""))) fail();
  const { resolutionSha256, ...material } = saved;
  if (resolutionSha256 !== resolutionHash(material)) fail();
}
