import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_CONSOLE_SECURITY_HEADERS,
  hcnConsoleAssetDescriptor,
  readHcnConsoleAsset
} from "./static.js";

test("console serves only its fixed application-shell allowlist", async () => {
  const expected = new Map([
    ["/hcn/", "text/html; charset=utf-8"],
    ["/hcn/app.css", "text/css; charset=utf-8"],
    ["/hcn/app.js", "text/javascript; charset=utf-8"],
    ["/hcn/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    ["/hcn/sw.js", "text/javascript; charset=utf-8"]
  ]);

  for (const [pathname, contentType] of expected) {
    const descriptor = hcnConsoleAssetDescriptor(pathname);
    assert.ok(descriptor);
    assert.equal(descriptor.contentType, contentType);
    const asset = await readHcnConsoleAsset(pathname);
    assert.equal(asset.headers["content-type"], contentType);
    assert.equal(asset.headers["cache-control"], "no-store, max-age=0");
    assert.equal(asset.body.length > 0, true);
  }

  for (const pathname of [
    "/hcn",
    "/hcn/auth/login",
    "/hcn/../server.js",
    "/hcn/%2e%2e/server.js",
    "/hcn/app.js.map",
    "/api/v1/meta"
  ]) {
    assert.equal(hcnConsoleAssetDescriptor(pathname), null);
    assert.equal(await readHcnConsoleAsset(pathname), null);
  }
});

test("console shell uses a strict same-origin browser policy", async () => {
  assert.match(HCN_CONSOLE_SECURITY_HEADERS["content-security-policy"], /default-src 'self'/);
  assert.match(HCN_CONSOLE_SECURITY_HEADERS["content-security-policy"], /object-src 'none'/);
  assert.match(HCN_CONSOLE_SECURITY_HEADERS["content-security-policy"], /frame-ancestors 'none'/);
  assert.doesNotMatch(HCN_CONSOLE_SECURITY_HEADERS["content-security-policy"], /unsafe-inline|unsafe-eval|\*/);
  assert.equal(HCN_CONSOLE_SECURITY_HEADERS["x-frame-options"], "DENY");
  assert.equal(HCN_CONSOLE_SECURITY_HEADERS["referrer-policy"], "no-referrer");

  const serviceWorker = await readHcnConsoleAsset("/hcn/sw.js");
  assert.equal(serviceWorker.headers["service-worker-allowed"], "/hcn/");
});

test("console shell contains no client records, bearer-token field, or browser storage", async () => {
  const [html, script, worker] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const source = Buffer.concat([html.body, script.body, worker.body]).toString("utf8");

  assert.doesNotMatch(source, /type=["']password["']/i);
  assert.doesNotMatch(source, /bearer token input/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(source, /client@example|homeowner@example|214555/i);
  assert.match(source, /\/api\/v1\/meta/);
  assert.match(source, /\/hcn\/auth\/session/);
  assert.match(source, /\/hcn\/auth\/logout/);
});
