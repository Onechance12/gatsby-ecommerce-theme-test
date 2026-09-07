import { createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const DOCUMENT_RESEARCH_ROUTES = Object.freeze([
  "GET /document-research/session",
  "POST /document-research/inventory",
  "POST /document-research/original"
]);
const DAY = 86400000;
const MIB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  pageSize: 100, maxPages: 100, maxDocuments: 10000,
  maxOriginals: 20, maxBytesPerFile: 25 * MIB, maxTotalBytes: 100 * MIB
});
const HARD_LIMITS = Object.freeze({
  pageSize: 500, maxPages: 1000, maxDocuments: 10000,
  maxOriginals: 100, maxBytesPerFile: 50 * MIB, maxTotalBytes: 500 * MIB
});
const ESX_MIME = "application/vnd.xactware.esx";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
function fail(message, statusCode = 400) {
  const error = new Error(`Document research: ${message}`);
  error.statusCode = statusCode;
  throw error;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactInput(input, keys) {
  if (!object(input) || Object.keys(input).some((key) => !keys.includes(key))) {
    fail("unsupported input fields.");
  }
}
function text(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    fail(`invalid ${label}.`);
  }
  return value;
}
function optionalText(value, label, maximum = 512) {
  return value === undefined || value === null || value === "" ? "" : text(value, label, maximum);
}
function integer(value, label, maximum, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`invalid ${label}.`);
  return value;
}
function normalizeGrant(input) {
  if (!object(input) || input.enabled !== true) return null;
  exactInput(input, ["enabled", "grantId", "companyId", "issuedAt", "expiresAt", "limits", "excludedFileNumbers"]);
  const issuedAt = Date.parse(input.issuedAt), expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 7 * DAY) {
    fail("grant lifetime must be at most seven days.");
  }
  const configuredLimits = input.limits ?? {};
  exactInput(configuredLimits, Object.keys(DEFAULT_LIMITS));
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
    key, integer(configuredLimits[key] ?? fallback, key, HARD_LIMITS[key], 1)
  ]));
  if (limits.pageSize > limits.maxDocuments || limits.maxBytesPerFile > limits.maxTotalBytes) fail("inconsistent grant limits.");
  if (input.excludedFileNumbers !== undefined && !Array.isArray(input.excludedFileNumbers)) fail("invalid exclusions.");
  const excludedFileNumbers = [...new Set(["2628", ...(input.excludedFileNumbers || [])].map((value) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) fail("invalid excluded file number.");
    return value;
  }))].sort();
  return Object.freeze({
    id: text(input.grantId, "grant id"), companyId: text(input.companyId, "company id"),
    issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    limits: Object.freeze(limits), excludedFileNumbers: Object.freeze(excludedFileNumbers)
  });
}
function visibilityBlocked(record) {
  return record.private !== false || record.deleted !== false || record.permissionDenied !== false;
}
function normalizeDocument(row) {
  if (!object(row)) fail("malformed document metadata.");
  if (!Array.isArray(row.fileIds) || row.fileIds.some((id) => typeof id !== "string")) fail("document relationship unavailable.");
  const result = {
    id: text(row.id, "document id"), companyId: text(row.companyId, "document company"),
    name: text(row.name, "document name", 1024), mimeType: text(row.mimeType, "document MIME", 200).split(";", 1)[0].toLowerCase().trim(),
    size: row.size === undefined || row.size === null ? null : integer(row.size, "document size", Number.MAX_SAFE_INTEGER),
    createdAt: optionalText(row.createdAt, "creation date"), updatedAt: optionalText(row.updatedAt, "update date"),
    version: optionalText(row.version, "document version"),
    fileIds: [...new Set(row.fileIds.map((id) => text(id, "parent id")))].sort(),
    private: row.private, deleted: row.deleted, permissionDenied: row.permissionDenied
  };
  return result;
}
function classify(document) {
  const name = document.name.toLowerCase();
  if (/\.esx$/.test(name) && [ESX_MIME, "application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(document.mimeType)) {
    return { classification: "internal_estimate", sourceRole: "internal", sourceRoleEvidence: "owner_confirmed", mimeType: ESX_MIME };
  }
  if (!/\.pdf$/.test(name) || document.mimeType !== "application/pdf") return null;
  if (/policy|declaration|\bdec[ _-]?page|contract|medical|\bw[ -]?9\b|fin[ _-]?535|\btdi\b|representation|bank|tax[ _-]|payroll|invoice|receipt/.test(name)) return null;
  return {
    classification: /estimate|scope|xactimate|final[ _-]?draft/.test(name) ? "estimate_scope_candidate" : "ambiguous_pdf",
    sourceRole: "unverified", sourceRoleEvidence: "unverified", mimeType: "application/pdf"
  };
}

/** One active inventory run with shared process quotas. Provider methods are read-only. */
export function createDocumentResearchService({ grant: inputGrant, provider, now = Date.now } = {}) {
  const grant = normalizeGrant(inputGrant);
  const grantSha256 = grant ? hash(JSON.stringify(grant)) : "";
  let run = null;
  let busy = false;
  let inventoryPageAttempts = 0;
  let inventoryRowsCharged = 0;
  let originalAttempts = 0;
  let downloadedBytes = 0;
  const milliseconds = () => Number(now());
  const live = () => grant && milliseconds() >= Date.parse(grant.issuedAt) && milliseconds() < Date.parse(grant.expiresAt);
  function admitted() {
    if (!live()) fail("grant is disabled, not yet active, or expired.", 403);
    if (!provider || ["listDocuments", "getDocument", "getParent", "downloadDocument"].some((key) => typeof provider[key] !== "function")) {
      fail("read-only provider is unavailable.", 503);
    }
  }
  async function exclusive(action) {
    admitted();
    if (busy) fail("another research operation is in progress.", 409);
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function providerRead(operation, ...args) {
    try { return await provider[operation](...args); }
    catch (cause) {
      const error = new Error("Document research: read-only provider is unavailable.");
      error.statusCode = cause?.statusCode === 429 || cause?.status === 429 ? 429 : 503;
      if (Number.isSafeInteger(cause?.retryAfterSeconds) && cause.retryAfterSeconds >= 0 && cause.retryAfterSeconds <= 86400) {
        error.retryAfterSeconds = cause.retryAfterSeconds;
      }
      error.researchProviderUnavailable = true;
      throw error;
    }
  }
  const binding = () => ({ companyId: grant.companyId, grantId: grant.id, grantSha256, runId: run.id });
  function routeAllowed(method, pathname) {
    return DOCUMENT_RESEARCH_ROUTES.includes(`${method} ${pathname}`);
  }
  function session() {
    return {
      ready: Boolean(live() && provider && ["listDocuments", "getDocument", "getParent", "downloadDocument"].every((key) => typeof provider[key] === "function")),
      readOnly: true, effects: false, profile: "document_research_token",
      identity: { type: "document_research_token", subject: "codex-document-research" },
      companyId: grant?.companyId || "",
      grant: grant ? { id: grant.id, sha256: grantSha256, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt } : null,
      allowedRoutes: [...DOCUMENT_RESEARCH_ROUTES],
      excludedFileNumbers: grant ? [...grant.excludedFileNumbers] : ["2628"],
      limits: grant ? { ...grant.limits } : null,
      retention: { expiresAt: grant?.expiresAt || "" }, companyWideIndexOrSweep: false
    };
  }
  async function parentFor(document) {
    if (document.fileIds.length !== 1) return null;
    const parent = await providerRead("getParent", document.fileIds[0]);
    admitted();
    if (!object(parent) || parent.id !== document.fileIds[0] || parent.companyId !== grant.companyId) fail("parent company or identity mismatch.", 409);
    const number = text(parent.number, "parent file number");
    if (!/^\d+$/.test(number)) fail("invalid parent file number.");
    if (visibilityBlocked(parent) || grant.excludedFileNumbers.includes(number)) return null;
    return { fileId: parent.id, fileNumber: number, carrier: optionalText(parent.carrier, "carrier") };
  }
  async function inventory(input = {}) {
    exactInput(input, ["cursor"]);
    return exclusive(async () => {
      if (input.cursor !== undefined && (!run || run.failed || run.finished || typeof input.cursor !== "string" || !run.cursor || input.cursor !== run.cursor)) {
        fail("invalid, consumed, or expired cursor.", 409);
      }
      if (inventoryPageAttempts >= grant.limits.maxPages) fail("inventory page budget exhausted.", 429);
      if (inventoryRowsCharged >= grant.limits.maxDocuments) fail("inventory document budget exhausted.", 429);
      if (input.cursor === undefined) {
        // A new MCP process can start fresh without restarting this bridge or
        // changing operational approvals. Replacing the run invalidates every
        // prior cursor/document binding, but none of the process-wide quotas.
        run = {
          id: token(), cursor: null, offset: 0, total: null, providerVersion: null, failed: false, finished: false,
          startedAt: new Date(milliseconds()).toISOString(), seen: new Set(), documents: new Map(),
          counts: { providerRows: 0, uniqueDocuments: 0, eligible: 0, excluded: 0, unsupported: 0, ambiguous: 0, unreviewed: 0, duplicates: 0, pages: 0 }
        };
      }
      run.cursor = null;
      const records = [];
      try {
        const limit = Math.min(grant.limits.pageSize, grant.limits.maxDocuments - run.offset, grant.limits.maxDocuments - inventoryRowsCharged);
        // Reserve before dispatch. Failed or malformed pages cannot repeatedly
        // reset acquisition budgets by starting a fresh inventory run.
        inventoryPageAttempts++;
        inventoryRowsCharged += limit;
        const page = await providerRead("listDocuments", { offset: run.offset, limit });
        admitted();
        if (!object(page) || !Array.isArray(page.rows) || page.rows.length > limit) fail("malformed inventory page.");
        // Charge all returned rows, even if classification/parent reads fail.
        // Public counts below still describe only this run's observed evidence.
        inventoryRowsCharged -= limit - page.rows.length;
        run.counts.pages++;
        const hasTotal = page.total !== undefined && page.total !== null;
        if (hasTotal) {
          const total = integer(page.total, "provider total", Number.MAX_SAFE_INTEGER);
          if (total < run.offset + page.rows.length || (run.total !== null && run.total !== total)) fail("inconsistent inventory total.", 409);
          run.total = total;
        } else if (run.total !== null) fail("provider total disappeared.", 409);
        const version = optionalText(page.version, "inventory version");
        if (run.counts.pages === 1) run.providerVersion = version || null;
        else if ((version || null) !== run.providerVersion) fail("inventory version changed.", 409);
        for (const row of page.rows) {
          const document = normalizeDocument(row);
          run.counts.providerRows++;
          if (run.seen.has(document.id)) { run.counts.duplicates++; fail("duplicate document across inventory pages.", 409); }
          run.seen.add(document.id);
          run.counts.uniqueDocuments++;
          if (document.companyId !== grant.companyId) fail("document belongs to another company.", 403);
          if (visibilityBlocked(document)) { run.counts.excluded++; continue; }
          const category = classify(document);
          if (!category) { run.counts.unsupported++; continue; }
          if (document.fileIds.length !== 1) { run.counts.ambiguous++; continue; }
          const parent = await parentFor(document);
          if (!parent) { run.counts.excluded++; continue; }
          const revision = hash(JSON.stringify(document));
          const record = {
            documentId: document.id, ...parent, name: document.name, size: document.size,
            revision, createdAt: document.createdAt, updatedAt: document.updatedAt, ...category
          };
          if (category.classification === "ambiguous_pdf") run.counts.ambiguous++;
          else run.counts.eligible++;
          records.push(record);
          run.documents.set(document.id, { record, metadata: document });
        }
        run.offset += page.rows.length;
        if (!page.rows.length && run.total !== null && run.offset < run.total) fail("inventory ended before declared total.", 409);
        const complete = run.total !== null ? run.offset === run.total : page.rows.length === 0;
        let stopReason = complete ? "complete" : "more_pages";
        if (!complete && (run.offset >= grant.limits.maxDocuments || inventoryRowsCharged >= grant.limits.maxDocuments)) stopReason = "document_limit";
        else if (!complete && (run.counts.pages >= grant.limits.maxPages || inventoryPageAttempts >= grant.limits.maxPages)) stopReason = "page_limit";
        run.finished = stopReason !== "more_pages";
        if (!run.finished) run.cursor = token();
        return {
          ...binding(), documents: records, nextCursor: run.cursor, complete, stopReason,
          counts: { ...run.counts }, declaredTotal: run.total,
          snapshot: { startedAt: run.startedAt, providerVersion: run.providerVersion, consistentSnapshot: false }
        };
      } catch (error) {
        run.failed = true;
        run.cursor = null;
        if (error.researchProviderUnavailable) {
          // A failed parent read leaves an observed candidate unreviewed, never implicitly eligible.
          run.counts.unreviewed = run.counts.uniqueDocuments - run.counts.eligible - run.counts.excluded - run.counts.unsupported - run.counts.ambiguous;
          return {
            ...binding(), documents: records, nextCursor: null, complete: false, stopReason: "provider_unavailable",
            counts: { ...run.counts }, declaredTotal: run.total,
            snapshot: { startedAt: run.startedAt, providerVersion: run.providerVersion, consistentSnapshot: false },
            error: { code: "provider_unavailable", status: error.statusCode,
              ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
          };
        }
        throw error;
      }
    });
  }
  async function original(input) {
    exactInput(input, ["runId", "documentId", "fileId"]);
    return exclusive(async () => {
      if (!run || run.failed || input.runId !== run.id) fail("unknown or invalid inventory run.", 409);
      const selected = run.documents.get(text(input.documentId, "document id"));
      if (!selected || selected.record.fileId !== input.fileId) fail("original is not bound to this inventory file.", 403);
      if (selected.record.classification === "ambiguous_pdf") fail("ambiguous document purpose requires separate review.", 403);
      if (originalAttempts >= grant.limits.maxOriginals || downloadedBytes >= grant.limits.maxTotalBytes) fail("original retrieval budget exhausted.", 429);
      const fresh = normalizeDocument(await providerRead("getDocument", input.documentId));
      admitted();
      if (fresh.id !== input.documentId || fresh.companyId !== grant.companyId || visibilityBlocked(fresh) || hash(JSON.stringify(fresh)) !== selected.record.revision) {
        fail("document changed, became unavailable, or was relinked since inventory.", 409);
      }
      const parent = await parentFor(fresh);
      if (!parent || parent.fileId !== input.fileId || parent.fileNumber !== selected.record.fileNumber) fail("fresh parent binding is unavailable.", 409);
      const maxBytes = Math.min(grant.limits.maxBytesPerFile, grant.limits.maxTotalBytes - downloadedBytes);
      if (fresh.size !== null && fresh.size > maxBytes) fail("document exceeds remaining byte limit.", 413);
      originalAttempts++;
      // Reserve before dispatch: interrupted streams cannot repeatedly evade the grant's volume cap.
      downloadedBytes += maxBytes;
      const downloaded = await providerRead("downloadDocument", fresh.id, { maxBytes });
      admitted();
      if (!object(downloaded) || !Buffer.isBuffer(downloaded.bytes)) fail("provider did not return original bytes.");
      if (downloaded.bytes.length > maxBytes || !downloaded.bytes.length) fail("download exceeded its byte boundary.", 413);
      if ((fresh.size !== null && fresh.size !== downloaded.bytes.length) || (downloaded.contentLength !== undefined && downloaded.contentLength !== downloaded.bytes.length)) fail("download byte length mismatch.", 409);
      validateResearchOriginal(downloaded.bytes, selected.record.mimeType, downloaded.contentType);
      downloadedBytes -= maxBytes - downloaded.bytes.length;
      // A second metadata read detects mutation while the bytes were being acquired.
      const after = normalizeDocument(await providerRead("getDocument", fresh.id));
      admitted();
      if (hash(JSON.stringify(after)) !== selected.record.revision) fail("document changed during download.", 409);
      const afterParent = await parentFor(after);
      if (!afterParent || afterParent.fileId !== parent.fileId || afterParent.fileNumber !== parent.fileNumber) fail("parent changed during download.", 409);
      return {
        ...binding(), documentId: fresh.id, fileId: parent.fileId, fileNumber: parent.fileNumber,
        name: selected.record.name, mimeType: selected.record.mimeType, revision: selected.record.revision,
        classification: selected.record.classification, sourceRole: selected.record.sourceRole,
        sourceRoleEvidence: selected.record.sourceRoleEvidence,
        contentBase64: downloaded.bytes.toString("base64"), sha256: hash(downloaded.bytes), byteLength: downloaded.bytes.length
      };
    });
  }
  return Object.freeze({ session, inventory, original, routeAllowed });
}

export function validateResearchOriginal(bytes, mimeType, providerContentType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > HARD_LIMITS.maxBytesPerFile) fail("invalid original bytes.");
  const actual = String(providerContentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mimeType === "application/pdf") {
    if (actual !== "application/pdf" || !/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii")) || !/%%EOF\s*$/.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1"))) {
      fail("PDF signature or content type mismatch.", 415);
    }
    return;
  }
  if (mimeType !== ESX_MIME || ![ESX_MIME, "application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(actual)) fail("unsupported original content type.", 415);
  validateEsx(bytes);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validateEsx(bytes) {
  const invalid = () => fail("unsupported or unsafe ESX archive.", 415);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) invalid();
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) invalid();
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > 256 || bytes.readUInt16LE(end + 8) !== count || centralOffset + centralSize !== end) invalid();
  let offset = centralOffset, expandedTotal = 0, hasXml = false;
  const names = new Set(), ranges = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16), compressedSize = bytes.readUInt32LE(offset + 20), expandedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const startDisk = bytes.readUInt16LE(offset + 34), attributes = bytes.readUInt32LE(offset + 38), localOffset = bytes.readUInt32LE(offset + 42);
    if ((flags & ~0x0808) || ![0, 8].includes(method) || startDisk || !nameLength || offset + 46 + nameLength + extraLength + commentLength > end) invalid();
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/[\x00-\x1f\x7f\\:\ufffd]/.test(name) || name.startsWith("/") || name.split("/").includes("..") || names.has(name.toLowerCase()) || ((attributes >>> 16) & 0xf000) === 0xa000) invalid();
    names.add(name.toLowerCase());
    expandedTotal += expandedSize;
    if (expandedTotal > 50 * MIB || expandedSize > 25 * MIB || (expandedSize > MIB && expandedSize > Math.max(1, compressedSize) * 100)) invalid();
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method) invalid();
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || dataStart > centralOffset || bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name) invalid();
    if (!(flags & 8) && (bytes.readUInt32LE(localOffset + 14) !== expectedCrc || bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== expandedSize)) invalid();
    if (ranges.some(([start, finish]) => localOffset < finish && dataEnd > start)) invalid();
    ranges.push([localOffset, dataEnd]);
    let unpacked;
    try { unpacked = method === 0 ? bytes.subarray(dataStart, dataEnd) : inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, expandedSize) }); }
    catch { invalid(); }
    if (unpacked.length !== expandedSize || crc32(unpacked) !== expectedCrc) invalid();
    if (/\.(xml|xactdoc)$/i.test(name)) {
      hasXml = true;
      // No XML is executed or resolved. Reject DTD/entity declarations, including UTF-16 spellings.
      if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(unpacked.toString("latin1").replace(/\x00/g, ""))) invalid();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end || !hasXml) invalid();
}
