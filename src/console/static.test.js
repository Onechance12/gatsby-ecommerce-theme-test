import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  HCN_CONSOLE_SECURITY_HEADERS,
  hcnConsoleAssetDescriptor,
  isPublicHcnConsoleAsset,
  readHcnConsoleAsset
} from "./static.js";

function extractConsoleFunction(script, name) {
  const starts = [
    script.indexOf(`  function ${name}(`),
    script.indexOf(`  async function ${name}(`)
  ].filter((candidate) => candidate >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  assert.notEqual(start, -1, `${name} must exist`);
  const nextMatch = /\n  (?:async )?function /.exec(script.slice(start + 1));
  const next = nextMatch ? start + 1 + nextMatch.index : -1;
  assert.notEqual(next, -1, `${name} must be followed by another function`);
  return script.slice(start, next);
}

function extractCssRule(style, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m")
    .exec(style);
  assert.ok(match, `${selector} CSS rule must exist`);
  return match[1];
}

function extractCssMediaBlocks(style, maximumWidth) {
  const matcher = new RegExp(
    `@media\\s*\\(\\s*max-width\\s*:\\s*${maximumWidth}px\\s*\\)\\s*\\{`,
    "g"
  );
  const blocks = [];
  let match;
  while ((match = matcher.exec(style)) !== null) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let closed = false;
    for (let index = openingBrace; index < style.length; index += 1) {
      if (style[index] === "{") depth += 1;
      if (style[index] !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      blocks.push(style.slice(openingBrace + 1, index));
      matcher.lastIndex = index + 1;
      closed = true;
      break;
    }
    assert.equal(closed, true, `@media max-width ${maximumWidth}px must close`);
  }
  assert.ok(blocks.length > 0, `@media max-width ${maximumWidth}px must exist`);
  return blocks;
}

function createTestDocument() {
  function createTextNode(value) {
    return {
      nodeType: 3,
      textContent: String(value)
    };
  }

  function createElement(tagName) {
    const attributes = new Map();
    const childNodes = [];
    return {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      className: "",
      dataset: {},
      childNodes,
      attributes,
      append(...children) {
        childNodes.push(...children.map(function (child) {
          return typeof child === "string" ? createTextNode(child) : child;
        }));
      },
      setAttribute(name, value) {
        attributes.set(String(name), String(value));
      },
      get textContent() {
        return childNodes.map(function (child) { return child.textContent; }).join("");
      },
      set textContent(value) {
        childNodes.splice(0, childNodes.length, createTextNode(value));
      }
    };
  }

  return { createElement, createTextNode };
}

function descendantElements(root, tagName) {
  const wanted = tagName ? String(tagName).toUpperCase() : null;
  const found = [];
  function visit(node) {
    if (!node || node.nodeType !== 1) return;
    if (!wanted || node.tagName === wanted) found.push(node);
    node.childNodes.forEach(visit);
  }
  visit(root);
  return found;
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
        profileId: "hcn.thresher.groq.gpt-oss-20b.medium.v1",
        modelUsed: true
      },
      deep: {
        profileId: "hcn.thresher.groq.gpt-oss-20b.high.v1",
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
        "fact_only_general_work_center_summary",
        "fact_only_general_help",
        "fact_only_assigned_work_summary",
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
      "weather"
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

function invitationFunctionBundle(script, names) {
  return names.map((name) => extractConsoleFunction(script, name)).join("\n");
}

function invitationEvaluationContext(overrides = {}) {
  return {
    INVITATION_REF: /^invite_[a-f0-9]{32}$/,
    INVITATION_APPROVAL_ID: /^[A-Za-z0-9_-]{8,128}$/,
    INVITATION_APPROVAL_DIGEST: /^[a-f0-9]{64}$/,
    INVITATION_ROLES: new Set([
      "employee",
      "client_coordinator",
      "manager",
      "administrator"
    ]),
    INVITATION_FORM_ROLES: new Set([
      "employee",
      "client_coordinator",
      "manager"
    ]),
    INVITATION_STATES: new Set([
      "pending",
      "accepted",
      "revoked",
      "expired"
    ]),
    URL,
    window: {
      location: {
        origin: "https://hcn.example"
      }
    },
    result: null,
    ...overrides
  };
}

function evaluateInvitationApproval(script, value) {
  const source = invitationFunctionBundle(script, [
    "normalizeTeamInvitationApproval",
    "objectHasOnlyKeys",
    "objectHasAllKeys",
    "objectHasExactKeys",
    "canonicalInviteEmail",
    "validIsoInstant",
    "boundedString",
    "record",
    "isRecord"
  ]);
  const context = invitationEvaluationContext({ value });
  runInNewContext(
    `${source}\nresult = normalizeTeamInvitationApproval(value);`,
    context
  );
  return JSON.parse(JSON.stringify(context.result));
}

function evaluateInvitationEnvelope(script, value, mode, expectedReview) {
  const source = invitationFunctionBundle(script, [
    "normalizeTeamInvitationEnvelope",
    "normalizeTeamInvitation",
    "canonicalInviteEmail",
    "safeTeamInviteUrl",
    "objectHasOnlyKeys",
    "objectHasAllKeys",
    "objectHasExactKeys",
    "validIsoInstant",
    "boundedString",
    "record",
    "isRecord"
  ]);
  const context = invitationEvaluationContext({
    value,
    mode,
    expectedReview
  });
  runInNewContext(
    `${source}\nresult = normalizeTeamInvitationEnvelope(value, mode, expectedReview);`,
    context
  );
  return JSON.parse(JSON.stringify(context.result));
}

test("console serves only its fixed application-shell allowlist", async () => {
  const expected = new Map([
    ["/hcn/", "text/html; charset=utf-8"],
    ["/hcn/sign-in.css", "text/css; charset=utf-8"],
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
  assert.match(html, /\/hcn\/manifest\.webmanifest\?shell=v14/);
  assert.match(html, /\/hcn\/app\.css\?shell=v14/);
  assert.match(html, /\/hcn\/app\.js\?shell=v14/);
  assert.match(html, /href="\/hcn\/\?shell=v14"/);
  assert.equal(manifest.start_url, "/hcn/?shell=v14");
  assert.equal(isPublicHcnConsoleAsset("/hcn/sign-in.css"), true);
  assert.equal(isPublicHcnConsoleAsset("/hcn/app.css"), false);
  assert.match(
    html,
    /rel="manifest"[^>]*crossorigin="use-credentials"/
  );

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

test("private console stays inert until an exact HCN browser session is verified", async () => {
  const [htmlAsset, scriptAsset, styleAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/app.css")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const style = styleAsset.body.toString("utf8");

  assert.match(html, /<body class="hcn-auth-locked">/);
  assert.match(html, /id="hcn-auth-gate"/);
  assert.match(html, /id="private-console"[^>]*hidden inert aria-hidden="true"/);
  assert.match(style, /\.private-console\[hidden\][\s\S]*display: none !important/);
  assert.match(script, /lockPrivateConsole\("Verifying your HCN employee session/);
  assert.match(script, /identity\.type === "hcn_browser_session"/);
  assert.match(script, /window\.addEventListener\("pagehide", handlePageHide\)/);
  assert.match(script, /window\.addEventListener\("pageshow", handlePageShow\)/);
  assert.match(script, /event\.persisted !== true/);
  assert.match(script, /if \(!document\.hidden\) revalidatePrivateConsole\(\)/);

  const lockSource = extractConsoleFunction(script, "lockPrivateConsole");
  const unlockSource = extractConsoleFunction(script, "unlockPrivateConsole");
  const attributes = new Map();
  const classes = new Set(["console-ready"]);
  const privateConsole = {
    hidden: false,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); }
  };
  const gate = { hidden: true };
  const message = { textContent: "" };
  const context = {
    elements: {
      "private-console": privateConsole,
      "hcn-auth-gate": gate,
      "hcn-auth-gate-message": message
    },
    state: {
      session: {
        authenticated: true,
        identity: {
          authentication: "authenticated",
          type: "google_oauth"
        }
      }
    },
    document: {
      body: {
        classList: {
          add(value) { classes.add(value); },
          remove(value) { classes.delete(value); }
        }
      }
    },
    record(value) {
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    },
    setText(element, value) { element.textContent = String(value); },
    result: null
  };

  runInNewContext(
    `${lockSource}\n${unlockSource}\nresult = unlockPrivateConsole();`,
    context
  );
  assert.equal(context.result, false);
  assert.equal(privateConsole.hidden, true);
  assert.equal(attributes.get("inert"), "");
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(gate.hidden, false);
  assert.equal(classes.has("hcn-auth-locked"), true);
  assert.equal(classes.has("console-ready"), false);

  context.state.session.identity.type = "hcn_browser_session";
  runInNewContext("result = unlockPrivateConsole();", context);
  assert.equal(context.result, true);
  assert.equal(privateConsole.hidden, false);
  assert.equal(attributes.has("inert"), false);
  assert.equal(attributes.get("aria-hidden"), "false");
  assert.equal(gate.hidden, true);
  assert.equal(classes.has("hcn-auth-locked"), false);
  assert.equal(classes.has("console-ready"), true);
});

test("return-to-app revalidation preserves valid work and clears it on denial", async () => {
  const scriptAsset = await readHcnConsoleAsset("/hcn/app.js");
  const script = scriptAsset.body.toString("utf8");
  const source = extractConsoleFunction(script, "revalidatePrivateConsole");

  async function runRevalidation({ session, error }) {
    const events = [];
    const context = {
      ENDPOINTS: { session: "/hcn/auth/session" },
      state: {
        loading: false,
        sessionRevalidating: false,
        leavingForLogin: false,
        session: { existing: true },
        sessionError: null
      },
      lockPrivateConsole() { events.push("lock"); },
      async fetchJson() {
        events.push("fetch");
        if (error) throw error;
        return session;
      },
      renderSession(value) { events.push(["render", value]); },
      clearOperationalData() { events.push("clear"); },
      renderSessionError(value) { events.push(["error", value]); },
      renderOverallState() { events.push("overall"); },
      syncOperationalAccess() { events.push("sync"); },
      result: null
    };
    runInNewContext(
      `${source}\nresult = revalidatePrivateConsole();`,
      context
    );
    await context.result;
    return { context, events };
  }

  const verified = {
    authenticated: true,
    identity: {
      authentication: "authenticated",
      type: "hcn_browser_session"
    }
  };
  const allowed = await runRevalidation({ session: verified });
  assert.equal(allowed.context.state.session, verified);
  assert.equal(allowed.context.state.sessionError, null);
  assert.equal(allowed.context.state.sessionRevalidating, false);
  assert.equal(allowed.events.includes("clear"), false);
  assert.deepEqual(allowed.events.slice(0, 3), [
    "lock",
    "fetch",
    ["render", verified]
  ]);

  const deniedError = { status: 401 };
  const denied = await runRevalidation({ error: deniedError });
  assert.equal(denied.context.state.session, null);
  assert.equal(denied.context.state.sessionError, deniedError);
  assert.equal(denied.events.includes("clear"), true);
  assert.equal(
    denied.events.some((event) =>
      Array.isArray(event) && event[0] === "error" && event[1] === deniedError
    ),
    true
  );
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
  for (const operation of [
    "list",
    "create",
    "detail",
    "rename",
    "archive",
    "restore"
  ]) {
    assert.match(
      source,
      new RegExp(`/hcn/api/v1/assistant/conversations/${operation}`)
    );
  }
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
  assert.match(script, /your account controls what Thresher can read/);
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
  assert.match(html, /id="assistant-prompt"[\s\S]*maxlength="4000"/);
  assert.match(html, /id="assistant-send"/);
  assert.match(html, /id="assistant-alert"[\s\S]*role="status"/);
  assert.doesNotMatch(html, /id="assistant-review-action"/);
  assert.match(
    html,
    /id="assistant-chat-sidebar"[\s\S]*aria-label="Thresher chats"/
  );
  assert.match(html, /id="assistant-new-chat"[\s\S]*>\+ New chat<\/button>/);
  assert.match(
    html,
    /id="assistant-chat-filters"[\s\S]*data-chat-filter="active"[\s\S]*data-chat-filter="file"[\s\S]*data-chat-filter="sweep"[\s\S]*data-chat-filter="general"[\s\S]*data-chat-filter="archived"/
  );
  assert.match(
    html,
    /id="assistant-conversation-list"[\s\S]*aria-label="Saved Thresher chats"[\s\S]*aria-busy="false"/
  );
  assert.match(script, /list\.setAttribute\("role", "list"\)/);
  assert.match(script, /row\.setAttribute\("role", "listitem"\)/);
  assert.match(
    html,
    /id="assistant-chat-drawer-open"[\s\S]*aria-controls="assistant-chat-sidebar"[\s\S]*aria-expanded="false"/
  );
  assert.match(html, /id="assistant-current-title"/);
  assert.match(html, /id="assistant-current-kind"/);
  assert.match(html, /id="assistant-rename-chat"/);
  assert.match(html, /id="assistant-archive-chat"/);
  assert.match(html, /id="assistant-restore-chat"/);
  assert.match(html, /<dialog id="assistant-new-dialog"/);
  assert.match(html, /<dialog id="assistant-rename-dialog"/);
  assert.match(html, /Chats are encrypted and saved inside HCN\./);
  assert.match(html, /necessary retrieved excerpts are sent[\s\S]*Groq model provider/);
  assert.match(html, /HCN makes no retention promise/);
  assert.match(html, /id="file-start-chat"/);
  assert.match(html, /id="assistant-mode"[\s\S]*<legend>Thinking mode<\/legend>/);
  assert.match(
    html,
    /id="assistant-mode-auto"[\s\S]*value="auto"[\s\S]*checked/
  );
  assert.match(html, /id="assistant-mode-deep"[\s\S]*value="deep"/);
  assert.match(html, /id="assistant-pilot"[\s\S]*Pilot check/);
  assert.match(html, /id="assistant-pilot-route"/);
  assert.match(html, /id="assistant-pilot-sources"/);
  assert.match(html, /id="assistant-pilot-authority"/);
  assert.match(html, /Model authority[\s\S]*Read only/);
  assert.match(html, /Nothing executes in chat/);
  for (const label of [
    "Review my workload",
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
    /ENDPOINTS\.assistantTurns,[\s\S]*conversationRef: conversation\.conversationRef,[\s\S]*expectedRevision: conversation\.revision,[\s\S]*prompt: prompt,[\s\S]*mode: mode/
  );
  assert.match(script, /ASSISTANT_TURN_CAPABILITY/);
  assert.match(script, /postOperationalJson\(/);
  assert.match(script, /"hcn\.console\.assistant-turn\.v4"/);
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
  assert.doesNotMatch(script, /assistantPreparedPlanCount/);
  assert.match(script, /keys\.length !== allowed\.size/);
  assert.match(script, /value\.persisted !== true/);
  assert.match(script, /value\.cachePolicy !== "no_store"/);
  assert.match(script, /!ASSISTANT_CONVERSATION_REF\.test\(value\.conversationRef\)/);
  assert.match(script, /!Number\.isSafeInteger\(value\.revision\)/);
  assert.match(script, /value\.revision < 1/);
  assert.match(script, /!ASSISTANT_MESSAGE_REF\.test\(value\.messageRef\)/);
  assert.match(script, /authority\.canPrepareActionPlans !== false/);
  assert.match(script, /authority\.canExecuteActions !== false/);
  assert.match(script, /authority\.exactHumanApprovalRequired !== true/);
  assert.match(script, /value\.plan !== null/);
  assert.match(
    script,
    /elements\["assistant-prompt"\]\.disabled = \(\s*!available \|\| runtimeStatus === "direct_only"\s*\)/
  );
  assert.match(
    script,
    /elements\["assistant-send"\]\.disabled = \(\s*!available \|\| runtimeStatus === "direct_only"\s*\)/
  );
  assert.match(script, /normalizedSpeaker === "assistant" && options\?\.busy !== true/);
  assert.match(script, /article\.append\(label, renderAssistantMarkdown\(message\)\)/);
  assert.match(script, /setText\(paragraph, boundedString\(message, 16000\)\)/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /DOMParser/);
  assert.match(script, /state\.assistantController\.abort\(\)/);
  assert.match(script, /elements\["assistant-transcript"\]\.replaceChildren\(\)/);
  assert.match(script, /elements\["assistant-mode-auto"\]\.checked = true/);
  assert.match(script, /assistant-pilot-authority"\], "Read only"/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
  assert.doesNotMatch(worker, /assistant\/turns/);
});

test("Ask Thresher renders a bounded Markdown subset without creating active content", async () => {
  const [scriptAsset, styleAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/app.css")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const style = styleAsset.body.toString("utf8");
  const rendererSource = extractConsoleFunction(script, "renderAssistantMarkdown");
  const testDocument = createTestDocument();

  function render(message) {
    const context = {
      document: testDocument,
      message,
      result: null,
      boundedString(input, maximum) {
        if (typeof input !== "string") return "";
        return Array.from(input).slice(0, maximum).join("");
      }
    };
    runInNewContext(
      `${rendererSource}\nresult = renderAssistantMarkdown(message);`,
      context
    );
    return context.result;
  }

  const rendered = render([
    "A **verified** fact and `inline code`.",
    "",
    "- First item",
    "- Keep [this link](https://example.com) literal",
    "",
    "1. First step",
    "2. Second step",
    "",
    "| Source | Status |",
    "| --- | :---: |",
    "| JobNimbus | Fresh |",
    "| <img src=x onerror=alert(1)> | ![image](https://example.com/x.png) |",
    "",
    "```js",
    "<script>alert(1)</script>",
    "```",
    "",
    "Raw <b>HTML</b> stays visible."
  ].join("\n"));

  assert.equal(rendered.className, "assistant-message-body assistant-markdown");
  assert.equal(descendantElements(rendered, "strong").length, 1);
  assert.equal(descendantElements(rendered, "ul").length, 1);
  assert.equal(descendantElements(rendered, "ol").length, 1);
  assert.equal(descendantElements(rendered, "table").length, 1);
  assert.equal(descendantElements(rendered, "pre").length, 1);
  assert.equal(descendantElements(rendered, "code").length, 2);
  assert.equal(descendantElements(rendered, "a").length, 0);
  assert.equal(descendantElements(rendered, "img").length, 0);
  assert.equal(descendantElements(rendered, "script").length, 0);
  assert.match(rendered.textContent, /\[this link\]\(https:\/\/example\.com\)/);
  assert.match(rendered.textContent, /!\[image\]\(https:\/\/example\.com\/x\.png\)/);
  assert.match(rendered.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(rendered.textContent, /Raw <b>HTML<\/b> stays visible\./);

  const headerCells = descendantElements(rendered, "th");
  assert.equal(headerCells.length, 2);
  assert.equal(headerCells.every(function (cell) {
    return cell.attributes.get("scope") === "col";
  }), true);
  const tableWrapper = descendantElements(rendered).find(function (element) {
    return element.className === "assistant-table-scroll";
  });
  assert.ok(tableWrapper);

  const malformed = render("Unclosed **bold\n```js\n<script>still text</script>");
  assert.equal(descendantElements(malformed, "strong").length, 0);
  assert.equal(descendantElements(malformed, "pre").length, 0);
  assert.equal(
    malformed.textContent,
    "Unclosed **bold\n```js\n<script>still text</script>"
  );
  assert.equal(render("x".repeat(20000)).textContent.length, 16000);

  assert.match(style, /\.assistant-table-scroll\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/m);
  assert.match(style, /\.assistant-markdown pre\s*\{[^}]*overflow-x:\s*auto;/m);
  assert.doesNotMatch(rendererSource, /innerHTML|DOMParser|insertAdjacentHTML/);
});

test("Ask Thresher keeps user and busy messages literal", async () => {
  const scriptAsset = await readHcnConsoleAsset("/hcn/app.js");
  const script = scriptAsset.body.toString("utf8");
  const appendSource = extractConsoleFunction(script, "appendAssistantMessage");
  const testDocument = createTestDocument();
  const transcript = testDocument.createElement("section");
  transcript.scrollTop = 0;
  transcript.scrollHeight = 0;
  const context = {
    document: testDocument,
    elements: { "assistant-transcript": transcript },
    ASSISTANT_MESSAGE_REF: /^msg_[a-z0-9]+$/,
    boundedString(input, maximum) {
      if (typeof input !== "string") return "";
      return Array.from(input).slice(0, maximum).join("");
    },
    setText(element, value) { element.textContent = String(value); },
    validIsoInstant() { return false; },
    renderAssistantMarkdown() {
      throw new Error("literal messages must not use the Markdown renderer");
    },
    result: null
  };

  runInNewContext(
    `${appendSource}\nresult = appendAssistantMessage("user", "**literal** <b>tag</b>", {});`,
    context
  );
  assert.equal(context.result.textContent, "You**literal** <b>tag</b>");
  assert.equal(descendantElements(context.result, "strong").length, 0);

  runInNewContext(
    'result = appendAssistantMessage("assistant", "**still literal**", { busy: true });',
    context
  );
  assert.equal(context.result.textContent, "Thresher**still literal**");
  assert.equal(descendantElements(context.result, "strong").length, 0);
});

test("Ask Thresher multi-chat history is durable through scoped server APIs only", async () => {
  const [htmlAsset, scriptAsset, workerAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/sw.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const worker = workerAsset.body.toString("utf8");
  const combined = `${html}\n${script}\n${worker}`;

  const endpointBindings = {
    assistantConversationList: "list",
    assistantConversationCreate: "create",
    assistantConversationDetail: "detail",
    assistantConversationRename: "rename",
    assistantConversationArchive: "archive",
    assistantConversationRestore: "restore"
  };
  for (const [binding, operation] of Object.entries(endpointBindings)) {
    assert.match(
      script,
      new RegExp(
        `${binding}: "/hcn/api/v1/assistant/conversations/${operation}"`
      )
    );
    assert.match(script, new RegExp(`ENDPOINTS\\.${binding}`));
  }

  assert.match(
    script,
    /const ASSISTANT_CONVERSATION_READ_CAPABILITY =\s*"hcn\.assistant\.conversations\.read"/
  );
  assert.match(
    script,
    /const ASSISTANT_CONVERSATION_MANAGE_CAPABILITY =\s*"hcn\.assistant\.conversations\.manage"/
  );
  assert.match(script, /function loadAssistantConversations\(options\)/);
  assert.match(
    script,
    /function loadAssistantConversation\(conversationRef, options\)/
  );
  assert.match(
    script,
    /const desktopFallback = window\.matchMedia\(\s*ASSISTANT_DRAWER_MEDIA_QUERY\s*\)\.matches[\s\S]*\? null[\s\S]*: list\.items\[0\];[\s\S]*\|\| desktopFallback;/
  );
  assert.match(script, /function loadOlderAssistantMessages\(\)/);
  assert.match(script, /function createAssistantConversation\(input\)/);
  assert.match(script, /function submitAssistantRename\(event\)/);
  assert.match(script, /function archiveAssistantConversation\(\)/);
  assert.match(script, /function restoreAssistantConversation\(\)/);
  assert.match(script, /function mutateAssistantConversation\(endpoint, additional, success\)/);
  assert.match(
    script,
    /ENDPOINTS\.assistantConversationList,[\s\S]*\{ state: requestedState, offset: offset, limit: 100 \}/
  );
  assert.match(
    script,
    /ENDPOINTS\.assistantConversationDetail,[\s\S]*conversationRef: conversationRef,[\s\S]*offset: messageOffset,[\s\S]*limit: 100/
  );
  assert.match(script, /detail\.conversation\.messageCount - 100/);
  assert.match(script, /page\.offset - 100/);
  assert.match(
    script,
    /state\.assistantConversationOlderController\.abort\(\);[\s\S]*state\.assistantConversationOlderLoading = false;/
  );
  assert.match(
    script,
    /state\.assistantConversationRef !== conversationRef[\s\S]*return;/
  );
  assert.match(
    script,
    /previousScrollTop[\s\S]*elements\["assistant-transcript"\]\.scrollHeight[\s\S]*previousScrollHeight/
  );
  assert.match(
    script,
    /ENDPOINTS\.assistantConversationCreate,[\s\S]*kind: input\.kind,[\s\S]*title: input\.title,[\s\S]*fileRef: input\.fileRef/
  );
  assert.match(
    script,
    /Object\.assign\(\{[\s\S]*conversationRef: conversation\.conversationRef,[\s\S]*expectedRevision: conversation\.revision[\s\S]*\}, additional\)/
  );

  assert.match(script, /"hcn\.console\.assistant-conversation-list\.v1"/);
  assert.match(script, /"hcn\.console\.assistant-conversation-detail\.v1"/);
  assert.match(script, /"hcn\.console\.assistant-conversation\.v1"/);
  assert.match(script, /"hcn\.console\.assistant-turn\.v4"/);
  assert.match(script, /value\.persisted !== true/);
  assert.match(script, /value\.cachePolicy !== "no_store"/);
  assert.match(script, /expectedRevision: conversation\.revision/);
  assert.match(script, /statusOf\(error\) === 409/);
  assert.match(script, /"Chat saved\."/);
  assert.match(script, /"Chat archived\."/);
  assert.match(script, /"Chat restored\."/);

  for (const id of [
    "assistant-chat-sidebar",
    "assistant-new-chat",
    "assistant-new-client",
    "assistant-chat-filters",
    "assistant-conversation-list",
    "assistant-conversation-load-more",
    "assistant-chat-drawer-open",
    "assistant-current-title",
    "assistant-current-kind",
    "assistant-rename-chat",
    "assistant-archive-chat",
    "assistant-restore-chat",
    "assistant-load-older",
    "assistant-new-dialog",
    "assistant-rename-dialog"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-chat-filter="active"[\s\S]*>All<\/button>/);
  assert.match(html, /data-chat-filter="file"[\s\S]*>Clients<\/button>/);
  assert.match(html, /data-chat-filter="sweep"[\s\S]*>Sweeps<\/button>/);
  assert.match(html, /data-chat-filter="general"[\s\S]*>General<\/button>/);
  assert.match(html, /data-chat-filter="archived"[\s\S]*>Archived<\/button>/);
  assert.match(html, /Chats are encrypted and saved inside HCN\./);
  assert.match(
    script,
    /const conversationContextLocked =[\s\S]*state\.assistantLoading \|\| state\.assistantClaimLoading;[\s\S]*\.assistant-conversation-select, \.assistant-conversation-more/
  );
  assert.match(
    script,
    /const responseMatchesSelectedConversation = \([\s\S]*current\.conversationRef === turn\.conversationRef[\s\S]*state\.assistantConversationRef === turn\.conversationRef[\s\S]*\);/
  );
  assert.match(
    script,
    /if \(responseMatchesSelectedConversation\) \{[\s\S]*appendAssistantMessage\("assistant", turn\.message[\s\S]*The reply was saved to its original chat/
  );
  assert.match(
    script,
    /finally \{[\s\S]*state\.assistantController === controller[\s\S]*state\.assistantLoading = false;[\s\S]*syncAssistantControls\(\);[\s\S]*syncAssistantConversationControls\(\);/
  );
  assert.match(
    script,
    /function openAssistantNewDialog\(\) \{[\s\S]*toggleAssistantDrawer\(false\);[\s\S]*\.showModal\(\)/
  );
  assert.match(
    script,
    /elements\["assistant-chat-main"\]\.toggleAttribute\("inert", open\)/
  );
  const initialize = extractConsoleFunction(script, "initialize");
  const registryStart = initialize.indexOf("[");
  const registryEnd = initialize.indexOf("].forEach(function (id)", registryStart);
  assert.notEqual(registryStart, -1, "initialize must declare its element registry");
  assert.notEqual(registryEnd, -1, "initialize must bind its element registry");
  const registeredElements = new Set(
    [...initialize.slice(registryStart, registryEnd).matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
  );
  const drawerDependencies = new Set(
    [...extractConsoleFunction(script, "syncAssistantDrawerViewport")
      .matchAll(/elements\["([^"]+)"\]/g)]
      .map((match) => match[1])
  );
  for (const dependency of drawerDependencies) {
    assert.ok(
      registeredElements.has(dependency),
      `initialize must bind drawer dependency ${dependency}`
    );
  }
  assert.match(script, /function trapAssistantDrawerFocus\(event\)/);

  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(worker, /assistant\/conversations|assistant\/turns/);
  assert.doesNotMatch(worker, /addEventListener\("fetch"/);
});

test("saved chats are persistent navigation and a full-height mobile workspace", async () => {
  const [htmlAsset, scriptAsset, styleAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/app.css")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  const style = styleAsset.body.toString("utf8");

  assert.match(
    html,
    /<span>Ask Thresher<\/span>[\s\S]*id="assistant-chats-nav"[\s\S]*<span>Chats<\/span>[\s\S]*<span>Work My Files<\/span>/
  );
  assert.match(
    html,
    /id="assistant-chats-nav"[\s\S]*aria-controls="assistant-chat-sidebar"[\s\S]*aria-expanded="false"/
  );
  assert.match(
    html,
    /id="assistant-chat-drawer-close"[\s\S]*aria-label="Close chats"/
  );
  assert.match(
    html,
    /id="assistant-chat-files-link"[\s\S]*href="#work-center"[\s\S]*>Exit<\/a>/
  );
  assert.match(
    script,
    /function openAssistantChatsNavigation\(\)[\s\S]*window\.location\.hash = "#overview";[\s\S]*toggleAssistantDrawer\(true\);[\s\S]*focusAssistantChatList\(\);/
  );
  assert.match(
    script,
    /elements\["assistant-chat-drawer-open"\]\.setAttribute\([\s\S]*"aria-expanded"[\s\S]*elements\["assistant-chats-nav"\]\.setAttribute\([\s\S]*"aria-expanded"/
  );
  assert.match(
    script,
    /loadAssistantConversation\([\s\S]*conversation\.conversationRef,[\s\S]*\{ focusComposer: true \}[\s\S]*\);/
  );
  assert.match(
    script,
    /toggleAssistantDrawer\(false, \{ restoreFocus: !focusComposer \}\);[\s\S]*elements\["assistant-prompt"\]\.focus|target\.focus\(\)/
  );
  assert.match(
    script,
    /document\.body\.toggleAttribute\("data-assistant-chat-workspace", active\)/
  );
  assert.match(
    script,
    /const wasActive = document\.body\.hasAttribute\([\s\S]*active[\s\S]*!wasActive[\s\S]*window\.matchMedia\(ASSISTANT_MOBILE_WORKSPACE_MEDIA_QUERY\)\.matches[\s\S]*document\.documentElement\.scrollTop = 0;[\s\S]*document\.body\.scrollTop = 0;[\s\S]*document\.body\.toggleAttribute\("data-assistant-chat-workspace", active\)/
  );
  assert.match(
    script,
    /function syncActiveNavigation\(\)[\s\S]*activeHash !== "#overview"[\s\S]*state\.assistantDrawerOpen[\s\S]*toggleAssistantDrawer\(false, \{ restoreFocus: false \}\)/
  );
  assert.match(
    script,
    /function clearAssistantData\(message\)[\s\S]*toggleAssistantDrawer\(false\);[\s\S]*syncAssistantMobileWorkspace\(\)/
  );
  assert.match(
    script,
    /const overviewIsCurrent = document[\s\S]*classList\.contains\("is-current-view"\)[\s\S]*selectedConversation\.conversationRef === conversation\.conversationRef[\s\S]*focus\(\{ preventScroll: true \}\)/
  );
  assert.match(
    script,
    /const generalConversation = hasConversation && conversation\.kind === "general";[\s\S]*elements\["assistant-rename-chat"\]\.hidden = generalConversation;/
  );
  assert.match(
    script,
    /function openAssistantRenameDialog\(\)[\s\S]*conversation\.kind === "general"\) return;/
  );

  assert.match(style, /width: min\(94vw, 390px\)/);
  assert.match(style, /grid-template-rows: auto auto minmax\(0, 1fr\) auto/);
  assert.match(
    extractCssRule(style, ".assistant-compose-row textarea"),
    /font-size\s*:\s*16px\s*;/
  );
  assert.doesNotMatch(html, /maximum-scale|user-scalable/i);
  assert.match(
    extractCssRule(
      style,
      'body[data-assistant-chat-workspace] .assistant-chat-files-link'
    ),
    /display\s*:\s*inline-flex\s*;[\s\S]*min-height\s*:\s*44px\s*;/
  );
  assert.match(
    style,
    /\.assistant-conversation-list \{[\s\S]*align-content: start;[\s\S]*\.assistant-conversation-group \{[\s\S]*align-content: start;[\s\S]*\.assistant-conversation-group-list \{[\s\S]*align-content: start;/
  );
  assert.match(
    style,
    /\.assistant-conversation-row \{[\s\S]*align-items: start;/
  );
  assert.match(style, /\.assistant-chat-sidebar button,[\s\S]*min-height: 44px/);
  assert.match(
    style,
    /body\[data-assistant-chat-workspace\] #overview\.assistant-view[\s\S]*height: 100vh;[\s\S]*height: 100dvh/
  );
  assert.match(
    style,
    /body\[data-assistant-chat-workspace\] \.assistant-transcript[\s\S]*min-height: 0;[\s\S]*max-height: none;[\s\S]*flex: 1 1 auto/
  );
  assert.match(
    style,
    /body\[data-assistant-chat-workspace\] \.assistant-composer[\s\S]*position: sticky;[\s\S]*env\(safe-area-inset-bottom\)/
  );
  assert.match(
    style,
    /body\[data-assistant-chat-workspace\] \.assistant-chat-files-link[\s\S]*display: inline-flex;[\s\S]*min-height: 44px/
  );
});

test("responsive console contains long text and separates compact chat navigation from the phone workspace", async () => {
  const [scriptAsset, styleAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/app.js"),
    readHcnConsoleAsset("/hcn/app.css")
  ]);
  const script = scriptAsset.body.toString("utf8");
  const style = styleAsset.body.toString("utf8");

  const chatMain = extractCssRule(style, ".assistant-chat-main");
  assert.match(chatMain, /min-width\s*:\s*0\s*;/);
  assert.match(
    chatMain,
    /grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*;/
  );
  const chatChildren = extractCssRule(style, ".assistant-chat-main > *");
  assert.match(chatChildren, /min-width\s*:\s*0\s*;/);
  assert.match(chatChildren, /max-width\s*:\s*100%\s*;/);

  for (const selector of [".assistant-message", ".assistant-message p"]) {
    const rule = extractCssRule(style, selector);
    assert.match(rule, /min-width\s*:\s*0\s*;/);
    assert.match(rule, /overflow-wrap\s*:\s*anywhere\s*;/);
    assert.match(rule, /word-break\s*:\s*break-word\s*;/);
  }
  assert.match(
    extractCssRule(style, "#assistant-composer-help"),
    /overflow-wrap\s*:\s*anywhere\s*;/
  );
  const longTextGroup = /\.assistant-alert\s*,\s*\.assistant-claim-help\s*,\s*\.assistant-conversation-empty\s*,\s*\.assistant-pilot\s*,\s*\.operations-alert\s*\{([^}]*)\}/m
    .exec(style);
  assert.ok(longTextGroup, "dynamic assistant notices must share a wrapping rule");
  assert.match(longTextGroup[1], /min-width\s*:\s*0\s*;/);
  assert.match(longTextGroup[1], /overflow-wrap\s*:\s*anywhere\s*;/);
  assert.match(longTextGroup[1], /word-break\s*:\s*break-word\s*;/);

  const medium = extractCssMediaBlocks(style, 1120).join("\n");
  const mediumGridGroup = /\.connections-grid\s*,\s*\.source-health-grid\s*,\s*\.key-facts-grid\s*,\s*\.intelligence-workflows\s*,\s*\.lane-grid\s*\{([^}]*)\}/m
    .exec(medium);
  assert.ok(
    mediumGridGroup,
    "connections and file-workflow grids must reduce before phone widths"
  );
  assert.match(
    mediumGridGroup[1],
    /grid-template-columns\s*:\s*repeat\(\s*2\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)\s*;/
  );
  assert.match(
    extractCssRule(medium, ".team-workspace"),
    /grid-template-columns\s*:\s*1fr\s*;/
  );
  const mediumHeadings = /\.card-heading\s*,\s*\.connection-card-heading\s*\{([^}]*)\}/m
    .exec(medium);
  assert.ok(mediumHeadings, "medium-width card headings must have a shared rule");
  assert.match(mediumHeadings[1], /flex-wrap\s*:\s*wrap\s*;/);
  const mediumHeadingChildren = /\.card-heading\s*>\s*\*\s*,\s*\.connection-card-heading\s*>\s*\*\s*\{([^}]*)\}/m
    .exec(medium);
  assert.ok(
    mediumHeadingChildren,
    "medium-width card-heading children must be shrinkable"
  );
  assert.match(mediumHeadingChildren[1], /min-width\s*:\s*0\s*;/);
  assert.match(mediumHeadingChildren[1], /max-width\s*:\s*100%\s*;/);

  const compact = extractCssMediaBlocks(style, 1060).join("\n");
  assert.match(
    extractCssRule(compact, ".assistant-workspace"),
    /display\s*:\s*block\s*;/
  );
  const compactSidebar = extractCssRule(compact, ".assistant-chat-sidebar");
  assert.match(compactSidebar, /position\s*:\s*fixed\s*;/);
  assert.match(
    compactSidebar,
    /width\s*:\s*min\(\s*94vw\s*,\s*390px\s*\)\s*;/
  );
  assert.match(compactSidebar, /transform\s*:\s*translateX\(\s*-105%\s*\)\s*;/);
  assert.match(
    compact,
    /body\[data-assistant-drawer="open"\]\s+\.assistant-chat-sidebar\s*\{[^}]*transform\s*:\s*translateX\(\s*0\s*\)/m
  );
  assert.match(
    compact,
    /\.assistant-chat-drawer-open\s*\{[^}]*display\s*:\s*inline-flex/m
  );
  assert.match(
    compact,
    /\.assistant-chat-drawer-close\s*\{[^}]*display\s*:\s*inline-flex/m
  );
  assert.match(
    compact,
    /body\[data-assistant-chat-workspace\]\s+\.assistant-current-actions\s*\{[^}]*display\s*:\s*flex\s*;[^}]*grid-column\s*:\s*1\s*\/\s*-1/m
  );
  assert.match(
    compact,
    /\.assistant-conversation-list\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*overflow-y\s*:\s*auto/m
  );
  assert.match(
    compact,
    /\.assistant-chat-sidebar button\s*,[\s\S]*?\.assistant-chat-filters button\s*\{[^}]*min-height\s*:\s*44px/m
  );

  const phone = extractCssMediaBlocks(style, 620).join("\n");
  const phoneWorkspace = extractCssRule(
    phone,
    "body[data-assistant-chat-workspace] #overview.assistant-view"
  );
  assert.match(phoneWorkspace, /height\s*:\s*100vh\s*;/);
  assert.match(phoneWorkspace, /height\s*:\s*100dvh\s*;/);
  assert.match(phoneWorkspace, /min-height\s*:\s*0\s*;/);
  assert.match(phoneWorkspace, /overflow\s*:\s*hidden\s*;/);
  assert.match(
    phone,
    /body\[data-assistant-chat-workspace\]\s+\.assistant-transcript\s*\{[^}]*min-height\s*:\s*0\s*;[^}]*max-height\s*:\s*none\s*;[^}]*flex\s*:\s*1\s+1\s+auto/m
  );
  assert.match(
    phone,
    /body\[data-assistant-chat-workspace\]\s+\.assistant-composer\s*\{[^}]*position\s*:\s*sticky\s*;[^}]*env\(safe-area-inset-bottom\)/m
  );
  assert.match(
    phone,
    /\.action-composer\s+\.field\s+input\s*,[\s\S]*?\.action-composer\s+\.field\s+textarea\s*\{[^}]*font-size\s*:\s*16px\s*;/m
  );

  assert.match(
    script,
    /const ASSISTANT_DRAWER_MEDIA_QUERY\s*=\s*"\(max-width: 1060px\)"\s*;/
  );
  assert.match(
    script,
    /const ASSISTANT_MOBILE_WORKSPACE_MEDIA_QUERY\s*=\s*"\(max-width: 620px\)"\s*;/
  );
  assert.match(
    extractConsoleFunction(script, "initialize"),
    /const assistantDrawerMedia = window\.matchMedia\(\s*ASSISTANT_DRAWER_MEDIA_QUERY\s*\)[\s\S]*assistantDrawerMedia\.(?:addEventListener|addListener)\(/
  );
  for (const name of [
    "openAssistantChatsNavigation",
    "toggleAssistantDrawer",
    "syncAssistantDrawerViewport"
  ]) {
    const source = extractConsoleFunction(script, name);
    assert.match(source, /window\.matchMedia\(ASSISTANT_DRAWER_MEDIA_QUERY\)/);
    assert.doesNotMatch(source, /ASSISTANT_MOBILE_WORKSPACE_MEDIA_QUERY/);
  }
  const mobileWorkspace = extractConsoleFunction(
    script,
    "syncAssistantMobileWorkspace"
  );
  assert.match(
    mobileWorkspace,
    /window\.matchMedia\(ASSISTANT_MOBILE_WORKSPACE_MEDIA_QUERY\)\.matches/
  );
  assert.doesNotMatch(mobileWorkspace, /ASSISTANT_DRAWER_MEDIA_QUERY/);

  assert.doesNotMatch(
    style,
    /(?:^|})\s*(?::root|html|body|html\s*,\s*body|body\s*,\s*html)\s*\{[^}]*\boverflow(?:-x)?\s*:\s*(?:hidden|clip)\b/m,
    "responsive containment must not hide overflow on the global root"
  );
});

test("a fresh selected Work Center summary can start an exact-file chat", async () => {
  const scriptAsset = await readHcnConsoleAsset("/hcn/app.js");
  const script = scriptAsset.body.toString("utf8");
  const start = extractConsoleFunction(script, "startSelectedFileConversation");
  const controls = extractConsoleFunction(script, "syncAssistantConversationControls");
  const selected = extractConsoleFunction(script, "selectedFreshWorkCenterFile");

  assert.match(start, /const selected = selectedFreshWorkCenterFile\(\)/);
  assert.match(start, /record\(state\.fileReview\)\.file/);
  assert.match(start, /reviewed\?\.fileRef === selected\.fileRef \? reviewed : selected/);
  assert.doesNotMatch(start, /!state\.fileReview/);
  assert.match(start, /kind: "file"[\s\S]*fileRef: state\.selectedFileRef/);
  assert.match(selected, /record\(state\.workCenter\)\.files/);
  assert.match(selected, /file\.fileRef === fileRef/);
  assert.match(controls, /navigator\.onLine[\s\S]*selectedFreshWorkCenterFile\(\)/);
  assert.doesNotMatch(
    controls,
    /elements\["file-start-chat"\]\.disabled = !\([\s\S]*&& state\.fileReview/
  );
});

test("exact-file claim filing is pilot-hidden, approval-gated, and provider-opaque", async () => {
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
    /id="assistant-claim-workflow"[\s\S]*aria-labelledby="assistant-claim-title"[\s\S]*hidden/
  );
  for (const id of [
    "assistant-claim-prepare-form",
    "assistant-claim-injuries",
    "assistant-claim-call-review",
    "assistant-claim-call-approve",
    "assistant-claim-call-execute",
    "assistant-claim-result",
    "assistant-claim-result-confirm",
    "assistant-claim-writeback-form",
    "assistant-claim-writeback-approve",
    "assistant-claim-writeback-execute"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /value="injuries_reported">Injuries reported[^<]*stop/);
  assert.doesNotMatch(html, /Injuries reported \? stop/);
  assert.match(html, /approve one carrier call/);
  assert.match(html, /actual call transcript shown above/);
  assert.doesNotMatch(html, /Carrier phone override/);
  assert.match(html, /approve this exact JobNimbus update/);

  const endpoints = [
    ["claimFilingStatus", "status"],
    ["claimFilingPrepare", "prepare"],
    ["claimFilingExecute", "execute"],
    ["claimFilingResult", "result"],
    ["claimWritebackPrepare", "writeback/prepare"],
    ["claimWritebackExecute", "writeback/execute"]
  ];
  for (const [binding, suffix] of endpoints) {
    assert.match(
      script,
      new RegExp(
        `${binding}: "/hcn/api/v1/claim-filings/${suffix.replace("/", "\\/")}"`
      )
    );
    assert.match(script, new RegExp(`ENDPOINTS\\.${binding}`));
  }

  assert.match(
    script,
    /function assistantClaimScope\(\)[\s\S]*conversation\.kind !== "file"[\s\S]*conversation\.state !== "active"[\s\S]*CLAIM_FILE_REF\.test\(fileRef\)/
  );
  assert.match(
    script,
    /ENDPOINTS\.claimFilingStatus,[\s\S]*conversationRef: scope\.conversationRef,[\s\S]*fileRef: scope\.fileRef/
  );
  assert.match(
    script,
    /state\.assistantClaimStatus\.eligible[\s\S]*assistant-claim-workflow"\]\.hidden/
  );
  assert.match(
    script,
    /assistant-claim-call-approve"\]\.checked[\s\S]*ENDPOINTS\.claimFilingExecute/
  );
  assert.match(
    script,
    /assistant-claim-result-confirm"\]\.checked[\s\S]*ENDPOINTS\.claimWritebackPrepare/
  );
  assert.match(
    script,
    /assistant-claim-writeback-approve"\]\.checked[\s\S]*ENDPOINTS\.claimWritebackExecute/
  );
  assert.match(script, /Do not retry automatically/);
  assert.match(script, /model analyzed; human confirmation required/);
  assert.match(script, /Fresh exact-field readback required: Yes/);
  assert.doesNotMatch(
    script,
    /(?:Writeback authorized|Transcript guesses|Callback requested)[^"\n]* \? /
  );
  assert.match(script, /state\.assistantClaimController\.abort\(\)/);
  assert.doesNotMatch(script, /["']\/claim-filing\//);
  assert.doesNotMatch(script, /call_id|providerCallId|retellCallId/);
  assert.doesNotMatch(worker, /claim-filings/);
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
    profileId: "hcn.thresher.groq.gpt-oss-20b.high.v1",
    reasonCodes: ["explicit_deep_review"],
    modelUsed: true
  };

  assert.deepEqual(evaluateAssistantRouting(normalize, valid), valid);
  const assignedWorkSummary = {
    route: "deterministic",
    profileId: "hcn.deterministic.v1",
    reasonCodes: ["fact_only_assigned_work_summary"],
    modelUsed: false
  };
  assert.deepEqual(
    evaluateAssistantRouting(normalize, assignedWorkSummary),
    assignedWorkSummary
  );
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
  assert.match(script, /\/hcn\/sw\.js\?shell=v14/);
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
  assert.match(html, /id="connections-profile-email"/);
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
  assert.match(
    script,
    /canonicalInviteEmail\(profile\.email\) \|\| "Email not verified"/
  );
  assert.doesNotMatch(html, /googleSubject|Google subject/i);
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
  assert.match(script, /Google account matching your HCN invitation/);
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

test("Chance-only Team uses exact invite reviews without self-signup or automatic email", async () => {
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
    /href="#team"[\s\S]*data-hcn-team-invitations[\s\S]*hidden/
  );
  assert.match(
    html,
    /id="team"[\s\S]*data-hcn-team-invitations[\s\S]*hidden/
  );
  assert.match(html, /People[\s\S]*cannot create their own account/i);
  assert.match(html, /id="team-invite-email"[\s\S]*type="email"/);
  assert.match(html, /id="team-invite-role"/);
  assert.match(html, /value="employee"/);
  assert.match(html, /value="client_coordinator"/);
  assert.match(html, /value="manager"/);
  assert.doesNotMatch(
    html.slice(
      html.indexOf('id="team-invite-role"'),
      html.indexOf("</select>", html.indexOf('id="team-invite-role"'))
    ),
    /value="administrator"/
  );
  assert.match(html, /Prepare invite/);
  assert.match(html, /Approve &amp; create invite/);
  assert.match(html, /Approve &amp; revoke/);
  assert.match(script, /Copy invite link/i);
  assert.match(html, /Google OAuth[\s\S]*test user/i);
  assert.match(html, /does[\s\S]*not create an account or send an email/i);
  assert.doesNotMatch(html, /mailto:/i);

  for (const route of [
    "/hcn/api/v1/team/invitations/list",
    "/hcn/api/v1/team/invitations/prepare",
    "/hcn/api/v1/team/invitations/create",
    "/hcn/api/v1/team/invitations/revoke"
  ]) {
    assert.match(script, new RegExp(route.replaceAll("/", "\\/")));
  }
  const teamAuthority = script.slice(
    script.indexOf("function hasTeamInvitationAuthority()"),
    script.indexOf("function hasGoogleLinkAuthority()")
  );
  assert.match(teamAuthority, /profile\.role === "chance"/);
  assert.match(teamAuthority, /teamInvitations/);
  assert.match(teamAuthority, /invitationCapabilities\.manage === true/);

  assert.match(script, /action: "create"/);
  assert.match(script, /expiresInHours: 72/);
  assert.match(script, /action: "revoke", invitationRef: invitationRef/);
  assert.match(
    script,
    /approvalId: review\.approvalId,\s*approvalDigest: review\.approvalDigest/
  );
  assert.match(script, /"hcn\.team\.invitation-approval\.v1"/);
  assert.match(script, /value\.mode !== "dry_run"/);
  assert.match(script, /match\.verified !== true/);
  assert.match(script, /match\.active !== true/);
  assert.match(script, /"assigned"/);
  const scopeLabel = script.slice(
    script.indexOf("function teamInvitationScopeLabel(role)"),
    script.indexOf("function teamInvitationStateTone(value)")
  );
  assert.match(scopeLabel, /role === "manager"/);
  assert.match(
    scopeLabel,
    /Assigned-file actions \+ company sweep visibility/
  );
  assert.match(scopeLabel, /Assigned files only/);
  assert.match(
    script,
    /\["File access", teamInvitationScopeLabel\(review\.plan\.role\)\]/
  );
  assert.match(
    script,
    /teamInvitationScopeLabel\(invitation\.role\)/
  );
  assert.match(script, /navigator\.clipboard\.writeText\(inviteUrl\)/);
  assert.match(
    script,
    /one-time invite link is no longer available[\s\S]*Revoke the pending invitation and create a new one/i
  );
  assert.doesNotMatch(
    script,
    /Refresh the invitation list and try again/i
  );
  assert.match(script, /url\.origin !== window\.location\.origin/);
  assert.match(script, /\|\| url\.search/);
  assert.match(script, /\|\| !url\.hash/);
  assert.match(script, /state\.teamInviteReview = null/);
  assert.match(script, /state\.teamRevokeReview = null/);
  assert.match(script, /clearTeamInvitationData\(message\)/);
  assert.match(script, /handleOperationalAuthLoss\(\)/);
  assert.match(script, /credentials: "same-origin"/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /"X-HCN-CSRF": csrfToken/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);

  const teamNormalizer = script.slice(
    script.indexOf("function normalizeTeamInvitation(value)"),
    script.indexOf("function canonicalInviteEmail(value)")
  );
  assert.doesNotMatch(
    teamNormalizer,
    /jobNimbusOwnerId|googleSubject|providerId/
  );
  assert.doesNotMatch(
    worker,
    /team\/invitations|addEventListener\("fetch"/
  );
});

test("Team reviews and offboarding accept only the exact material contract", async () => {
  const asset = await readHcnConsoleAsset("/hcn/app.js");
  const script = asset.body.toString("utf8");
  const approvalId = `invite_approval_${"a".repeat(32)}`;
  const approvalDigest = "b".repeat(64);
  const managerVisibility =
    "company_configured_adjuster_activity_sweep_read";
  const baseApproval = {
    schema: "hcn.team.invitation-approval.v1",
    approvalId,
    approvalDigest,
    action: "create",
    expiresAt: "2026-07-30T15:05:00.000Z"
  };
  const createReview = {
    schema: "hcn.team.invitation-approval.v1",
    mode: "dry_run",
    approval: baseApproval,
    plan: {
      action: "create",
      email: "manager@example.com",
      displayName: "HCN Manager",
      role: "manager",
      jobNimbusScope: "assigned",
      managementVisibility: managerVisibility,
      invitationExpiresAt: "2026-08-02T15:00:00.000Z",
      jobNimbusMatch: {
        verified: true,
        active: true
      }
    },
    instruction: "Review the exact invitation."
  };

  assert.equal(
    evaluateInvitationApproval(script, createReview)
      .plan.managementVisibility,
    managerVisibility
  );
  assert.throws(
    () => evaluateInvitationApproval(script, {
      ...createReview,
      plan: {
        ...createReview.plan,
        jobNimbusOwnerId: "must-not-reach-browser"
      }
    }),
    /Invalid invitation approval/
  );
  assert.throws(
    () => evaluateInvitationApproval(script, {
      ...createReview,
      plan: {
        ...createReview.plan,
        managementVisibility: "none"
      }
    }),
    /Invalid invitation approval/
  );

  const revokeReview = {
    ...createReview,
    approval: {
      ...baseApproval,
      action: "revoke"
    },
    plan: {
      action: "revoke",
      invitationRef: `invite_${"c".repeat(32)}`,
      email: "manager@example.com",
      displayName: "HCN Manager",
      role: "manager",
      jobNimbusScope: "assigned",
      managementVisibility: managerVisibility,
      currentState: "accepted",
      connectorGrant: "revoke_if_present",
      quoBinding: "revoke_if_present"
    }
  };
  const normalizedRevokeReview =
    evaluateInvitationApproval(script, revokeReview);
  assert.equal(
    normalizedRevokeReview.plan.connectorGrant,
    "revoke_if_present"
  );
  assert.equal(
    normalizedRevokeReview.plan.quoBinding,
    "revoke_if_present"
  );
  assert.throws(
    () => evaluateInvitationApproval(script, {
      ...revokeReview,
      plan: {
        ...revokeReview.plan,
        quoBinding: "retained"
      }
    }),
    /Invalid invitation approval/
  );

  const revokedInvitation = {
    invitationRef: `invite_${"c".repeat(32)}`,
    email: "manager@example.com",
    displayName: "HCN Manager",
    role: "manager",
    jobNimbusScope: "assigned",
    state: "revoked",
    invitedAt: "2026-07-29T15:00:00.000Z",
    expiresAt: "2026-08-01T15:00:00.000Z",
    acceptedAt: "2026-07-29T16:00:00.000Z",
    revokedAt: "2026-07-30T15:00:00.000Z"
  };
  const revokeResult = {
    schema: "hcn.team.invitations.v1",
    canManage: true,
    invitations: [revokedInvitation],
    legacyReviewRequiredCount: 0,
    legacyReviewRequired: [],
    delivery: {
      automaticEmail: false,
      instruction: "Copy a link only after create."
    },
    googleOAuth: {
      externalTestingPrerequisite: "Add invited accounts as test users.",
      readinessAttested: false
    },
    invitation: revokedInvitation,
    inviteUrl: "",
    emailSent: false,
    approval: {
      approvalId,
      approvalDigest,
      consumed: true
    },
    googleConnectorGrant: "cleanup_required",
    revokedSessionCount: 3,
    quoBinding: "revoked"
  };
  const normalizedResult = evaluateInvitationEnvelope(
    script,
    revokeResult,
    "revoke",
    {
      approvalId,
      approvalDigest
    }
  );
  assert.deepEqual(normalizedResult.revocationOutcome, {
    googleConnectorGrant: "cleanup_required",
    revokedSessionCount: 3,
    quoBinding: "revoked",
    cleanupRequired: true
  });
  assert.throws(
    () => evaluateInvitationEnvelope(
      script,
      { ...revokeResult, unexpectedMaterial: true },
      "revoke",
      { approvalId, approvalDigest }
    ),
    /Invalid invitation list/
  );
  assert.throws(
    () => evaluateInvitationEnvelope(
      script,
      { ...revokeResult, googleConnectorGrant: "unknown" },
      "revoke",
      { approvalId, approvalDigest }
    ),
    /Invalid invitation revocation result/
  );
  assert.throws(
    () => evaluateInvitationEnvelope(
      script,
      {
        ...revokeResult,
        legacyReviewRequiredCount: 1,
        legacyReviewRequired: [{
          status: "explicit_review_required",
          email: "must-not-be-rendered@example.com"
        }]
      },
      "revoke",
      { approvalId, approvalDigest }
    ),
    /Invalid invitation list/
  );

  const listFallback = {
    schema: revokeResult.schema,
    canManage: true,
    invitations: revokeResult.invitations,
    legacyReviewRequired: [],
    delivery: revokeResult.delivery,
    googleOAuth: revokeResult.googleOAuth
  };
  assert.equal(
    evaluateInvitationEnvelope(script, listFallback, "list", null)
      .legacyReviewCount,
    0
  );

  assert.match(script, /Google Gmail & Calendar", "Revoke connection if present"/);
  assert.match(script, /Quo work line", "Revoke binding if present"/);
  assert.match(script, /revokedSessionCount/);
  assert.match(script, /External connector cleanup is still open/);
  assert.match(script, /cleanupRequired \? "Cleanup needed" : "Revoked"/);
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
    /Google account matching your HCN invitation/
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
  assert.equal((html.match(/data-assistant-starter=/g) || []).length, 5);
  assert.equal(
    (html.match(/class="assistant-starter"\s+href="#work-center"/g) || []).length,
    1
  );
  assert.match(html, /href="#work-center"[\s\S]*>Find a file<\/a>/);
  assert.match(
    html,
    /data-assistant-starter="Show my assigned files\."[\s\S]*>Review my workload<\/button>/
  );
  assert.match(html, /data-assistant-kinds="general"/);
  assert.match(html, /data-assistant-kinds="file"/);
  assert.match(html, /data-assistant-kinds="sweep"/);
  assert.match(html, /data-assistant-starter="Show me my neglected files/);
  assert.match(html, /data-assistant-starter="Review my recent file-related communications/);
  assert.match(script, /function syncAssistantStarters\(kind, hasMessages\)/);
  assert.match(script, /allowedKinds\.includes\(normalizedKind\)/);
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
  assert.match(
    html,
    /longest verified\s+gap since a qualifying JobNimbus operational activity/
  );
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
  assert.match(
    html,
    /id="file-refresh"[\s\S]*>Update file<\/button>[\s\S]*id="file-start-chat"[\s\S]*>Ask Thresher<\/button>/
  );
  for (const [id, label] of [
    ["file-quick-note", "Add note"],
    ["file-quick-task", "Create task"],
    ["file-quick-email", "Draft email"],
    ["file-quick-text", "Text client"]
  ]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[\\s\\S]*>${label}<\\/button>`)
    );
  }
  assert.match(
    html,
    /Update file performs a fresh read across JobNimbus, Gmail, and[\s\S]*Quo\.[\s\S]*does not change anything/i
  );
  assert.match(
    html,
    /<details class="file-block file-detail"[\s\S]*Source health[\s\S]*<details class="file-block file-detail"[\s\S]*Key facts/
  );
  assert.match(
    html,
    /<summary class="file-block-heading">\s*<strong id="source-health-title">Source health<\/strong>[\s\S]*<summary class="file-block-heading">\s*<strong id="key-facts-title">Key facts<\/strong>/
  );
  assert.doesNotMatch(
    html,
    /<summary class="file-block-heading">\s*<(?:div|h4|p)\b/
  );
  assert.match(
    html,
    /id="file-actions"[\s\S]*data-hcn-capability="hcn\.action_plans\.prepare"[\s\S]*>More actions<\/button>/
  );
  assert.match(
    script,
    /elements\["file-actions"\]\.addEventListener\("click"[\s\S]*openFileActionComposer\(""\)/
  );
  const fileLoader = extractConsoleFunction(script, "loadFileReview");
  assert.match(
    fileLoader,
    /finally \{[\s\S]*state\.fileLoading = false;[\s\S]*renderActionComposerState\(\);/
  );
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

test("assistant chat UX opens the chat-type chooser and bounds display titles", async () => {
  const script = (await readHcnConsoleAsset("/hcn/app.js")).body.toString("utf8");
  assert.match(
    script,
    /function openAssistantNewDialog\(\)[\s\S]*elements\["assistant-new-form"\]\.reset\(\)[\s\S]*elements\["assistant-new-dialog"\]\.showModal\(\)/
  );
  assert.doesNotMatch(
    script,
    /function openAssistantNewDialog\(\)[\s\S]{0,700}createAssistantConversation/
  );
  assert.match(
    script,
    /function assistantConversationDisplayTitle\(value, maximum = 48\)/
  );
  assert.match(script, /assistantConversationDisplayTitle\(conversation\.title\)/);
  assert.match(script, /boundedString\(prompt, 52\)/);
});

test("file evidence hides unavailable action controls", async () => {
  const script = (await readHcnConsoleAsset("/hcn/app.js")).body.toString("utf8");
  assert.match(script, /elements\["action-form"\]\.hidden = !sessionCanPrepare/);
  assert.match(script, /Actions are read only for this session/);
});

test("management sweep labels gaps as qualifying operational activity", async () => {
  const [htmlAsset, scriptAsset] = await Promise.all([
    readHcnConsoleAsset("/hcn/"),
    readHcnConsoleAsset("/hcn/app.js")
  ]);
  const html = htmlAsset.body.toString("utf8");
  const script = scriptAsset.body.toString("utf8");
  assert.match(html, /gap since a qualifying JobNimbus operational activity/);
  assert.match(html, /Longest qualifying operational-activity gaps/);
  assert.match(script, /Last qualifying operational activity/);
  assert.doesNotMatch(script, /"Last JobNimbus touch"/);
});

test("file review today lane reason is clear", async () => {
  const script = (await readHcnConsoleAsset("/hcn/app.js")).body.toString("utf8");
  assert.match(script, /file_review_today: "Review this file today"/);
});

test("known estimating statuses are labeled as derived workflow, not provider stage", async () => {
  const script = (await readHcnConsoleAsset("/hcn/app.js")).body.toString("utf8");
  assert.match(script, /ready_for_pa_review: "Estimating workflow"/);
  assert.match(script, /"unknown", "unavailable", "stage_unavailable"/);
  assert.match(script, /workflowLabel \+ " \(from status\)"/);
  assert.match(script, /\["Stage", fileStageLabel\(file\)\]/);
});
