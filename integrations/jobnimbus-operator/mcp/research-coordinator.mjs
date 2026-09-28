import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const RESEARCH_ROUTES = Object.freeze([
  "GET /document-research/session",
  "POST /document-research/inventory",
  "POST /document-research/original"
]);
export const RESEARCH_KEYCHAIN_SERVICE = "com.wavepa.jobnimbus-document-research";
export const RESEARCH_KEYCHAIN_ACCOUNT = "codex-document-research";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LIMIT_KEYS = ["pageSize", "maxPages", "maxDocuments", "maxOriginals", "maxBytesPerFile", "maxTotalBytes"];
const COUNT_KEYS = ["providerRows", "uniqueDocuments", "eligible", "excluded", "unsupported", "ambiguous", "unreviewed", "duplicates", "pages"];
const WEEK = 7 * 24 * 60 * 60 * 1000;
const HARD_MAX_FILE_BYTES = 50 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function fail(message) {
  throw new Error(`Document research refused: ${message}`);
}

function object(value, keys, label, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an exact object.`);
  if (Object.keys(value).some(key => !keys.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail(`${label} has unsupported or missing fields.`);
  return value;
}

function exact(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail(`${label} does not match the local pin.`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])])
  );
  return value;
}

function same(value, expected, label) {
  exact(stable(value), stable(expected), label);
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be an exact saved identifier.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || !/^\d{4}-\d{2}-\d{2}T/.test(value)) fail(`${label} is invalid.`);
  return Date.parse(value);
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is outside its bound.`);
  return value;
}

export function validateResearchPin(value, now = Date.now()) {
  object(value, ["companyId", "grant", "build", "excludedFileNumbers", "limits", "retention"], "local pin");
  id(value.companyId, "companyId");
  object(value.grant, ["id", "sha256", "issuedAt", "expiresAt"], "grant");
  id(value.grant.id, "grant ID");
  if (!HASH.test(value.grant.sha256)) fail("grant hash is invalid.");
  const issued = timestamp(value.grant.issuedAt, "grant issuance");
  const expires = timestamp(value.grant.expiresAt, "grant expiry");
  if (issued > now || expires <= now || expires <= issued || expires - issued > WEEK) fail("grant is expired, future-dated, or longer than seven days.");
  object(value.build, ["service", "sourceCommit", "sourceCommitTrust", "attested", "apiVersion", "schemaVersion"], "build", ["service", "sourceCommit", "sourceCommitTrust", "attested"]);
  if (value.build.service !== "jobnimbus-chatgpt-bridge"
      || !/^[a-f0-9]{40}$/.test(value.build.sourceCommit)
      || value.build.sourceCommitTrust !== "provider_attested" || value.build.attested !== true) fail("build must pin one provider-attested bridge commit.");
  if (!Array.isArray(value.excludedFileNumbers) || !value.excludedFileNumbers.includes("2628")
      || value.excludedFileNumbers.some(number => typeof number !== "string" || !/^[1-9]\d*$/.test(number))
      || new Set(value.excludedFileNumbers).size !== value.excludedFileNumbers.length) fail("file exclusions must include 2628 and be exact and unique.");
  object(value.limits, LIMIT_KEYS, "limits");
  for (const key of LIMIT_KEYS) integer(value.limits[key], key, 1);
  if (value.limits.pageSize > 500 || value.limits.maxPages > 1000 || value.limits.maxDocuments > 10000
      || value.limits.maxOriginals > 100 || value.limits.maxBytesPerFile > HARD_MAX_FILE_BYTES
      || value.limits.maxTotalBytes > HARD_MAX_TOTAL_BYTES
      || value.limits.maxBytesPerFile > value.limits.maxTotalBytes) fail("grant exceeds local research volume ceilings.");
  object(value.retention, ["expiresAt"], "cache retention");
  const retention = timestamp(value.retention.expiresAt, "cache retention expiry");
  if (retention <= now || value.retention.expiresAt !== value.grant.expiresAt) fail("cache retention must exactly match grant expiry.");
  return structuredClone(value);
}

// No pin is created by the plugin. The owner must deliberately install a private
// reviewed pin at activation; absent pins do not register research tools.
export async function loadResearchPin(filename, now = Date.now()) {
  if (!filename) return null;
  if (typeof filename !== "string" || !path.isAbsolute(filename)) fail("pin path must be absolute.");
  const resolved = await realpath(filename);
  if (resolved !== filename) fail("pin path cannot contain a symlink.");
  const [file, parent] = await Promise.all([lstat(filename), lstat(path.dirname(filename))]);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 16384 || (file.mode & 0o777) !== 0o600
      || !parent.isDirectory() || (parent.mode & 0o777) !== 0o700
      || (process.getuid && (file.uid !== process.getuid() || parent.uid !== process.getuid()))) fail("pin must be an owned 0600 file in an owned 0700 directory.");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.ino !== file.ino || actual.dev !== file.dev || actual.size !== file.size
        || (actual.mode & 0o777) !== 0o600) fail("pin changed while opening.");
    return validateResearchPin(JSON.parse(await handle.readFile("utf8")), now);
  } finally {
    await handle.close();
  }
}

function assertSession(session, pin, now) {
  validateResearchPin(pin, now);
  object(session, ["ready", "readOnly", "effects", "profile", "identity", "companyId", "grant", "build", "allowedRoutes", "excludedFileNumbers", "limits", "retention", "companyWideIndexOrSweep"], "research session");
  if (session.ready !== true || session.readOnly !== true || session.effects !== false
      || session.profile !== "document_research_token" || session.companyWideIndexOrSweep !== false) fail("research identity is not ready and strictly read-only.");
  same(session.identity, { type: "document_research_token", subject: RESEARCH_KEYCHAIN_ACCOUNT }, "identity");
  for (const key of ["companyId", "grant", "limits", "retention"]) same(session[key], pin[key], key);
  object(session.build, ["service", "sourceCommit", "sourceCommitTrust", "attested", "apiVersion", "schemaVersion", "buildId", "deployId", "runtime"], "attested build", ["service", "sourceCommit", "sourceCommitTrust", "attested"]);
  for (const [key, value] of Object.entries(pin.build)) same(session.build[key], value, `build ${key}`);
  if (!Array.isArray(session.excludedFileNumbers)) fail("exclusions are missing.");
  same([...session.excludedFileNumbers].sort(), [...pin.excludedFileNumbers].sort(), "exclusions");
  if (!Array.isArray(session.allowedRoutes) || session.allowedRoutes.length !== RESEARCH_ROUTES.length) fail("route allowlist is invalid.");
  same([...session.allowedRoutes].sort(), [...RESEARCH_ROUTES].sort(), "read-only routes");
}

function assertBinding(value, pin, runId) {
  exact(value.companyId, pin.companyId, "company");
  exact(value.grantId, pin.grant.id, "grant ID");
  exact(value.grantSha256, pin.grant.sha256, "grant hash");
  id(value.runId, "run ID");
  if (runId !== undefined) exact(value.runId, runId, "run ID");
}

function safeMetadataString(value, label, max = 400) {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)
      || /(?:https?:\/\/|file:\/\/)/i.test(value)) fail(`${label} is invalid or contains a source URL.`);
}

function validateDocument(document, pin) {
  object(document, ["documentId", "fileId", "fileNumber", "carrier", "name", "mimeType", "size", "revision", "createdAt", "updatedAt", "classification", "sourceRole", "sourceRoleEvidence"], "inventory document");
  id(document.documentId, "document ID");
  id(document.fileId, "file ID");
  if (typeof document.fileNumber !== "string" || !/^[1-9]\d*$/.test(document.fileNumber)
      || pin.excludedFileNumbers.includes(document.fileNumber)) fail("document belongs to an excluded or invalid file.");
  for (const key of ["name", "mimeType", "revision", "classification", "sourceRole", "sourceRoleEvidence"]) safeMetadataString(document[key], key);
  if (document.carrier !== null && document.carrier !== "") safeMetadataString(document.carrier, "carrier");
  // Provider metadata can contain an ISO timestamp, an epoch string, or no date.
  // Preserve it as source metadata; it does not establish grant timing.
  for (const key of ["createdAt", "updatedAt"]) if (document[key] !== null && document[key] !== "") safeMetadataString(document[key], key, 128);
  if (document.size !== null) integer(document.size, "document size");
  if (!HASH.test(document.revision)) fail("document revision fingerprint is invalid.");
  const esx = path.extname(document.name).toLowerCase() === ".esx";
  if (esx) {
    if (document.mimeType !== "application/vnd.xactware.esx" || document.classification !== "internal_estimate"
        || document.sourceRole !== "internal" || document.sourceRoleEvidence !== "owner_confirmed") fail("ESX metadata must preserve owner-confirmed internal provenance.");
  } else if (path.extname(document.name).toLowerCase() !== ".pdf" || document.mimeType !== "application/pdf"
      || !["estimate_scope_candidate", "ambiguous_pdf"].includes(document.classification)
      || document.sourceRole !== "unverified" || document.sourceRoleEvidence !== "unverified") fail("PDF candidate metadata is invalid.");
  return structuredClone(document);
}

function originalBytes(value, document, pin) {
  for (const key of ["documentId", "fileId", "fileNumber", "name", "mimeType", "revision", "classification", "sourceRole", "sourceRoleEvidence"]) exact(value[key], document[key], `original ${key}`);
  integer(value.byteLength, "original byte length", 1, pin.limits.maxBytesPerFile);
  if (document.size !== null) exact(value.byteLength, document.size, "inventory byte length");
  if (typeof value.contentBase64 !== "string" || value.contentBase64.length !== 4 * Math.ceil(value.byteLength / 3)
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64)) fail("original base64 is invalid.");
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (bytes.length !== value.byteLength || bytes.toString("base64") !== value.contentBase64
      || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
      || createHash("sha256").update(bytes).digest("hex") !== value.sha256) fail("original byte length or SHA-256 does not match.");
  const extension = path.extname(document.name).toLowerCase();
  if (extension === ".pdf") {
    if (document.mimeType !== "application/pdf" || !/^(?:%PDF-1\.[0-9]|%PDF-2\.0)/.test(bytes.subarray(0, 8).toString("ascii"))
        || !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))) fail("original is not a supported PDF.");
  } else if (extension === ".esx") {
    if (document.mimeType !== "application/vnd.xactware.esx"
        || bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50
        || document.sourceRole !== "internal" || document.sourceRoleEvidence !== "owner_confirmed") fail("ESX container or owner-confirmed internal provenance is invalid.");
    // The bridge validates archive entries/expansion/XML before returning bytes.
    // The Mac stores the verified archive opaquely: never unpacks or executes it.
  } else fail("original is not a PDF or ESX.");
  return { bytes, extension };
}

async function privateDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || (process.getuid && info.uid !== process.getuid())) fail("cache directory is not owned, private, and symlink-free.");
}

async function cacheParent(directory) {
  const missing = [];
  let existing = directory;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(existing);
      existing = path.dirname(existing);
    }
  }
  if (await realpath(existing) !== existing) fail("cache parent contains a symlink.");
  for (const child of missing.reverse()) await privateDirectory(child);
  await privateDirectory(directory);
}

async function materialize(cacheRoot, pin, response, bytes, extension) {
  if (!path.isAbsolute(cacheRoot)) fail("cache root must be an absolute private path.");
  await cacheParent(path.dirname(cacheRoot));
  await privateDirectory(cacheRoot);
  let directory = cacheRoot;
  for (const value of [pin.companyId, response.runId, response.fileId, response.documentId, response.revision, response.sha256]) {
    directory = path.join(directory, id(value, "cache binding"));
    await privateDirectory(directory);
  }
  const localPath = path.join(directory, `original${extension}`);
  const handle = await open(localPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  const readback = await readFile(localPath);
  if (readback.length !== bytes.length || createHash("sha256").update(readback).digest("hex") !== response.sha256) fail("cached original failed readback verification.");
  const { contentBase64: omitted, ...provenance } = response;
  const manifest = { ...provenance, retention: pin.retention, readOnly: true, localPath };
  const manifestHandle = await open(path.join(directory, "manifest.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await manifestHandle.writeFile(JSON.stringify(manifest, null, 2)); await manifestHandle.sync(); }
  finally { await manifestHandle.close(); }
  // Retention is explicit and grant-bound. Expired caches are never read through
  // research tools. Cleanup is manual, separately approved, and never automatic.
  return manifest;
}

export function createResearchCoordinator({ researchRequest, grant, cacheRoot, now = Date.now }) {
  if (typeof researchRequest !== "function" || typeof cacheRoot !== "string") fail("research dependencies are missing.");
  const pin = validateResearchPin(grant, now());
  let active = null;
  let busy = false;
  let originals = 0;
  let totalBytes = 0;
  const attemptedOriginals = new Set();

  async function verifiedSession() {
    validateResearchPin(pin, now());
    try {
      const session = await researchRequest("GET", "/document-research/session");
      assertSession(session, pin, now());
      return structuredClone(session);
    } catch (error) { active = null; throw error; }
  }

  async function exclusive(work) {
    if (busy) fail("one research request is already running.");
    busy = true;
    try { return await work(); } finally { busy = false; }
  }

  return Object.freeze({
    verifySession: () => exclusive(verifiedSession),
    inventory: (input = {}) => exclusive(async () => {
      object(input, ["cursor"], "inventory input", []);
      if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor
          || input.cursor.length > 4096 || !active || active.nextCursor !== input.cursor)) fail("cursor was not issued to the current local research run.");
      if (input.cursor === undefined) active = null;
      await verifiedSession();
      const response = await researchRequest("POST", "/document-research/inventory", input);
      validateResearchPin(pin, now());
      const fields = ["companyId", "grantId", "grantSha256", "runId", "documents", "nextCursor", "complete", "stopReason", "counts", "declaredTotal", "snapshot"];
      object(response, [...fields, "error"], "inventory response", fields);
      assertBinding(response, pin, active?.runId);
      if (!Array.isArray(response.documents) || response.documents.length > pin.limits.pageSize) fail("inventory page exceeds its bound.");
      if (typeof response.complete !== "boolean" || (response.nextCursor !== null && (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 4096))) fail("inventory continuation is invalid.");
      safeMetadataString(response.stopReason, "inventory stop reason");
      if (response.complete && response.nextCursor !== null) fail("complete inventory has a continuation cursor.");
      if (response.complete ? response.stopReason !== "complete"
        : response.nextCursor !== null ? response.stopReason !== "more_pages"
          : !["document_limit", "page_limit", "provider_unavailable"].includes(response.stopReason)) fail("inventory completeness contradicts its stop reason.");
      if (response.stopReason === "provider_unavailable") {
        object(response.error, ["code", "status", "retryAfterSeconds"], "inventory provider error", ["code", "status"]);
        if (response.error.code !== "provider_unavailable" || ![429, 503].includes(response.error.status)) fail("inventory provider error is invalid.");
        if (response.error.retryAfterSeconds !== undefined) integer(response.error.retryAfterSeconds, "provider retry delay", 0, 86400);
      }
      else if (Object.hasOwn(response, "error")) fail("successful inventory includes an unexpected provider error.");
      object(response.counts, COUNT_KEYS, "inventory counts");
      for (const key of COUNT_KEYS) integer(response.counts[key], `count ${key}`);
      const counts = response.counts;
      if (counts.providerRows !== counts.uniqueDocuments + counts.duplicates
          || counts.uniqueDocuments !== counts.eligible + counts.excluded + counts.unsupported + counts.ambiguous + counts.unreviewed) fail("inventory counts do not reconcile.");
      if (response.declaredTotal !== null) {
        integer(response.declaredTotal, "declared provider total");
        if (response.declaredTotal < counts.providerRows || (response.complete && response.declaredTotal !== counts.providerRows)) fail("declared provider total contradicts inventory completeness.");
      }
      object(response.snapshot, ["startedAt", "providerVersion", "consistentSnapshot"], "inventory snapshot");
      timestamp(response.snapshot.startedAt, "inventory start");
      if (response.snapshot.consistentSnapshot !== false) fail("inventory cannot claim a consistent provider snapshot.");
      if (response.snapshot.providerVersion !== null) safeMetadataString(response.snapshot.providerVersion, "provider version");
      const documents = new Map(active?.documents ?? []);
      const seenCursors = new Set(active?.seenCursors ?? []);
      if (response.nextCursor !== null) {
        if (seenCursors.has(response.nextCursor) || response.nextCursor === input.cursor) fail("inventory repeated a cursor.");
        seenCursors.add(response.nextCursor);
      }
      for (const entry of response.documents) {
        const document = validateDocument(entry, pin);
        if (documents.has(document.documentId)) fail("inventory repeated a document ID.");
        documents.set(document.documentId, document);
      }
      const priorPages = active?.counts.pages ?? 0;
      if (documents.size > pin.limits.maxDocuments || response.counts.pages > pin.limits.maxPages
          || (response.stopReason === "provider_unavailable"
            ? response.counts.pages < priorPages || response.counts.pages > priorPages + 1
            : response.counts.pages !== priorPages + 1)) fail("inventory count or page bound is invalid.");
      if (documents.size > counts.eligible + counts.ambiguous
          || [...documents.values()].filter(document => document.classification !== "ambiguous_pdf").length !== counts.eligible) fail("inventory omitted eligible records or miscounted candidates.");
      if (active) {
        for (const key of COUNT_KEYS) if (response.counts[key] < active.counts[key]) fail("inventory cumulative counts decreased.");
        same(response.snapshot, active.snapshot, "inventory snapshot");
        if (active.declaredTotal !== null) same(response.declaredTotal, active.declaredTotal, "declared provider total");
      }
      active = { runId: response.runId, nextCursor: response.nextCursor, counts: response.counts, declaredTotal: response.declaredTotal, snapshot: response.snapshot, documents, seenCursors, failed: response.stopReason === "provider_unavailable" };
      return structuredClone(response);
    }),
    original: input => exclusive(async () => {
      object(input, ["runId", "documentId", "fileId"], "original input");
      for (const key of ["runId", "documentId", "fileId"]) id(input[key], key);
      const document = active?.documents.get(input.documentId);
      if (!document || active.failed || input.runId !== active.runId || input.fileId !== document.fileId) fail("original must match a document in the current local inventory, with no provider failure.");
      if (document.classification === "ambiguous_pdf") fail("ambiguous PDFs are inventory-only and require source classification review.");
      if (originals >= pin.limits.maxOriginals) fail("original retrieval limit reached.");
      const attemptKey = `${input.runId}/${input.documentId}`;
      if (attemptedOriginals.has(attemptKey)) fail("original already requested; inspect the existing cache or reconcile the prior result.");
      if (document.size !== null && (document.size === 0 || document.size > pin.limits.maxBytesPerFile)) fail("original size exceeds its download bound.");
      const reservedBytes = document.size ?? pin.limits.maxBytesPerFile;
      if (totalBytes + reservedBytes > pin.limits.maxTotalBytes) fail("total original byte limit reached.");
      await verifiedSession();
      originals += 1;
      totalBytes += reservedBytes;
      attemptedOriginals.add(attemptKey);
      const response = await researchRequest("POST", "/document-research/original", input);
      validateResearchPin(pin, now());
      object(response, ["companyId", "grantId", "grantSha256", "runId", "documentId", "fileId", "fileNumber", "name", "mimeType", "revision", "classification", "sourceRole", "sourceRoleEvidence", "contentBase64", "sha256", "byteLength"], "original response");
      assertBinding(response, pin, active.runId);
      const { bytes, extension } = originalBytes(response, document, pin);
      // Keep the full reserved volume after a failed request. Only a validated
      // response releases unused capacity; failed attempts are never retried.
      totalBytes -= reservedBytes - bytes.length;
      return materialize(cacheRoot, pin, response, bytes, extension);
    })
  });
}
