import { fetchBoundedJson } from "../http/bounded-json.js";

const API_BASE = "https://app.jobnimbus.com/api1";
const FILE_BASE = "https://app.jobnimbus.com/files";

function fail(message = "Document research provider response is unavailable.", statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function exactId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw fail("An exact provider identifier is required.", 400);
  }
  return value;
}

function endpoint(value, expected, allowLoopbackForTests) {
  const candidate = value || expected;
  const url = new URL(candidate);
  if (url.username || url.password || url.search || url.hash || candidate.endsWith("/")) {
    throw fail("Invalid research provider endpoint.", 500);
  }
  if (candidate === expected) return candidate;
  if (allowLoopbackForTests && url.protocol === "http:" && url.hostname === "127.0.0.1") return candidate;
  throw fail("Research provider endpoints must be the reviewed JobNimbus endpoints.", 500);
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value;
}

function one(payload, name) {
  const value = object(payload);
  return object(value[name] ?? value);
}

function normalizeDocument(raw) {
  const doc = object(raw);
  return {
    id: String(doc.jnid || ""),
    companyId: typeof doc.customer === "string" ? doc.customer : "",
    name: String(doc.filename || ""),
    mimeType: String(doc.content_type || ""),
    size: doc.size,
    createdAt: doc.date_created == null ? "" : String(doc.date_created),
    updatedAt: doc.date_updated == null ? "" : String(doc.date_updated),
    version: doc.date_updated == null ? "" : String(doc.date_updated),
    // Keep all relationships. Mixed contact/job or malformed relationships
    // must not silently become a trusted single-file binding.
    fileIds: [
      ...(Array.isArray(doc.related) ? doc.related.map((r) => r?.type === "contact" ? String(r.id || "") : "") : []),
      ...(doc.primary == null ? [] : [doc.primary.type === "contact" ? String(doc.primary.id || "") : ""])
    ],
    private: doc.is_private !== false,
    deleted: doc.is_deleted === true || doc.is_archived !== false || doc.is_active !== true,
    permissionDenied: doc.permission_denied === true || doc.is_uploading === true
  };
}

function normalizeParent(raw) {
  const parent = object(raw);
  return {
    id: String(parent.jnid || ""),
    companyId: typeof parent.customer === "string" ? parent.customer : "",
    number: String(parent.number ?? ""),
    carrier: typeof parent.cf_string_1 === "string" ? parent.cf_string_1 : "",
    private: parent.is_private !== false,
    deleted: parent.is_deleted === true || parent.is_archived !== false || parent.is_active !== true,
    permissionDenied: parent.permission_denied === true
  };
}

/** Fixed GET-only adapter. No generic endpoint, filters, provider keys or URLs
 * are accepted by either research data operation. No operational key fallback. */
export function createDocumentResearchProvider({
  apiKey,
  fetchImpl = fetch,
  apiBase,
  fileBase,
  allowLoopbackForTests = false,
  timeoutMs = 15000
}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw fail("Research provider credential is not configured.", 503);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw fail("Invalid research timeout.", 500);
  const api = endpoint(apiBase, API_BASE, allowLoopbackForTests);
  const files = endpoint(fileBase, FILE_BASE, allowLoopbackForTests);
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  let retryUntil = 0;
  let lastRequestAt = 0;
  const guardedFetch = async (url, options) => {
    if (Date.now() < retryUntil) {
      throw Object.assign(fail("Research provider retry delay is active.", 429), {
        retryAfterSeconds: Math.max(1, Math.ceil((retryUntil - Date.now()) / 1000))
      });
    }
    // Service operations are serialized; cap this credential at ten starts/sec.
    const waitMs = Math.min(100, Math.max(0, lastRequestAt + 100 - Date.now()));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRequestAt = Date.now();
    const response = await fetchImpl(url, options);
    if (response.status === 429 || response.status === 503) {
      const raw = response.headers.get("retry-after");
      const seconds = /^\d+$/.test(raw || "") ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
      retryUntil = Date.now() + Math.max(1, Math.min(Number.isFinite(seconds) ? seconds : 60, 3600)) * 1000;
    }
    return response;
  };
  const json = (route) => fetchBoundedJson(guardedFetch, `${api}${route}`, { method: "GET", headers }, {
    timeoutMs, maxBytes: 2 * 1024 * 1024, errorCode: "DOCUMENT_RESEARCH_PROVIDER_FAILED"
  });
  return Object.freeze({
    async listDocuments({ offset, limit }) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 10000
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || offset + limit > 10000) {
        throw fail("Research provider result window reached.", 409);
      }
      // No unverified provider filter: enumerate bounded metadata, classify
      // without photo downloads, and explicitly stop at the known result cap.
      const payload = await json(`/files?${new URLSearchParams({ from: String(offset), size: String(limit) })}`);
      const keys = ["results", "data", "items", "files"].filter((key) => Object.hasOwn(payload, key));
      if (keys.length !== 1 || !Array.isArray(payload[keys[0]])) throw fail();
      const rows = payload[keys[0]];
      if (rows.length > limit) throw fail();
      const total = payload.total ?? payload.count ?? payload.meta?.total;
      if (total != null && (!Number.isSafeInteger(total) || total < 0)) throw fail();
      return { rows: rows.map(normalizeDocument), ...(total == null ? {} : { total }) };
    },
    async getDocument(id) {
      const doc = normalizeDocument(one(await json(`/files/${exactId(id)}`), "file"));
      if (doc.id !== id) throw fail();
      return doc;
    },
    async getParent(id) {
      const parent = normalizeParent(one(await json(`/contacts/${exactId(id)}`), "contact"));
      if (parent.id !== id) throw fail();
      return parent;
    },
    async downloadDocument(id, { maxBytes }) {
      exactId(id);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw fail("Invalid byte bound.", 400);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reader;
      try {
        const response = await guardedFetch(`${files}/${id}`, {
          method: "GET", headers: { authorization: `Bearer ${apiKey}` },
          redirect: "error", signal: controller.signal
        });
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          throw fail("Research document download failed.", response.status === 429 ? 429 : 502);
        }
        const rawLength = response.headers.get("content-length");
        const length = rawLength == null ? null : Number(rawLength);
        if (length !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || length > maxBytes || length < 1)) {
          await response.body?.cancel?.().catch(() => {});
          throw fail("Research document size is invalid.");
        }
        if (!response.body?.getReader) throw fail();
        reader = response.body.getReader();
        const chunks = [];
        let count = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.byteLength;
          if (count > maxBytes) {
            await reader.cancel().catch(() => {});
            throw fail("Research document exceeded its byte limit.");
          }
          chunks.push(Buffer.from(value));
        }
        if (!count || (length !== null && length !== count)) throw fail("Research document length mismatch.");
        return { bytes: Buffer.concat(chunks, count), contentType: response.headers.get("content-type") || "", ...(length === null ? {} : { contentLength: length }) };
      } catch (error) {
        if (error?.statusCode) throw error;
        throw fail("Research document download failed.", controller.signal.aborted ? 504 : 502);
      } finally {
        clearTimeout(timer);
        reader?.releaseLock();
      }
    }
  });
}
