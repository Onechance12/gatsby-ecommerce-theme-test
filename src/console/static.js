import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CONSOLE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const ASSETS = Object.freeze({
  "/hcn/": ["index.html", "text/html; charset=utf-8"],
  "/hcn/app.css": ["app.css", "text/css; charset=utf-8"],
  "/hcn/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/hcn/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  "/hcn/sw.js": ["sw.js", "text/javascript; charset=utf-8"]
});

export const HCN_CONSOLE_SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "content-security-policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin"
});

export function hcnConsoleAssetDescriptor(pathname) {
  const descriptor = ASSETS[String(pathname || "")];
  if (!descriptor) return null;
  return Object.freeze({
    pathname: String(pathname),
    filename: descriptor[0],
    contentType: descriptor[1]
  });
}

export async function readHcnConsoleAsset(pathname) {
  const descriptor = hcnConsoleAssetDescriptor(pathname);
  if (!descriptor) return null;
  const absolutePath = path.join(CONSOLE_ROOT, descriptor.filename);
  const body = await readFile(absolutePath);
  return {
    body,
    headers: {
      ...HCN_CONSOLE_SECURITY_HEADERS,
      "content-type": descriptor.contentType,
      ...(descriptor.filename === "sw.js"
        ? { "service-worker-allowed": "/hcn/" }
        : {})
    }
  };
}
