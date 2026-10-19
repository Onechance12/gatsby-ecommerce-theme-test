import { fetchBoundedJson } from "../http/bounded-json.js";
import { PDF_MAX_BYTES, providerId, pdfHash, safePdfTransportDiagnostic } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

// Only fixed categories and bounded numbers can leave this transport. Never attach
// a provider response, signed URL, credential, client content or raw exception.
export class PdfProviderError extends Error {
  constructor(reason, context = {}) {
    const diagnostic = Object.freeze(safePdfTransportDiagnostic({ ...context, reason }));
    super(`PDF provider request failed [${Object.entries(diagnostic).map(([key, value]) => `${key}=${value}`).join("; ")}]; inspect the durable receipt before any retry.`);
    this.name = "PdfProviderError";
    this.statusCode = 409;
    this.diagnostic = diagnostic;
  }
}
const fail = (reason, context) => { throw new PdfProviderError(reason, context); };
const destinationCategory = (url) => ["app.jobnimbus.com", "api.jobnimbus.com"].includes(url.hostname) ? "jobnimbus" : "storage";
const standardS3Host = (host) => /^(?:[a-z0-9-]+\.)*s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
function hostCategory(host) {
  const known = { "app.jobnimbus.com": "jobnimbus_app", "api.jobnimbus.com": "jobnimbus_api", "api3.jobnimbus.com": "jobnimbus_api3", "files.jobnimbus.com": "jobnimbus_files" };
  if (Object.hasOwn(known, host)) return known[host];
  if (host.endsWith(".jobnimbus.com")) return "jobnimbus_other";
  if (standardS3Host(host)) return "s3_standard";
  if (/^(?:[a-z0-9-]+\.)*s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com$/.test(host)) return "s3_dualstack";
  if (/^(?:[a-z0-9-]+\.)*s3-accelerate(?:\.dualstack)?\.amazonaws\.com$/.test(host)) return "s3_accelerate";
  if (host.endsWith(".amazonaws.com")) return "aws_other";
  if (host.endsWith(".cloudfront.net")) return "cloudfront";
  return host === "127.0.0.1" ? "loopback" : "other";
}
export function pdfStorageUrlPolicy(value, { allowLoopback = false, operation = "put" } = {}) {
  let url;
  try { url = new URL(value); } catch { return { allowed: false, urlRejection: "malformed_url" }; }
  const diagnostic = { hostCategory: hostCategory(url.hostname), hostFingerprint: pdfHash(url.hostname) };
  const reject = (urlRejection) => ({ allowed: false, ...diagnostic, urlRejection });
  if (url.username || url.password) return reject("embedded_credentials");
  if (url.hash) return reject("fragment");
  if (allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1") return { allowed: true, ...diagnostic };
  if (url.protocol !== "https:") return reject("insecure_protocol");
  if (url.port && url.port !== "443") return reject("non_default_port");
  // The provider's file-download redirect is read-only. Reservation/PUT trust
  // stays unchanged, and this cross-origin hop never receives the bearer.
  const fileDownload = operation === "read" && url.hostname === "files.jobnimbus.com";
  if (!fileDownload && !standardS3Host(url.hostname) && !["app.jobnimbus.com", "api.jobnimbus.com"].includes(url.hostname)) return reject("disallowed_hostname");
  return { allowed: true, ...diagnostic };
}
export const trustedPdfStorageUrl = (value, options) => pdfStorageUrlPolicy(value, options).allowed;

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
    let context = { operation: options.method === "GET" ? "read" : "put" };
    let phase = "request";
    try {
      let current = url;
      let headers = options.headers;
      for (let hops = 0; hops < 4; hops++) {
        context = { operation: context.operation, hop: hops };
        const policy = pdfStorageUrlPolicy(current, { allowLoopback, operation: context.operation });
        if (!policy.allowed) fail("untrusted_destination", { ...context, ...policy });
        const currentUrl = new URL(current);
        context.destination = destinationCategory(currentUrl);
        phase = "request";
        const res = await fetchImpl(current, { ...options, headers, redirect: "manual", signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const target = res.headers.get("location");
          await res.body?.cancel().catch(() => {});
          if (options.method !== "GET") fail("redirect_not_allowed", context);
          if (!target) fail("invalid_redirect", context);
          let nextUrl;
          try { nextUrl = new URL(target, current); } catch { fail("invalid_redirect", context); }
          // Retain authentication only within the same trusted JobNimbus origin.
          // Once stripped on a cross-origin hop, it is never reintroduced.
          if (nextUrl.origin !== currentUrl.origin || context.destination !== "jobnimbus") headers = {};
          current = nextUrl.href;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          fail("http_status", { ...context, upstreamStatus: res.status });
        }
        phase = "read";
        const reader = res.body?.getReader();
        if (!reader) {
          if (options.method === "PUT") return Buffer.alloc(0);
          fail("missing_body", context);
        }
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) { await reader.cancel().catch(() => {}); fail("body_too_large", context); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, total);
      }
      fail("redirect_limit", context);
    } catch (error) {
      if (error instanceof PdfProviderError) throw error;
      fail(controller.signal.aborted || error?.name === "AbortError" ? "timeout"
        : phase === "read" ? "read_failure" : "network_failure", context);
    } finally { clearTimeout(timer); }
  }
  return {
    async reserve(body) {
      const result = await api("/files/v1/uploads/url", body);
      if (!providerId(result?.data?.jnid) || !trustedPdfStorageUrl(result?.data?.url, { allowLoopback })) fail("invalid_reservation", { operation: "reserve", destination: "jobnimbus" });
      return { id: result.data.jnid, url: result.data.url };
    },
    put: (url, bytes) => bytesRequest(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes }, 65536),
    complete: (id) => { if (!providerId(id)) fail("invalid_provider_id", { operation: "complete", destination: "jobnimbus" }); return api(`/files/v1/uploads/${encodeURIComponent(id)}/complete?generateThumbnail=true`); },
    readBytes: (id) => {
      if (!providerId(id)) fail("invalid_provider_id", { operation: "read", destination: "jobnimbus" });
      return bytesRequest(`${fileBase}/${encodeURIComponent(id)}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}` } }, PDF_MAX_BYTES);
    }
  };
}
