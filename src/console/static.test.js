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
  assert.match(source, /\/hcn\/api\/v1\/work-center/);
  assert.match(source, /\/hcn\/api\/v1\/file-review/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test("Work Center requests remain same-origin, CSRF-bound, fresh, and memory-only", async () => {
  const [scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(worker, /const CACHE_NAME = CACHE_PREFIX \+ "v5";/);
  assert.match(script, /identity\.type === "hcn_browser_session"/);
  assert.match(script, /identity\.role === "chance"/);
  assert.match(script, /hcn\.work_center\.read/);
  assert.match(script, /"X-HCN-CSRF": csrfToken/);
  assert.match(script, /credentials: "same-origin"/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /x-hcn-session-idle-expires-at/);
  assert.match(script, /x-hcn-session-expires-at/);
  assert.match(script, /scheduleSessionExpiry/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /function purgeFileReviewDom\(\)/);
  assert.match(script, /purgeFileReviewDom\(\);/);
  assert.match(script, /resetFileEvidenceContainers\("No client data is retained\."\)/);
  assert.match(
    script,
    /The HCN session expired\. Client data was cleared from this page\./
  );
  assert.match(script, /\{ offset: 0, limit: 25 \}/);
  assert.match(script, /\{ fileRef: fileRef, recentLimit: 20 \}/);
  assert.match(script, /clearOperationalData\("Client data was cleared when the connection went offline\."/);

  assert.match(worker, /"\/hcn\/api\/"/);
  assert.match(worker, /SHELL_PATH_SET\.has\(url\.pathname\)/);
  assert.doesNotMatch(worker, /work-center|file-review/);
});

test("approval composer exposes only the bounded HCN v1 JobNimbus actions", async () => {
  const [htmlAsset, scriptAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");

  for (const action of [
    "jobnimbus.create_note",
    "jobnimbus.create_task",
    "jobnimbus.update_task",
    "jobnimbus.update_status",
    "jobnimbus.update_contact"
  ]) {
    assert.match(html, new RegExp(`value="${action.replace(".", "\\.")}"`));
    assert.match(script, new RegExp(`"${action.replace(".", "\\.")}"`));
  }

  assert.match(html, /id="update-task-ref"/);
  assert.match(html, /id="approval-acknowledge" type="checkbox" disabled/);
  assert.match(html, /Prepare immutable review/);
  assert.match(html, /Execute approved plan/);
  assert.match(script, /const TASK_REF = \/\^ref_/);
  assert.match(script, /reference: reference/);
  assert.match(script, /state\.actionDraft = state\.actionDraft\.concat/);
  assert.match(script, /MAX_ACTIONS = 12/);
  assert.match(script, /new TextEncoder\(\)\.encode\(value\)\.length/);
  const composer = html.slice(
    html.indexOf('id="action-composer"'),
    html.indexOf('id="approvals"')
  );
  assert.doesNotMatch(
    composer,
    /gmail\.|quo\.|calendar\.|upload|delete|payment|financial/i
  );
});

test("action plans require immutable review, acknowledgment, capability, and both gates", async () => {
  const scriptAsset = await readHcnConsoleAsset("/hcn/app.js");
  const script = scriptAsset.body.toString("utf8");

  for (const route of [
    "/hcn/api/v1/action-plans/prepare",
    "/hcn/api/v1/action-plans/list",
    "/hcn/api/v1/action-plans/detail",
    "/hcn/api/v1/action-plans/execute",
    "/hcn/api/v1/action-plans/invalidate",
    "/hcn/api/v1/action-receipts/list",
    "/hcn/api/v1/action-receipts/detail"
  ]) {
    assert.match(script, new RegExp(route.replaceAll("/", "\\/")));
  }

  for (const capability of [
    "hcn.action_plans.prepare",
    "hcn.action_plans.read",
    "hcn.action_plans.execute",
    "hcn.action_plans.invalidate",
    "hcn.action_receipts.read"
  ]) {
    assert.match(script, new RegExp(capability.replace(".", "\\.")));
  }

  assert.match(script, /\{ fileRef: fileRef, operations: operations \}/);
  assert.match(script, /\{ planId: planId \}/);
  assert.match(script, /runtimeGateEnabled\("externalWrites"\)/);
  assert.match(script, /runtimeGateEnabled\("hcnActionExecution"\)/);
  assert.match(
    script,
    /elements\["approval-acknowledge"\]\.checked !== true/
  );
  assert.match(
    script,
    /elements\["approval-execute"\]\.addEventListener\(\s*"click",\s*executeSelectedPlan/
  );
  assert.equal((script.match(/ENDPOINTS\.actionExecute/g) || []).length, 1);
  assert.equal((script.match(/\bexecuteSelectedPlan\b/g) || []).length, 2);
  assert.match(script, /assertNoStoreEnvelope\(value\)/);
  assert.match(script, /value\.schema !== "hcn\.console\.actions\.v1"/);
  assert.match(script, /authority\.automaticExecution !== false/);
  assert.match(script, /authority\.automaticRetry !== false/);
  assert.match(script, /authority\.providerIdentifiersExposed !== false/);
  assert.match(script, /setText\(elements\["approval-digest"\], plan\.approvalDigest\)/);
  assert.match(
    script,
    /The outcome could not be confirmed\. Do not retry\. Refresh receipts and reconcile/
  );
  assert.match(script, /if \(status === "executed"\) return "good"/);
  assert.doesNotMatch(
    script,
    /status === "executed" \|\| status === "completed_pending_verification"/
  );
  assert.match(
    script,
    /fresh JobNimbus verification is still required\. Do not repeat them\./
  );
  assert.match(
    script,
    /Execution has no terminal receipt yet\. Do not retry; reconcile/
  );
  assert.doesNotMatch(
    script,
    /durable receipts for this browser session/i
  );
  assert.doesNotMatch(script, /approvalChallenge/);
  assert.doesNotMatch(script, /setInterval\(/);
});

test("action and receipt data are memory-only, purge on operational loss, and bypass the shell cache", async () => {
  const [scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(script, /function clearActionControlData\(message\)/);
  assert.match(
    script,
    /clearActionControlData\(\s*message \|\| "Action plans and receipt metadata are not retained on this page\."/
  );
  assert.match(script, /clearOperationalData\("Client data was cleared when the connection went offline\."/);
  assert.match(script, /resetActionComposerForFile\(/);
  assert.match(script, /purgeApprovalDetailDom\(\)/);
  assert.match(script, /purgeReceiptDetailDom\(\)/);
  assert.match(script, /state\.actionDraft = \[\]/);
  assert.match(script, /state\.actionPlans = null/);
  assert.match(script, /state\.receipts = null/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);

  assert.match(worker, /"\/hcn\/api\/"/);
  assert.match(worker, /SHELL_PATH_SET\.has\(url\.pathname\)/);
  assert.doesNotMatch(worker, /action-plans|action-receipts/);
});
