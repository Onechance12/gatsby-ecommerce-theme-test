import { fetchBoundedJson } from "../http/bounded-json.js";
import { PDF_MAX_BYTES, providerId } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

const fail = () => { const e = new Error("PDF provider request failed; inspect the durable receipt before any retry."); e.statusCode = 409; throw e; };
export function trustedPdfStorageUrl(value, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
  return url.protocol === "https:" && (!url.port || url.port === "443")
    && (/^(?:[a-z0-9-]+\.)*s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
      || url.hostname === "app.jobnimbus.com" || url.hostname === "api.jobnimbus.com");
}

export function createPdfUploadTransport({ apiKey, fileApiBase = "https://api.jobnimbus.com", fileBase = "https://app.jobnimbus.com/files", fetchImpl = fetch, allowLoopback = false }) {
  const permittedBase = (value, expected) => value === expected || (allowLoopback && (() => {
    try { const url = new URL(value); return url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  })());
  if (!permittedBase(fileApiBase, "https://api.jobnimbus.com") || !permittedBase(fileBase, "https://app.jobnimbus.com/files")) throw new Error("Untrusted PDF provider origin.");
  const api = (endpoint, body) => fetchBoundedJson(fetchImpl, `${fileApiBase}${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  }, { timeoutMs: 15000, maxBytes: 65536, errorCode: "PDF_UPLOAD_PROVIDER_FAILED" });

  async function bytesRequest(url, options, limit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      let current = url;
      let headers = options.headers;
      for (let hops = 0; hops < 4; hops++) {
        if (!trustedPdfStorageUrl(current, { allowLoopback })) fail();
        const res = await fetchImpl(current, { ...options, headers, redirect: "manual", signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const target = res.headers.get("location");
          await res.body?.cancel();
          if (options.method !== "GET" || !target) fail();
          current = new URL(target, current).href;
          headers = {}; // Never forward a JobNimbus bearer to storage.
          continue;
        }
        if (!res.ok) { await res.body?.cancel(); fail(); }
        const reader = res.body?.getReader();
        if (!reader) {
          if (options.method === "PUT") return Buffer.alloc(0);
          fail();
        }
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) { await reader.cancel(); fail(); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, total);
      }
      fail();
    } catch { fail(); } finally { clearTimeout(timer); }
  }
  return {
    async reserve(body) {
      const result = await api("/files/v1/uploads/url", body);
      if (!providerId(result?.data?.jnid) || !trustedPdfStorageUrl(result?.data?.url, { allowLoopback })) fail();
      return { id: result.data.jnid, url: result.data.url };
    },
    put: (url, bytes) => bytesRequest(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes }, 65536),
    complete: (id) => { if (!providerId(id)) fail(); return api(`/files/v1/uploads/${encodeURIComponent(id)}/complete?generateThumbnail=true`); },
    readBytes: (id) => {
      if (!providerId(id)) fail();
      return bytesRequest(`${fileBase}/${encodeURIComponent(id)}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}` } }, PDF_MAX_BYTES);
    }
  };
}
