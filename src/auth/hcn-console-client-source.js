import { isIP } from "node:net";

const MAX_FORWARDED_FOR_BYTES = 2048;
const MAX_FORWARDED_HOPS = 16;

/**
 * Derive the login-admission source at the trusted HTTP boundary.
 *
 * Render documents that the real client IP is forwarded in
 * X-Forwarded-For and that the service port is not directly internet
 * reachable. Outside Render, only the direct peer address is accepted.
 */
export function hcnLoginSourceFromRequest(
  request,
  { renderProxy = false } = {}
) {
  if (!request || typeof request !== "object") return "";
  if (typeof renderProxy !== "boolean") return "";

  if (renderProxy) {
    const header = request.headers?.["x-forwarded-for"];
    if (
      typeof header !== "string" ||
      Buffer.byteLength(header, "utf8") > MAX_FORWARDED_FOR_BYTES
    ) {
      return "";
    }
    const hops = header.split(",");
    if (hops.length === 0 || hops.length > MAX_FORWARDED_HOPS) return "";
    const client = normalizeIp(hops[0]);
    return client ? `render:${client}` : "";
  }

  const direct = normalizeIp(request.socket?.remoteAddress);
  return direct ? `direct:${direct}` : "";
}

function normalizeIp(value) {
  let candidate = String(value || "").trim().toLowerCase();
  if (candidate.startsWith("::ffff:")) {
    candidate = candidate.slice("::ffff:".length);
  }
  return isIP(candidate) ? candidate : "";
}
