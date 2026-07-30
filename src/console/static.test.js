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

test("console states the hard Chance Brain boundary and honest Thresher maturity", async () => {
  const [htmlAsset, scriptAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");

  assert.match(html, /HCN has no route to Chance Brain/);
  assert.match(html, /isolated HCN Operations Brain foundation/);
  assert.match(html, /persistence[\s\S]*is not active yet/);
  assert.match(html, /untouched, quarantined, and unreachable from HCN/);
  assert.match(script, /disconnected_no_route/);
  assert.match(script, /Disconnected · no route or data flow/);
  assert.match(script, /foundation_persistence_pending/);
  assert.match(script, /Isolated foundation · persistence pending/);
  assert.match(script, /quarantined_unreachable/);
  assert.match(script, /Quarantined · unreachable from HCN/);
  assert.doesNotMatch(script, /Legacy compatibility · read only/);
  assert.doesNotMatch(script, /hcnV2ChanceBrainDataFlow/);
});

test("Work Center requests remain same-origin, CSRF-bound, fresh, and memory-only", async () => {
  const [scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(worker, /const CACHE_NAME = CACHE_PREFIX \+ "v7";/);
  assert.match(script, /identity\.type === "hcn_browser_session"/);
  const browserAuthority = script.slice(
    script.indexOf("function hasBrowserAuthority()"),
    script.indexOf("function hasWorkCenterAuthority()")
  );
  assert.doesNotMatch(browserAuthority, /identity\.role|chance/i);
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
  assert.match(
    script,
    /\{ offset: requestedOffset, limit: WORK_CENTER_PAGE_SIZE \}/
  );
  assert.match(script, /: state\.workCenterOffset/);
  assert.match(script, /normalizeWorkCenterResponse\(response, requestedOffset\)/);
  assert.match(script, /page\.offset !== expectedOffset/);
  assert.match(script, /page\.hasMore !== \(page\.offset \+ value\.files\.length < page\.total\)/);
  assert.match(script, /\{ fileRef: fileRef, recentLimit: 20 \}/);
  assert.match(script, /clearOperationalData\("Client data was cleared when the connection went offline\."/);

  assert.match(worker, /"\/hcn\/api\/"/);
  assert.match(worker, /SHELL_PATH_SET\.has\(url\.pathname\)/);
  assert.doesNotMatch(worker, /work-center|file-review/);
});

test("Connections links each authenticated employee to safe, memory-only work accounts", async () => {
  const [htmlAsset, scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(html, /href="#connections"/);
  assert.match(html, /id="connections"[\s\S]*aria-labelledby="connections-title"/);
  assert.match(html, /id="connections-profile-name"/);
  assert.match(html, /id="connections-profile-role"/);
  assert.match(html, /id="jobnimbus-connection-status"/);
  assert.match(html, /id="google-connect-action"/);
  assert.match(html, /id="google-gmail-status"/);
  assert.match(html, /id="google-calendar-status"/);
  assert.match(html, /id="quo-phone-form"[\s\S]*autocomplete="off"/);
  assert.match(html, /id="quo-code"[\s\S]*pattern="\[0-9\]\{6\}"/);
  assert.match(html, /id="quo-use-code"/);
  assert.match(html, /id="quo-restart"/);
  assert.match(html, /id="work-center-previous"/);
  assert.match(html, /id="work-center-page"/);
  assert.match(html, /id="work-center-next"/);
  assert.doesNotMatch(html, /authorized Chance account|Assigned to Chance/);
  assert.doesNotMatch(html, /type=["']password["']/i);

  for (const route of [
    "/hcn/api/v1/connectors/status",
    "/hcn/connect/google/start",
    "/hcn/api/v1/connectors/quo-line"
  ]) {
    assert.match(script, new RegExp(route.replaceAll("/", "\\/")));
  }
  for (const capability of [
    "hcn.connectors.read",
    "hcn.connectors.google.link",
    "hcn.connectors.quo_line.link"
  ]) {
    assert.match(script, new RegExp(capability.replaceAll(".", "\\.")));
  }

  assert.match(script, /"hcn\.console\.connectors\.v1"/);
  assert.match(script, /\{ mode: "status" \}/);
  assert.match(script, /\{ mode: "start", phone: phone \}/);
  assert.match(script, /\{ mode: "verify", code: code \}/);
  assert.match(script, /window\.location\.assign\(ENDPOINTS\.googleConnectStart\)/);
  assert.match(script, /function safeMaskedPhone\(value\)/);
  assert.match(script, /return digits\.length <= 4 \? masked : ""/);
  const safeLineNormalizer = script.slice(
    script.indexOf("function normalizeSafeQuoLine"),
    script.indexOf("function connectionStatus(value)")
  );
  assert.match(safeLineNormalizer, /value\.maskedNumber/);
  assert.doesNotMatch(safeLineNormalizer, /value\.(?:number|phone|phoneNumber)/);
  assert.match(script, /google\.status === "connected" \? "Reconnect Google"/);
  assert.match(script, /quo\.status === "connected" \? "Verify a different line"/);
  assert.match(script, /record\(response\)\.linked === true/);
  assert.match(script, /function showQuoCodeEntry\(\)/);
  assert.match(script, /function restartQuoConnection\(\)/);
  assert.match(script, /const outcomes = current\.searchParams\.getAll\("google"\)/);
  assert.match(script, /GOOGLE_CALLBACK_OUTCOMES\.has\(outcomes\[0\]\)/);
  assert.match(script, /"temporarily_unavailable"/);
  assert.match(script, /"invalid_request"/);
  assert.match(script, /current\.searchParams\.delete\("google"\)/);
  assert.match(script, /renderGoogleCallbackOutcome\(connections\)/);
  assert.match(script, /record\(connections\.google\)\.status !== "connected"/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);

  const clearer = script.slice(
    script.indexOf("function clearConnectionsData(message)"),
    script.indexOf("async function loadConnections()")
  );
  assert.match(clearer, /state\.connectionsController\.abort\(\)/);
  assert.match(clearer, /state\.quoController\.abort\(\)/);
  assert.match(clearer, /state\.connections = null/);
  assert.match(clearer, /state\.quoChallengePending = false/);
  assert.match(clearer, /elements\["quo-phone-form"\]\.reset\(\)/);
  assert.match(clearer, /elements\["quo-verify-form"\]\.reset\(\)/);
  const operationalClearer = script.slice(
    script.indexOf("function clearOperationalData(message)"),
    script.indexOf("function clearManagementSweepData(message)")
  );
  assert.match(operationalClearer, /clearConnectionsData\(message\)/);

  assert.match(script, /"X-HCN-CSRF": csrfToken/);
  assert.match(script, /credentials: "same-origin"/);
  assert.match(script, /cache: "no-store"/);
  assert.match(worker, /SHELL_PATH_SET\.has\(url\.pathname\)/);
  assert.doesNotMatch(worker, /connectors\/status|connectors\/quo-line|connect\/google\/start/);

  const managementAccess = script.slice(
    script.indexOf("function hasManagementSweepAuthority()"),
    script.indexOf("function hasConnectorReadAuthority()")
  );
  assert.match(managementAccess, /MANAGEMENT_SWEEP_CAPABILITY/);
  const workAccess = script.slice(
    script.indexOf("function hasWorkCenterAuthority()"),
    script.indexOf("function hasManagementSweepAuthority()")
  );
  assert.match(workAccess, /WORK_CENTER_CAPABILITY/);
  const actionAccess = script.slice(
    script.indexOf("function hasActionReadAuthority()"),
    script.indexOf("function hasActionPrepareAuthority()")
  );
  assert.match(actionAccess, /ACTION_READ_CAPABILITY/);
});

test("employee Work Center leads while the read-only 10 by 3 sweep stays capability-gated", async () => {
  const [htmlAsset, scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(html, /id="overview" class="company-today-hero"/);
  assert.match(html, /Start with the files assigned to you/);
  assert.match(html, /read only: it does not send, schedule, call, upload, or change JobNimbus/);
  assert.match(html, /Richard’s 10 × 3 Sweep/);
  assert.match(
    html,
    /id="management-sweep-refresh"[\s\S]*data-hcn-capability="hcn\.management_sweep\.read"[\s\S]*hidden/
  );
  assert.match(
    html,
    /id="management-sweep"[\s\S]*data-hcn-capability="hcn\.management_sweep\.read"[\s\S]*hidden/
  );
  assert.match(
    html,
    /href="#approvals"[\s\S]*data-hcn-capability="hcn\.action_plans\.read"[\s\S]*hidden/
  );
  assert.match(
    html,
    /href="#receipts"[\s\S]*data-hcn-capability="hcn\.action_receipts\.read"[\s\S]*hidden/
  );
  assert.match(html, /id="company-worst-list"/);
  assert.match(html, /id="adjuster-sweep-list"/);
  assert.match(html, /id="management-sweep-source-health"/);
  assert.match(html, /id="system-health"/);
  assert.match(html, /This first report uses JobNimbus activity only/);
  assert.match(html, /longest verified JobNimbus activity[\s\S]*gap/);
  assert.match(html, /Company-wide Gmail,[\s\S]*Quo,[\s\S]*calendar communication evidence is not available/);
  assert.match(html, /delivery, export, delegation, and follow-up creation belong to[\s\S]*a later approval-gated phase/);

  assert.match(script, /managementSweep: "\/hcn\/api\/v1\/management-sweep"/);
  assert.match(script, /const MANAGEMENT_SWEEP_CAPABILITY = "hcn\.management_sweep\.read"/);
  assert.match(script, /connectors\)\.managementSweep/);
  assert.match(script, /runtimeStatus !== "configured"/);
  assert.match(script, /function syncCapabilityAwareConsole\(\)/);
  assert.match(script, /document\.querySelectorAll\("\[data-hcn-capability\]"\)/);
  assert.match(script, /preferredHash = "#work-center"/);
  assert.match(script, /\{ limitPerAdjuster: 10 \}/);
  assert.match(script, /"hcn\.console\.management-sweep\.v1"/);
  assert.match(script, /value\.schemaVersion \|\| value\.schema/);
  assert.match(script, /value\.cachePolicy !== "no_store"/);
  assert.match(script, /function clearManagementSweepData\(message\)/);
  assert.match(script, /state\.managementSweep = null/);
  assert.match(script, /clearManagementSweepData\(message\);/);
  assert.match(script, /elements\["management-sweep-refresh"\]\.disabled = true/);
  assert.match(script, /No stale report is shown\./);
  assert.match(script, /communication gaps remain unverified/);
  assert.match(script, /"fetchedEventCount"/);
  assert.match(script, /"unsupportedEventCount"/);
  assert.match(script, /unsupported excluded/);
  assert.match(script, /setText\(value, "N\/A"\)/);
  const managementAccessSource = script.slice(
    script.indexOf("function syncManagementSweepAccess()"),
    script.indexOf("function renderManagementSweepLocked")
  );
  assert.doesNotMatch(managementAccessSource, /loadManagementSweep\(\)/);
  assert.match(managementAccessSource, /Run the sweep when you want a fresh company ranking/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);

  assert.match(worker, /"\/hcn\/api\/"/);
  assert.doesNotMatch(worker, /management-sweep/);

  const sweepShell = html.slice(
    html.indexOf('id="management-sweep"'),
    html.indexOf('id="work-center"')
  );
  assert.doesNotMatch(sweepShell, />\s*(?:Send|Export)\b/i);
});

test("management sweep responses expire in memory on their canonical freshness deadline", async () => {
  const scriptAsset = await readHcnConsoleAsset("/hcn/app.js");
  const script = scriptAsset.body.toString("utf8");
  const normalizer = script.slice(
    script.indexOf("function normalizeManagementSweepResponse"),
    script.indexOf("function normalizeSweepItem")
  );
  const loader = script.slice(
    script.indexOf("async function loadManagementSweep"),
    script.indexOf("function normalizeManagementSweepResponse")
  );
  const clearer = script.slice(
    script.indexOf("function clearManagementSweepData"),
    script.indexOf("async function loadManagementSweep")
  );
  const networkHandler = script.slice(
    script.indexOf("function handleNetworkChange"),
    script.indexOf("function readableTime")
  );
  const platformLoader = script.slice(
    script.indexOf("async function loadPlatformState"),
    script.indexOf("function setLoadingView")
  );
  const signOutHandler = script.slice(
    script.indexOf("async function signOut"),
    script.indexOf("function sessionCapabilities")
  );

  assert.match(script, /managementSweepExpiryTimer: null/);
  assert.match(normalizer, /const checkedAt = boundedString\(value && value\.checkedAt, 40\)/);
  assert.match(normalizer, /const validUntil = boundedString\(value && value\.validUntil, 40\)/);
  assert.match(normalizer, /new Date\(milliseconds\)\.toISOString\(\) === value/);
  assert.match(normalizer, /generatedAtMs > checkedAtMs/);
  assert.match(normalizer, /checkedAtMs >= validUntilMs/);
  assert.match(normalizer, /receivedAtMs >= validUntilMs/);
  assert.match(normalizer, /checkedAt: checkedAt/);
  assert.match(normalizer, /validUntil: validUntil/);

  assert.match(loader, /const receivedAtMs = Date\.now\(\)/);
  assert.match(loader, /normalizeManagementSweepResponse\(\s*response,\s*receivedAtMs\s*\)/);
  assert.match(loader, /scheduleManagementSweepExpiry\(state\.managementSweep\)/);
  assert.match(loader, /cancelManagementSweepExpiryTimer\(\)/);
  assert.match(clearer, /cancelManagementSweepExpiryTimer\(\)/);
  assert.match(networkHandler, /cancelManagementSweepExpiryTimer\(\)/);
  assert.match(platformLoader, /cancelManagementSweepExpiryTimer\(\)/);
  assert.match(signOutHandler, /cancelManagementSweepExpiryTimer\(\)/);
  assert.match(script, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(
    script,
    /function handleVisibilityChange\(\) \{\s*enforceSessionDeadline\(\);\s*enforceManagementSweepExpiry\(\);/
  );
  assert.match(script, /window\.setTimeout\(\s*enforceManagementSweepExpiry/);
  assert.match(script, /Date\.now\(\) >= validUntilMs/);
  assert.match(script, /function expireManagementSweep\(\)/);
  assert.match(script, /No expired company ranking is retained or shown\./);
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
