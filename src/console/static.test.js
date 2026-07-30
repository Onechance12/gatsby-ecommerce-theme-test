import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  HCN_CONSOLE_SECURITY_HEADERS,
  hcnConsoleAssetDescriptor,
  readHcnConsoleAsset
} from "./static.js";

function extractConsoleFunction(script, name) {
  const start = script.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = script.indexOf("\n  function ", start + 1);
  assert.notEqual(next, -1, `${name} must be followed by another function`);
  return script.slice(start, next);
}

function evaluateAuthOutcome(functionSource, href) {
  const replacements = [];
  const context = {
    AUTH_CALLBACK_OUTCOMES: new Set([
      "access_denied",
      "cancelled",
      "invalid_request",
      "provider_error",
      "temporarily_unavailable"
    ]),
    URL,
    window: {
      location: { href },
      history: {
        replaceState(_state, _title, path) {
          replacements.push(path);
        }
      }
    },
    result: null
  };
  runInNewContext(
    `${functionSource}\nresult = consumeAuthCallbackOutcome();`,
    context
  );
  return {
    outcome: context.result,
    replacements
  };
}

function evaluateAuthMessage(functionSource, outcome, authenticated) {
  const context = {
    outcome,
    authenticated,
    result: null
  };
  runInNewContext(
    `${functionSource}\nresult = authCallbackMessage(outcome, authenticated);`,
    context
  );
  return context.result
    ? JSON.parse(JSON.stringify(context.result))
    : null;
}

function evaluateAssistantRouting(functionSource, value) {
  const context = {
    ASSISTANT_ROUTES: new Set([
      "deterministic",
      "standard",
      "deep",
      "codex_escalation"
    ]),
    ASSISTANT_ROUTE_PROFILES: {
      deterministic: {
        profileId: "hcn.deterministic.v1",
        modelUsed: false
      },
      standard: {
        profileId: "hcn.openai.gpt-5.6-sol.medium.v1",
        modelUsed: true
      },
      deep: {
        profileId: "hcn.openai.gpt-5.6-sol.high.v1",
        modelUsed: true
      },
      codex_escalation: {
        profileId: "hcn.codex-operator-escalation.v1",
        modelUsed: false
      }
    },
    ASSISTANT_ROUTE_REASON_CODES: {
      deterministic: [
        "fact_only_work_center",
        "fact_only_management_sweep",
        "fact_only_file_status"
      ],
      standard: [
        "ordinary_interpretation",
        "ordinary_drafting",
        "general_assistance"
      ],
      deep: [
        "explicit_deep_review",
        "multi_source_contradiction",
        "settlement_review",
        "policy_review",
        "coverage_review",
        "claim_strategy",
        "complex_document",
        "high_stakes_ambiguity"
      ],
      codex_escalation: [
        "explicit_codex_request",
        "unsupported_live_call",
        "unsupported_upload",
        "unsupported_delete",
        "unsupported_financial_action",
        "unsupported_legal_action",
        "unsupported_capability",
        "missing_required_evidence"
      ]
    },
    boundedString(input, maximum) {
      if (typeof input !== "string") return "";
      return Array.from(input).slice(0, maximum).join("");
    },
    isRecord(input) {
      return input !== null
        && typeof input === "object"
        && !Array.isArray(input);
    },
    value,
    result: null
  };
  runInNewContext(
    `${functionSource}\nresult = normalizeAssistantRouting(value);`,
    context
  );
  return JSON.parse(JSON.stringify(context.result));
}

function evaluateAssistantSources(functionSource, value) {
  const context = {
    ASSISTANT_SOURCE_KEYS: new Set([
      "jobnimbus",
      "gmail",
      "quo",
      "google_calendar",
      "retell",
      "action_plan"
    ]),
    ASSISTANT_SOURCE_STATUSES: new Set([
      "fresh",
      "complete",
      "partial",
      "stale",
      "incomplete",
      "unavailable",
      "not_evaluated",
      "not_configured",
      "unknown",
      "pending_human_review"
    ]),
    boundedString(input, maximum) {
      if (typeof input !== "string") return "";
      return Array.from(input).slice(0, maximum).join("");
    },
    validIsoInstant(input) {
      return typeof input === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
        && new Date(input).toISOString() === input;
    },
    isRecord(input) {
      return input !== null
        && typeof input === "object"
        && !Array.isArray(input);
    },
    value,
    result: null
  };
  runInNewContext(
    `${functionSource}\nresult = normalizeAssistantSources(value);`,
    context
  );
  return JSON.parse(JSON.stringify(context.result));
}

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

  const [htmlAsset, manifestAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/manifest.webmanifest")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const manifest = JSON.parse(
    manifestAsset.body.toString("utf8")
  );
  assert.match(html, /\/hcn\/manifest\.webmanifest\?shell=v12/);
  assert.match(html, /\/hcn\/app\.css\?shell=v12/);
  assert.match(html, /\/hcn\/app\.js\?shell=v12/);
  assert.match(html, /href="\/hcn\/\?shell=v12"/);
  assert.equal(manifest.start_url, "/hcn/?shell=v12");

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
  assert.match(source, /\/hcn\/api\/v1\/assistant\/turns/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test("employee console shows one simple HCN data-protection status", async () => {
  const [htmlAsset, scriptAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");

  assert.match(html, /HCN data protection/);
  assert.match(html, /Your HCN account controls what you can see/);
  assert.match(script, /HCN data protection/);
  assert.match(script, /your account controls what you can see and propose/);
  assert.doesNotMatch(html, /Chance Brain|Jobrolo|legacy client memory/i);
  assert.doesNotMatch(script, /Chance Brain|Jobrolo|legacy client memory/i);
});

test("Ask Thresher is the simple authenticated employee home and fails closed", async () => {
  const [htmlAsset, scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(html, /<h1 id="company-today-title">Ask Thresher<\/h1>/);
  assert.match(html, /id="assistant-transcript"[\s\S]*role="log"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="assistant-form"/);
  assert.match(html, /id="assistant-prompt"[\s\S]*maxlength="2000"/);
  assert.match(html, /id="assistant-send"/);
  assert.match(html, /id="assistant-alert"[\s\S]*role="status"/);
  assert.match(html, /id="assistant-review-action"/);
  assert.match(html, /id="assistant-mode"[\s\S]*<legend>Thinking mode<\/legend>/);
  assert.match(
    html,
    /id="assistant-mode-auto"[\s\S]*value="auto"[\s\S]*checked/
  );
  assert.match(html, /id="assistant-mode-deep"[\s\S]*value="deep"/);
  assert.match(html, /id="assistant-pilot"[\s\S]*Pilot check/);
  assert.match(html, /id="assistant-pilot-route"/);
  assert.match(html, /id="assistant-pilot-sources"/);
  assert.match(html, /id="assistant-pilot-plans"/);
  assert.match(html, /Nothing executes in chat/);
  for (const label of [
    "Work my files",
    "Find a file",
    "Show neglected files",
    "Review communications",
    "Draft a follow-up",
    "File a claim"
  ]) {
    assert.match(html, new RegExp(`>${label}<`));
  }

  assert.match(script, /assistantTurns: "\/hcn\/api\/v1\/assistant\/turns"/);
  assert.match(script, /const ASSISTANT_TURN_CAPABILITY = "hcn\.assistant\.turn"/);
  assert.match(
    script,
    /ENDPOINTS\.assistantTurns,[\s\S]*\{ prompt: prompt, mode: mode \}/
  );
  assert.match(script, /ASSISTANT_TURN_CAPABILITY/);
  assert.match(script, /postOperationalJson\(/);
  assert.match(script, /"hcn\.console\.assistant-turn\.v2"/);
  assert.match(script, /function normalizeAssistantTurnResponse\(value\)/);
  assert.match(script, /function normalizeAssistantRouting\(value\)/);
  assert.match(script, /const ASSISTANT_MODES = new Set\(\["auto", "deep"\]\)/);
  assert.match(script, /"codex_escalation"/);
  assert.match(script, /"route",[\s\S]*"profileId",[\s\S]*"reasonCodes",[\s\S]*"modelUsed"/);
  assert.match(script, /value\.reasonCodes\.length > 12/);
  assert.match(script, /profileId !== routeContract\.profileId/);
  assert.match(script, /value\.modelUsed !== routeContract\.modelUsed/);
  assert.match(script, /!allowedReasonCodes\.includes\(reason\)/);
  assert.match(script, /new Set\(reasonCodes\)\.size !== reasonCodes\.length/);
  assert.match(script, /function normalizeAssistantSources\(value\)/);
  assert.match(script, /function selectedAssistantMode\(\)/);
  assert.match(script, /function renderAssistantPilot\(turn\)/);
  assert.match(script, /state\.assistantPreparedPlanCount \+= 1/);
  assert.match(script, /keys\.length !== allowed\.size/);
  assert.match(script, /value\.ephemeral !== true/);
  assert.match(script, /value\.cachePolicy !== "no_store"/);
  assert.match(script, /authority\.canExecuteActions !== false/);
  assert.match(script, /authority\.exactHumanApprovalRequired !== true/);
  assert.match(script, /value\.plan === null \|\| isRecord\(value\.plan\)/);
  assert.match(script, /normalizeActionPlan\(value\.plan, true\)\.planId/);
  assert.match(
    script,
    /elements\["assistant-prompt"\]\.disabled = \(\s*!available \|\| runtimeStatus === "direct_only"\s*\)/
  );
  assert.match(
    script,
    /elements\["assistant-send"\]\.disabled = \(\s*!available \|\| runtimeStatus === "direct_only"\s*\)/
  );
  assert.match(script, /setText\(paragraph, boundedString\(message, 16000\)\)/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(script, /window\.location\.hash = "#approvals"/);
  assert.match(script, /loadActionPlans\(\{ selectPlanId: planId \}\)/);
  assert.match(script, /state\.assistantController\.abort\(\)/);
  assert.match(script, /elements\["assistant-transcript"\]\.replaceChildren\(\)/);
  assert.match(script, /elements\["assistant-mode-auto"\]\.checked = true/);
  assert.match(script, /state\.assistantPreparedPlanCount = 0/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
  assert.doesNotMatch(worker, /assistant\/turns/);
});

test("Ask Thresher accepts only the exact bounded reasoning-routing contract", async () => {
  const asset = await readHcnConsoleAsset("/hcn/app.js");
  const script = asset.body.toString("utf8");
  const normalize = extractConsoleFunction(
    script,
    "normalizeAssistantRouting"
  );
  const valid = {
    route: "deep",
    profileId: "hcn.openai.gpt-5.6-sol.high.v1",
    reasonCodes: ["explicit_deep_review"],
    modelUsed: true
  };

  assert.deepEqual(evaluateAssistantRouting(normalize, valid), valid);
  for (const invalid of [
    { ...valid, route: "unknown" },
    { ...valid, extra: true },
    { ...valid, profileId: "" },
    { ...valid, profileId: "totally-untrusted" },
    { ...valid, reasonCodes: [] },
    { ...valid, reasonCodes: ["made_up"] },
    {
      ...valid,
      reasonCodes: ["explicit_deep_review", "explicit_deep_review"]
    },
    { ...valid, reasonCodes: ["x".repeat(81)] },
    { ...valid, modelUsed: false },
    {
      route: "deterministic",
      profileId: "hcn.deterministic.v1",
      reasonCodes: ["fact_only_work_center"],
      modelUsed: true
    }
  ]) {
    assert.throws(
      () => evaluateAssistantRouting(normalize, invalid),
      /Invalid assistant response/
    );
  }
});

test("Ask Thresher accepts only bounded known source projections", async () => {
  const asset = await readHcnConsoleAsset("/hcn/app.js");
  const script = asset.body.toString("utf8");
  const normalize = extractConsoleFunction(
    script,
    "normalizeAssistantSources"
  );
  const valid = [{
    key: "jobnimbus",
    label: "JobNimbus assigned files",
    status: "fresh",
    checkedAt: "2026-07-30T12:00:00.000Z"
  }];

  assert.deepEqual(evaluateAssistantSources(normalize, valid), [{
    key: "jobnimbus",
    label: "JobNimbus assigned files",
    status: "fresh"
  }]);
  for (const invalid of [
    [{ ...valid[0], key: "unknown_source" }],
    [{ ...valid[0], status: "invented" }],
    [{ ...valid[0], extra: true }],
    [{ ...valid[0], checkedAt: "" }],
    [valid[0], valid[0]]
  ]) {
    assert.throws(
      () => evaluateAssistantSources(normalize, invalid),
      /Invalid assistant response/
    );
  }
});

test("Work Center requests remain same-origin, CSRF-bound, fresh, and memory-only", async () => {
  const [scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(worker, /const CACHE_PREFIX = "hcn-console-shell-";/);
  assert.match(worker, /caches\.keys\(\)/);
  assert.match(worker, /caches\.delete\(name\)/);
  assert.match(worker, /self\.clients\.matchAll\(/);
  assert.match(worker, /client\.navigate\("\/hcn\/"\)/);
  assert.match(worker, /self\.registration\.unregister\(\)/);
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
  assert.doesNotMatch(worker, /caches\.open|caches\.match|cache\.addAll/);
  assert.match(script, /\/hcn\/sw\.js\?shell=v12/);
  assert.match(script, /serviceWorker\.getRegistration\("\/hcn\/"\)/);
  assert.match(script, /window\.location\.replace\(ENDPOINTS\.login\)/);
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

  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
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
  assert.match(html, /id="home-auth-alert"[\s\S]*aria-live="polite"/);
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
  assert.match(script, /const outcomes = current\.searchParams\.getAll\("auth"\)/);
  assert.match(script, /AUTH_CALLBACK_OUTCOMES\.has\(outcomes\[0\]\)/);
  assert.match(script, /current\.searchParams\.delete\("auth"\)/);
  assert.match(script, /renderAuthCallbackOutcome\(\)/);
  assert.match(script, /authCallbackMessage\(\s*outcome,\s*hasBrowserAuthority\(\)/);
  assert.match(script, /if \(!outcome \|\| authenticated\) return null/);
  assert.match(script, /That sign-in attempt expired or could not be verified/);
  assert.match(script, /Google sign-in did not finish/);
  assert.match(script, /active JobNimbus employee profile/);
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
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
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

test("employee sign-in outcomes are consumed once without disturbing other URL state", async () => {
  const asset = await readHcnConsoleAsset("/hcn/app.js");
  const script = asset.body.toString("utf8");
  const consume = extractConsoleFunction(
    script,
    "consumeAuthCallbackOutcome"
  );

  assert.deepEqual(
    evaluateAuthOutcome(
      consume,
      "https://hcn.example/hcn/?auth=cancelled&keep=1#connections"
    ),
    {
      outcome: "cancelled",
      replacements: ["/hcn/?keep=1#connections"]
    }
  );
  assert.deepEqual(
    evaluateAuthOutcome(
      consume,
      "https://hcn.example/hcn/?auth=cancelled&auth=cancelled&keep=1#overview"
    ),
    {
      outcome: "",
      replacements: ["/hcn/?keep=1#overview"]
    }
  );
  assert.deepEqual(
    evaluateAuthOutcome(
      consume,
      "https://hcn.example/hcn/?auth=unknown&keep=1"
    ),
    {
      outcome: "",
      replacements: ["/hcn/?keep=1"]
    }
  );
  assert.deepEqual(
    evaluateAuthOutcome(
      consume,
      "https://hcn.example/hcn/?auth=access_denied&google=connected&keep=1#connections"
    ),
    {
      outcome: "access_denied",
      replacements: ["/hcn/?google=connected&keep=1#connections"]
    }
  );
  assert.deepEqual(
    evaluateAuthOutcome(
      consume,
      "https://hcn.example/hcn/?google=connected#connections"
    ),
    {
      outcome: "",
      replacements: []
    }
  );
});

test("employee sign-in guidance is accurate and suppressed for valid sessions", async () => {
  const asset = await readHcnConsoleAsset("/hcn/app.js");
  const script = asset.body.toString("utf8");
  const message = extractConsoleFunction(
    script,
    "authCallbackMessage"
  );

  assert.equal(
    evaluateAuthMessage(message, "access_denied", true),
    null
  );
  assert.deepEqual(
    evaluateAuthMessage(message, "cancelled", false),
    {
      text: "Sign-in was canceled. Try again when you are ready.",
      tone: "warn"
    }
  );
  assert.match(
    evaluateAuthMessage(message, "access_denied", false).text,
    /active JobNimbus employee profile/
  );
  assert.match(
    evaluateAuthMessage(message, "invalid_request", false).text,
    /expired or could not be verified/
  );
  assert.match(
    evaluateAuthMessage(message, "provider_error", false).text,
    /did not finish/
  );
  assert.match(
    evaluateAuthMessage(message, "temporarily_unavailable", false).text,
    /temporarily unavailable/
  );
  assert.equal(
    evaluateAuthMessage(message, "unknown", false),
    null
  );
});

test("employee home stays simple while the 10 by 3 sweep remains capability-gated", async () => {
  const [htmlAsset, scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");

  assert.match(
    html,
    /id="overview"[\s\S]*class="assistant-view console-view is-current-view"/
  );
  assert.match(html, /aria-label="HCN Work Center home"/);
  assert.match(html, /<strong>HCN Work Center<\/strong>/);
  assert.match(html, /Ask Thresher/);
  assert.match(html, /aria-live="polite"[\s\S]*id="home-next-action"/);
  assert.equal((html.match(/data-assistant-starter=/g) || []).length, 6);
  assert.match(html, /data-assistant-starter="Show my assigned Work Center\."/);
  assert.match(html, /data-assistant-direct="true"/);
  assert.match(html, /data-assistant-starter="Show me my neglected files/);
  assert.match(html, /data-assistant-starter="Review my recent file-related communications/);
  assert.match(script, /setConnection\("good", "System ready"\)/);
  assert.match(html, /Richard’s 10 × 3 report/);
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
  assert.match(html, /longest verified\s+JobNimbus activity\s+gap/);
  assert.match(html, /Company-wide Gmail,[\s\S]*Quo,[\s\S]*calendar communication evidence is not available/);
  assert.match(html, /delivery, export, delegation, and follow-up creation belong to[\s\S]*a later approval-gated phase/);

  assert.match(script, /managementSweep: "\/hcn\/api\/v1\/management-sweep"/);
  assert.match(script, /const MANAGEMENT_SWEEP_CAPABILITY = "hcn\.management_sweep\.read"/);
  assert.match(script, /connectors\)\.managementSweep/);
  assert.match(script, /runtimeStatus !== "configured"/);
  assert.match(script, /function syncCapabilityAwareConsole\(\)/);
  assert.match(script, /document\.querySelectorAll\("\[data-hcn-capability\]"\)/);
  assert.match(script, /preferredHash = "#overview"/);
  assert.match(script, /function syncHomeGuidance\(\)/);
  assert.match(script, /document\.querySelectorAll\("\.console-view"\)/);
  assert.match(script, /document\.body\.classList\.add\("console-ready"\)/);
  assert.match(script, /"Finish your connections"/);
  assert.match(script, /"Open your assigned files"/);
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

  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
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

test("approval composer exposes every bounded HCN browser action and no unsupported effect", async () => {
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
    "jobnimbus.update_contact",
    "jobnimbus.create_calendar_event",
    "jobnimbus.update_calendar_event",
    "gmail.create_draft",
    "gmail.send",
    "quo.send_text"
  ]) {
    assert.match(html, new RegExp(`value="${action.replace(".", "\\.")}"`));
    assert.match(script, new RegExp(`"${action.replace(".", "\\.")}"`));
  }

  const composer = html.slice(
    html.indexOf('id="action-composer"'),
    html.indexOf('id="approvals"')
  );
  const actionSelect = composer.slice(
    composer.indexOf('id="action-type"'),
    composer.indexOf("</select>", composer.indexOf('id="action-type"'))
  );
  assert.equal((actionSelect.match(/<option value="/g) || []).length, 10);
  assert.match(composer, /<optgroup label="JobNimbus">/);
  assert.match(composer, /<optgroup label="Email">/);
  assert.match(composer, /<optgroup label="Text">/);
  assert.match(html, /id="update-task-ref"/);
  assert.match(html, /id="update-event-ref"/);
  assert.match(html, /id="gmail-send-draft-ref"/);
  assert.match(html, /id="quo-text-to"[\s\S]*placeholder="\+15551234567"/);
  assert.match(html, /Central time/);
  assert.match(html, /id="approval-acknowledge" type="checkbox" disabled/);
  assert.match(html, /Prepare immutable review/);
  assert.match(html, /Execute approved plan/);
  assert.match(script, /const TASK_REF = \/\^ref_/);
  assert.match(script, /const EVIDENCE_REF = \/\^ref_/);
  assert.match(script, /const E164_PHONE = \/\^\\\+/);
  assert.match(script, /reference: reference/);
  assert.match(script, /state\.actionDraft = state\.actionDraft\.concat/);
  assert.match(script, /MAX_ACTIONS = 12/);
  assert.match(script, /new TextEncoder\(\)\.encode\(value\)\.length/);
  assert.match(script, /function populateEventOptions\(activities\)/);
  assert.match(script, /function populateDraftOptions\(\)/);
  assert.match(script, /function centralLocalDateTimeToIso\(value\)/);
  assert.match(script, /timeZone: "America\/Chicago"/);
  assert.match(script, /function normalizeAttachmentDescriptors\(value\)/);
  assert.match(script, /createdDraftRefs: createdDraftRefs/);
  assert.doesNotMatch(
    composer,
    /google_calendar|attachment[^<]*input|upload|delete|payment|financial|live call|voice call/i
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

  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
  assert.doesNotMatch(worker, /action-plans|action-receipts/);
});
