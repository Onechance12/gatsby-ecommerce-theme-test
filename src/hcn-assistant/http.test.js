import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createHcnInvitationStore
} from "../auth/hcn-invitation-store.js";
import {
  createHcnAssistantFailureTelemetry
} from "./failure-telemetry.js";
import {
  createHcnAssistantConversationStore
} from "./conversation-store.js";
import {
  createHcnReferenceFactory
} from "../hcn-ops/references.js";

const ASSISTANT_RESPONSE =
  "You are signed in. I can review assigned files and recommend next steps; this chat cannot prepare or execute actions.";
const EMPLOYEE_EMAIL = "assigned.employee@wavepa.com";
const EMPLOYEE_SUBJECT = "assigned-employee-google-subject";
const EMPLOYEE_OWNER_ID = "assigned-employee-jobnimbus-owner";
const HCN_REFERENCE_KEY =
  Buffer.alloc(32, 0x41).toString("base64url");
const HCN_ASSISTANT_HISTORY_KEY =
  Buffer.alloc(32, 0x44).toString("base64url");
const HCN_TENANT_ID = "tenant_0123456789abcdef";
const GENERAL_CONVERSATION_TITLE = "Workload overview";

test("assistant failure telemetry permits only fixed safe fields and codes", () => {
  const sensitiveError = new Error(
    "Private homeowner message and provider body must not be logged."
  );
  sensitiveError.name = "PrivateHomeownerError";
  sensitiveError.code = "PRIVATE_CLIENT_CODE";
  const unknown = createHcnAssistantFailureTelemetry({
    error: sensitiveError,
    statusCode: 502,
    durationMs: 90_000
  });
  assert.deepEqual(unknown, {
    type: "hcn_assistant_turn_failed",
    errorCode: "HTTP_502",
    errorName: "Error",
    statusCode: 502,
    durationMs: 60_000,
    providerPhase: "unknown",
    replayInputBytes: 0,
    upstreamStatusCode: 0
  });
  assert.doesNotMatch(
    JSON.stringify(unknown),
    /Private homeowner|provider body|PRIVATE_CLIENT_CODE|PrivateHomeownerError/
  );

  const known = createHcnAssistantFailureTelemetry({
    error: Object.assign(new Error("Still private."), {
      name: "HcnAssistantError",
      code: "tool_execution_failed",
      providerPhase: "after_tool",
      replayInputBytes: 12_345,
      upstreamStatusCode: 413
    }),
    statusCode: 502,
    durationMs: 7
  });
  assert.deepEqual(known, {
    type: "hcn_assistant_turn_failed",
    errorCode: "tool_execution_failed",
    errorName: "HcnAssistantError",
    statusCode: 502,
    durationMs: 7,
    providerPhase: "after_tool",
    replayInputBytes: 12_345,
    upstreamStatusCode: 413
  });
});

test("enabled assistant route uses fixed routed reasoning without external mutation", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "hcn-assistant-http-")
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const providerRecordPath = path.join(
    temporaryRoot,
    "openai-requests.ndjson"
  );
  await writeFile(providerRecordPath, "", "utf8");
  const invitationTimestamp = Date.now();
  const invitationStore = createHcnInvitationStore({
    filePath: path.join(
      temporaryRoot,
      "platform",
      "employee-invitations.enc.json"
    ),
    key: HCN_REFERENCE_KEY,
    allowedDomain: "",
    now: () => invitationTimestamp
  });
  const invitation = await invitationStore.createInvitation({
    email: EMPLOYEE_EMAIL,
    displayName: "Assigned Employee",
    role: "employee",
    jobNimbusOwnerId: EMPLOYEE_OWNER_ID,
    jobNimbusScope: "assigned",
    invitedByRef: `principal_${"a".repeat(64)}`,
    expiresAt: new Date(
      invitationTimestamp + 72 * 60 * 60_000
    ).toISOString()
  });
  await invitationStore.acceptInvitation({
    invitationRef: invitation.invitationRef,
    email: EMPLOYEE_EMAIL,
    googleSubject: EMPLOYEE_SUBJECT,
    inviteToken: invitation.inviteToken
  });

  const providerObservations = [];
  const externalMutations = [];
  let assignedFileActive = true;
  const provider = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${provider.address().port}`;
    const url = new URL(req.url || "/", origin);
    providerObservations.push({
      method: req.method,
      pathname: url.pathname
    });

    if (url.pathname === "/token" && req.method === "POST") {
      const body = await readRequestBody(req);
      if (body.includes("code=assigned-employee-connector-code")) {
        return json(res, 200, {
          access_token:
            "assigned-employee-connector-access-token",
          refresh_token:
            "assigned-employee-connector-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/calendar.readonly"
          ].join(" ")
        });
      }
      return json(res, 200, {
        access_token: "assigned-employee-login-access-token",
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    if (url.pathname === "/tokeninfo" && req.method === "GET") {
      return json(res, 200, {
        audience: "hcn-assistant-employee-client",
        expires_in: 3600,
        verified_email: true,
        scope: "openid email profile"
      });
    }
    if (url.pathname === "/userinfo" && req.method === "GET") {
      return json(res, 200, {
        sub: EMPLOYEE_SUBJECT,
        email: EMPLOYEE_EMAIL,
        email_verified: true,
        hd: "wavepa.com",
        name: "Assigned Employee"
      });
    }
    if (url.pathname === "/account/users" && req.method === "GET") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-assistant-jobnimbus-key"
      );
      return json(res, 200, {
        total: 1,
        users: [
          {
            jnid: EMPLOYEE_OWNER_ID,
            email: EMPLOYEE_EMAIL,
            display_name: "Assigned Employee",
            is_active: true
          }
        ]
      });
    }
    if (url.pathname === "/contacts" && req.method === "GET") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-assistant-jobnimbus-key"
      );
      return json(res, 200, {
        contacts: [
          {
            jnid: "assigned-file-provider-id",
            number: 2739,
            record_type_name: "Insurance",
            owners: [{ id: EMPLOYEE_OWNER_ID }],
            display_name: "Assigned File Fixture",
            status_name: "Ready for Review",
            stage_name: "Carrier Review",
            is_active: assignedFileActive,
            date_updated: 1785261000
          }
        ]
      });
    }
    if (
      url.pathname === "/contacts/assigned-file-provider-id"
      && req.method === "GET"
    ) {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-assistant-jobnimbus-key"
      );
      return json(res, 200, {
        jnid: "assigned-file-provider-id",
        number: 2739,
        record_type_name: "Insurance",
        owners: [{ id: EMPLOYEE_OWNER_ID }],
        display_name: "Assigned File Fixture",
        status_name: "Ready for Review",
        stage_name: "Carrier Review",
        is_active: assignedFileActive,
        date_updated: 1785261000
      });
    }
    if (url.pathname === "/files" && req.method === "GET") {
      assert.equal(
        req.headers.authorization,
        "Bearer hcn-assistant-jobnimbus-key"
      );
      return json(res, 200, {
        files: [
          {
            jnid: "assigned-document-provider-id",
            name: "Policy declarations.pdf",
            record_type_name: "File",
            content_type: "application/pdf",
            date_created: "2026-07-01T12:00:00.000Z",
            related: { id: "assigned-file-provider-id" }
          }
        ]
      });
    }
    if (url.pathname === "/activities" && req.method === "GET") {
      return json(res, 200, { activities: [] });
    }
    if (url.pathname === "/tasks" && req.method === "GET") {
      return json(res, 200, { tasks: [] });
    }

    if (
      ["/contacts", "/activities", "/tasks", "/files"].some(
        (prefix) =>
          url.pathname === prefix
          || url.pathname.startsWith(`${prefix}/`)
      )
      && req.method !== "GET"
    ) {
      externalMutations.push({
        method: req.method,
        pathname: url.pathname
      });
      return json(res, 500, { error: "mutation must not run" });
    }

    return json(res, 404, { error: "not found" });
  });
  await listenOnLoopback(provider);
  t.after(() => closeServer(provider));
  const providerPort = provider.address().port;

  const bridgePort = await reserveLoopbackPort();
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  const bootstrapUrl = pathToFileURL(
    path.resolve(
      "src/hcn-assistant/provider-fetch-stub.test-helper.js"
    )
  ).href;
  const child = spawn(
    process.execPath,
    ["--import", bootstrapUrl, "src/server.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(bridgePort),
        PUBLIC_BASE_URL: bridgeOrigin,
        HCN_CONSOLE_ENABLED: "true",
        HCN_CONSOLE_ORIGIN: bridgeOrigin,
        HCN_THRESHER_AI_ENABLED: "true",
        HCN_THRESHER_AI_GROQ_API_KEY:
          "gsk_hcn_route_fixture_key_1234567890",
        HCN_ASSISTANT_HISTORY_KEY,
        // These legacy values must not override the fixed reasoning router.
        HCN_ASSISTANT_MODEL: "gpt-5.6-terra",
        HCN_ASSISTANT_REASONING_EFFORT: "low",
        HCN_ASSISTANT_MAX_OUTPUT_TOKENS: "1200",
        HCN_TEST_THRESHER_RECORD_PATH: providerRecordPath,
        HCN_TEST_THRESHER_RESPONSE_TEXT: ASSISTANT_RESPONSE,
        HCN_TEST_THRESHER_TOOL_PROMPT_MARKER:
          "fixture-document-catalog",
        HCN_TEST_THRESHER_CALENDAR_TOOL_PROMPT_MARKER:
          "fixture-calendar-day",
        HCN_TEST_THRESHER_NO_TOOL_PROMPT_MARKER:
          "fixture-skip-required-review",
        HCN_TENANT_ID,
        HCN_REFERENCE_KEY,
        HCN_GOOGLE_GRANT_KEY:
          Buffer.alloc(32, 0x42).toString("base64url"),
        HCN_QUO_LINK_KEY:
          Buffer.alloc(32, 0x43).toString("base64url"),
        HCN_OPERATIONS_ROOT: temporaryRoot,
        ALLOW_GOOGLE_USER_AUTH: "true",
        AUTO_ENROLL_WAVE_USERS: "false",
        GOOGLE_CLIENT_ID: "unused-legacy-google-client",
        GOOGLE_CLIENT_SECRET:
          "unused-legacy-google-secret-route-test",
        HCN_GOOGLE_CLIENT_ID: "hcn-assistant-employee-client",
        HCN_GOOGLE_CLIENT_SECRET:
          "hcn-assistant-employee-secret-route-test",
        GOOGLE_REFRESH_TOKEN: "",
        GOOGLE_TOKEN_URL:
          `http://127.0.0.1:${providerPort}/token`,
        GOOGLE_TOKENINFO_URL:
          `http://127.0.0.1:${providerPort}/tokeninfo`,
        GOOGLE_USERINFO_URL:
          `http://127.0.0.1:${providerPort}/userinfo`,
        GOOGLE_OAUTH_ALLOWED_DOMAIN: "wavepa.com",
        HCN_GOOGLE_LOGIN_ALLOWED_DOMAIN: "wavepa.com",
        OAUTH_SESSION_SECRET:
          "hcn-route-session-sealing-secret-123456789",
        GPT_OAUTH_CLIENT_SECRET: "",
        // Non-Chance employees must be admitted by an accepted invitation,
        // never by the legacy configuration roster.
        WAVE_AUTH_USERS_JSON: "[]",
        JOBNIMBUS_API_KEY: "hcn-assistant-jobnimbus-key",
        JOBNIMBUS_API_BASE_URL:
          `http://127.0.0.1:${providerPort}`,
        JOBNIMBUS_BRIDGE_TOKEN: "",
        CODEX_OPERATOR_TOKEN: "",
        OPENAI_API_KEY: "",
        RETELL_API_KEY: "",
        QUO_API_KEY: "",
        BRIDGE_ALLOW_WRITES: "false",
        HCN_ACTION_EXECUTION_ENABLED: "false",
        ALLOW_GMAIL_SEND: "false",
        ALLOW_QUO_SEND: "false",
        ALLOW_VOICE_CALLS: "false",
        ALLOW_RETELL_CALLS: "false",
        ALLOW_CLIENT_COORDINATOR_CALLS: "false",
        ALLOW_CARRIER_FOLLOWUP_CALLS: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let bridgeOutput = "";
  const captureBridgeOutput = (chunk) => {
    bridgeOutput += chunk.toString("utf8");
  };
  child.stdout.on("data", captureBridgeOutput);
  child.stderr.on("data", captureBridgeOutput);
  t.after(() => stopChild(child));
  await waitForServer(child, bridgePort);

  const healthResponse = await fetch(`${bridgeOrigin}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.hcnAssistant.enabled, true);
  assert.equal(health.hcnAssistant.configured, true);
  assert.equal(health.hcnAssistant.ready, true);
  assert.equal(health.hcnAssistant.deterministicReady, true);
  assert.equal(health.hcnAssistant.identity, "hcn.thresher-ai.v1");
  assert.equal(
    health.hcnAssistant.instructionsVersion,
    "hcn.thresher-ai.instructions.v2"
  );
  assert.equal(health.hcnAssistant.provider, "groq_responses_api");
  assert.equal(health.hcnAssistant.model, "openai/gpt-oss-20b");
  assert.equal(
    health.hcnAssistant.reasoningEffort,
    "routed_medium_or_high"
  );
  assert.equal(
    health.hcnAssistant.routing.deterministic.providerCall,
    false
  );
  assert.equal(
    health.hcnAssistant.routing.standard.reasoningEffort,
    "medium"
  );
  assert.equal(
    health.hcnAssistant.routing.deep.reasoningEffort,
    "high"
  );
  assert.equal(health.hcnAssistant.modelHasReadTools, true);
  assert.equal(health.hcnAssistant.modelCanPrepareActionPlans, false);
  assert.deepEqual(health.hcnAssistant.modelTools, [
    "read_work_center",
    "review_file",
    "read_file_document_catalog",
    "read_file_document",
    "read_file_photo_catalog",
    "research_file_hail_dates",
    "read_calendar_day",
    "run_management_sweep",
    "read_closed_file_benchmark"
  ]);
  assert.equal(
    health.hcnAssistant.modelSkills.includes(
      "claim_filing_readiness"
    ),
    true
  );
  assert.equal(health.hcnAssistant.modelCanExecute, false);
  assert.equal(health.hcnAssistant.responsesApiStore, null);
  assert.equal(
    health.hcnAssistant.providerState,
    "no_provider_conversation_ids_bounded_hcn_replay_only"
  );
  assert.equal(health.hcnAssistant.historyConfigured, true);
  assert.equal(health.hcnAssistant.historyReady, true);
  assert.equal(
    health.hcnAssistant.sessionHistory,
    "encrypted_principal_scoped_durable_transcript"
  );

  const privacyResponse = await fetch(`${bridgeOrigin}/privacy`);
  assert.equal(privacyResponse.status, 200);
  const privacyNotice = await privacyResponse.text();
  assert.match(
    privacyNotice,
    /durable, encrypted, principal-scoped HCN store/i
  );
  assert.match(privacyNotice, /bounded recent transcript replay/i);
  assert.match(
    privacyNotice,
    /prompt and the necessary allowlisted read-only evidence/i
  );
  assert.match(privacyNotice, /does not send provider conversation identifiers/i);
  assert.match(privacyNotice, /does not accept a store request field/i);
  assert.match(privacyNotice, /Data Controls and retention terms still apply/i);
  assert.doesNotMatch(privacyNotice, /explicitly (?:requests|sends) store:false/i);
  assert.doesNotMatch(privacyNotice, /session-scoped process memory/i);

  const loginResponse = await fetch(
    `${bridgeOrigin}/hcn/auth/login?returnTo=${encodeURIComponent("/hcn")}`,
    { redirect: "manual" }
  );
  assert.equal(loginResponse.status, 302);
  const loginCookie = cookieStartingWith(
    loginResponse.headers.getSetCookie(),
    "__Host-hcn_login="
  );
  const googleAuthorize = new URL(
    loginResponse.headers.get("location")
  );
  assert.equal(
    googleAuthorize.searchParams.get("client_id"),
    "hcn-assistant-employee-client"
  );

  const callbackResponse = await fetch(
    `${bridgeOrigin}/oauth/google/callback?${new URLSearchParams({
      code: "assigned-employee-google-code",
      state: googleAuthorize.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: { cookie: loginCookie }
    }
  );
  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get("location"), "/hcn");
  const sessionCookie = cookieStartingWith(
    callbackResponse.headers.getSetCookie(),
    "__Host-hcn_session="
  );

  const sessionResponse = await fetch(
    `${bridgeOrigin}/hcn/auth/session`,
    { headers: { cookie: sessionCookie } }
  );
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.identity.role, "employee");
  assert.equal(session.identity.jobNimbusScope, "assigned");
  assert.equal(
    session.authorizedCapabilities.includes("hcn.assistant.turn"),
    true
  );
  assert.equal(
    session.authorizedCapabilities.includes(
      "hcn.assistant.conversations.manage"
    ),
    true
  );

  const connectorStartResponse = await fetch(
    `${bridgeOrigin}/hcn/connect/google/start`,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(connectorStartResponse.status, 302);
  const connectorAuthorize = new URL(
    connectorStartResponse.headers.get("location")
  );
  assert.equal(
    connectorAuthorize.searchParams.get("scope").includes(
      "https://www.googleapis.com/auth/calendar.readonly"
    ),
    true
  );
  const connectorCallbackResponse = await fetch(
    `${bridgeOrigin}/oauth/google/callback?${new URLSearchParams({
      code: "assigned-employee-connector-code",
      state: connectorAuthorize.searchParams.get("state")
    })}`,
    {
      redirect: "manual",
      headers: { cookie: sessionCookie }
    }
  );
  assert.equal(connectorCallbackResponse.status, 302);
  assert.equal(
    connectorCallbackResponse.headers.get("location"),
    "/hcn/?google=connected"
  );

  const createConversationResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/create`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        kind: "general",
        title: "Assigned File Fixture / Job 2739",
        fileRef: ""
      })
    }
  );
  assert.equal(createConversationResponse.status, 200);
  const createdConversation = await createConversationResponse.json();
  assert.equal(
    createdConversation.schema,
    "hcn.console.assistant-conversation.v1"
  );
  const conversationRef =
    createdConversation.conversation.conversationRef;
  assert.equal(
    createdConversation.conversation.title,
    GENERAL_CONVERSATION_TITLE
  );
  let expectedRevision = 0;

  const assignedWorkSummaryResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision,
        prompt: "How many assigned files are ready for review right now? Give me only the count and source status. Do not open any individual file and do not take any action.",
        mode: "auto"
      })
    }
  );
  assert.equal(assignedWorkSummaryResponse.status, 200);
  const assignedWorkSummary = await assignedWorkSummaryResponse.json();
  assert.equal(assignedWorkSummary.message, [
    "Assigned files ready for review: 1.",
    "Source status: JobNimbus Fresh / Complete.",
    `Checked: ${assignedWorkSummary.sources[0].checkedAt}.`,
    "Nothing changed."
  ].join("\n"));
  assert.equal(assignedWorkSummary.routing.route, "deterministic");
  assert.equal(assignedWorkSummary.routing.modelUsed, false);
  assert.deepEqual(assignedWorkSummary.routing.reasonCodes, [
    "fact_only_assigned_work_summary"
  ]);
  assert.deepEqual(
    assignedWorkSummary.sources.map((source) => ({
      key: source.key,
      label: source.label,
      status: source.status
    })),
    [{
      key: "jobnimbus",
      label: "JobNimbus assigned files",
      status: "fresh"
    }]
  );
  assert.equal(Object.hasOwn(assignedWorkSummary, "files"), false);
  assert.doesNotMatch(
    JSON.stringify({
      message: assignedWorkSummary.message,
      sources: assignedWorkSummary.sources
    }),
    /Assigned File Fixture|2739|assigned-file-provider-id/
  );
  assert.equal((await readFile(providerRecordPath, "utf8")).trim(), "");
  expectedRevision = assignedWorkSummary.revision;

  const deterministicResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision,
        prompt: "Show my assigned Work Center.",
        mode: "auto"
      })
    }
  );
  const deterministicBody = await deterministicResponse.text();
  assert.equal(deterministicResponse.status, 200, deterministicBody);
  const deterministic = JSON.parse(deterministicBody);
  assert.match(deterministic.message, /Assigned files ready for review: 1/);
  assert.match(deterministic.message, /Open Work My Files/);
  assert.match(deterministic.message, /Client details stay out/i);
  assert.deepEqual(deterministic.routing.reasonCodes, [
    "fact_only_general_work_center_summary"
  ]);
  assert.deepEqual(
    deterministic.sources.map((source) => source.key),
    ["jobnimbus"]
  );
  assert.doesNotMatch(
    JSON.stringify(deterministic),
    /Assigned File Fixture|2739|assigned-file-provider-id/
  );
  expectedRevision = deterministic.revision;

  const assistantResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision,
        prompt: "Tell me what you can safely help with.",
        mode: "auto"
      })
    }
  );
  assert.equal(assistantResponse.status, 200);
  assert.equal(
    assistantResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const assistant = await assistantResponse.json();
  assert.equal(assistant.schema, "hcn.console.assistant-turn.v4");
  assert.match(assistant.message, /fresh assigned-work total/i);
  assert.match(assistant.message, /open Work My Files/i);
  assert.match(assistant.message, /JobNimbus, Gmail, Quo/i);
  assert.equal(assistant.plan, null);
  assert.deepEqual(assistant.sources, []);
  assert.equal(assistant.persisted, true);
  assert.equal(assistant.conversationRef, conversationRef);
  assert.match(assistant.messageRef, /^message_[a-f0-9]{32}$/);
  expectedRevision = assistant.revision;
  assert.equal(assistant.cachePolicy, "no_store");
  assert.deepEqual(assistant.authority, {
    fileScope: "signed_in_employee_assignments_only",
    liveSourcesWin: true,
    canRead: true,
    canPrepareActionPlans: false,
    canExecuteActions: false,
    exactHumanApprovalRequired: true
  });
  assert.equal(assistant.routing.route, "deterministic");
  assert.equal(
    assistant.routing.profileId,
    "hcn.deterministic.v1"
  );
  assert.deepEqual(assistant.routing.reasonCodes, [
    "fact_only_general_help"
  ]);
  assert.equal(assistant.routing.modelUsed, false);
  assert.equal((await readFile(providerRecordPath, "utf8")).trim(), "");

  const blockedGeneralClientResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision,
        prompt:
          "Review Assigned File Fixture at 123 Main Street, JobNimbus file 2739.",
        mode: "auto"
      })
    }
  );
  assert.equal(blockedGeneralClientResponse.status, 403);
  assert.match(
    (await blockedGeneralClientResponse.json()).error,
    /choose the exact assigned client/i
  );
  assert.equal((await readFile(providerRecordPath, "utf8")).trim(), "");

  // Simulate history written by the pre-hardening build. Public projections
  // and replay must hide both the unsafe title and the unsafe message pair.
  const referenceFactory = createHcnReferenceFactory({
    hmacKey: Buffer.from(HCN_REFERENCE_KEY, "base64url"),
    tenantId: HCN_TENANT_ID
  });
  const subjectRef = referenceFactory.subjectId(
    "hcn_operator",
    `google:${EMPLOYEE_SUBJECT}`
  );
  const principalRef = `principal_${subjectRef.slice("subject_".length)}`;
  const legacyStore = createHcnAssistantConversationStore({
    filePath: path.join(
      temporaryRoot,
      "platform",
      "assistant-conversations.enc.json"
    ),
    encryptionKey: HCN_ASSISTANT_HISTORY_KEY
  });
  const legacyRename = await legacyStore.rename({
    principalRef,
    conversationRef,
    title: "Assigned File Fixture / Job 2739",
    expectedRevision
  });
  expectedRevision = legacyRename.revision;
  const legacyTurn = await legacyStore.appendTurn({
    principalRef,
    conversationRef,
    expectedRevision,
    prompt: "Legacy unsafe prompt for Assigned File Fixture at 123 Main Street, JobNimbus 2739.",
    message: "Legacy unsafe response for assigned-file-provider-id.",
    mode: "auto",
    routing: {
      route: "deterministic",
      profileId: "hcn.deterministic.v1",
      reasonCodes: ["fact_only_work_center"],
      modelUsed: false
    },
    sources: []
  });
  expectedRevision = legacyTurn.conversation.revision;

  const workCenterResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/work-center`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({ offset: 0, limit: 1 })
    }
  );
  assert.equal(workCenterResponse.status, 200);
  const workCenter = await workCenterResponse.json();
  const fileRef = workCenter.files[0].fileRef;
  assert.match(fileRef, /^subject_[a-f0-9]{32}$/);

  const createFileConversationResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/create`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        kind: "file",
        title: "Assigned file",
        fileRef
      })
    }
  );
  assert.equal(createFileConversationResponse.status, 200);
  const fileConversation = await createFileConversationResponse.json();
  const fileConversationRef =
    fileConversation.conversation.conversationRef;
  let fileExpectedRevision = 0;
  const postFileAssistantTurn = ({
    prompt,
    expectedRevision: revision = fileExpectedRevision
  }) => fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: revision,
        prompt,
        mode: "auto"
      })
    }
  );

  const reopenFileConversationResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/create`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        kind: "file",
        title: "A duplicate title must not create another client chat",
        fileRef
      })
    }
  );
  assert.equal(reopenFileConversationResponse.status, 200);
  assert.equal(
    (await reopenFileConversationResponse.json()).conversation.conversationRef,
    fileConversationRef
  );

  const crossFileToolResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: 0,
        prompt: "Show my assigned Work Center.",
        mode: "auto"
      })
    }
  );
  assert.equal(crossFileToolResponse.status, 403);
  assert.match(
    (await crossFileToolResponse.json()).error,
    /available only from general Thresher chat/i
  );

  assignedFileActive = false;
  const filteredListResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/list`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({ state: "active", offset: 0, limit: 100 })
    }
  );
  assert.equal(filteredListResponse.status, 200);
  const filteredList = await filteredListResponse.json();
  assert.deepEqual(
    filteredList.items.map((conversation) => conversation.conversationRef),
    [conversationRef]
  );
  assert.equal(
    filteredList.items[0].title,
    GENERAL_CONVERSATION_TITLE
  );
  assert.deepEqual(filteredList.page, {
    offset: 0,
    limit: 100,
    total: 1,
    hasMore: false
  });

  const reassignedGeneralDetailResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/detail`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        offset: 0,
        limit: 100
      })
    }
  );
  assert.equal(reassignedGeneralDetailResponse.status, 200);
  const reassignedGeneralDetail = await reassignedGeneralDetailResponse.json();
  assert.equal(
    reassignedGeneralDetail.conversation.title,
    GENERAL_CONVERSATION_TITLE
  );
  assert.equal(reassignedGeneralDetail.messages.length, 6);
  assert.doesNotMatch(
    JSON.stringify(reassignedGeneralDetail.messages),
    /Assigned File Fixture|123 Main Street|2739|assigned-file-provider-id/
  );

  const providerLinesBeforeReassignment = (
    await readFile(providerRecordPath, "utf8")
  ).trim().split(/\r?\n/).filter(Boolean).length;
  const reassignedTurnResponse = await postFileAssistantTurn({
    prompt:
      "Review the latest available evidence for this exact file and tell me what needs attention. Do not take any action.",
    expectedRevision: 0
  });
  assert.equal(reassignedTurnResponse.status, 404);
  assert.equal(
    (await readFile(providerRecordPath, "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).length,
    providerLinesBeforeReassignment
  );
  assignedFileActive = true;

  const ordinaryFilePrompts = [
    "Review the latest available evidence for this exact file and tell me what needs attention. Do not take any action.",
    "What is the current status of this exact file? Use fresh JobNimbus evidence only and do not take any action."
  ];
  for (const prompt of ordinaryFilePrompts) {
    const response = await postFileAssistantTurn({ prompt });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const turn = JSON.parse(responseText);
    assert.equal(turn.message, ASSISTANT_RESPONSE);
    assert.equal(turn.routing.route, "standard");
    assert.equal(turn.routing.modelUsed, true);
    assert.equal(turn.plan, null);
    const jobNimbusSource = turn.sources.find(
      (source) => source.key === "jobnimbus"
    );
    assert.deepEqual(
      {
        label: jobNimbusSource?.label,
        status: jobNimbusSource?.status
      },
      {
        label: "JobNimbus file",
        status: "fresh"
      }
    );
    fileExpectedRevision = turn.revision;
  }

  const sensitiveFailurePrompt =
    "fixture-skip-required-review: PRIVATE_PROMPT_MARKER summarize this exact file without the required evidence.";
  const failureLogOffset = bridgeOutput.length;
  const noReviewResponse = await postFileAssistantTurn({
    prompt: sensitiveFailurePrompt
  });
  const noReviewBody = await noReviewResponse.text();
  assert.equal(noReviewResponse.status, 502, noReviewBody);
  const noReviewError = JSON.parse(noReviewBody).error;
  assert.match(
    noReviewError,
    /assistant provider returned/i
  );
  await waitForOutput(
    () => bridgeOutput.slice(failureLogOffset),
    '"type":"hcn_assistant_turn_failed"'
  );
  const failureOutput = bridgeOutput.slice(failureLogOffset);
  const failureLogs = failureOutput
    .split(/\r?\n/)
    .filter((line) => line.includes('"type":"hcn_assistant_turn_failed"'))
    .map((line) => JSON.parse(line));
  assert.equal(failureLogs.length, 1);
  assert.deepEqual(
    Object.keys(failureLogs[0]).sort(),
    [
      "durationMs",
      "errorCode",
      "errorName",
      "providerPhase",
      "replayInputBytes",
      "statusCode",
      "type",
      "upstreamStatusCode"
    ]
  );
  assert.equal(
    failureLogs[0].errorCode,
    "malformed_provider_output"
  );
  assert.equal(failureLogs[0].errorName, "HcnAssistantError");
  assert.equal(failureLogs[0].statusCode, 502);
  assert.equal(Number.isSafeInteger(failureLogs[0].durationMs), true);
  assert.equal(failureLogs[0].durationMs >= 0, true);
  assert.equal(failureLogs[0].durationMs <= 60_000, true);
  assert.equal(failureLogs[0].providerPhase, "unknown");
  assert.equal(failureLogs[0].replayInputBytes, 0);
  assert.equal(failureLogs[0].upstreamStatusCode, 0);
  assert.doesNotMatch(
    JSON.stringify(failureLogs[0]),
    /PRIVATE_PROMPT_MARKER|assistant provider returned|subject_|conversation_/
  );
  assert.equal(
    JSON.stringify(failureLogs[0]).includes(noReviewError),
    false
  );

  const calendarResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: fileExpectedRevision,
        prompt:
          "fixture-calendar-day: check this file's calendar appointment.",
        mode: "auto"
      })
    }
  );
  const calendarBody = await calendarResponse.text();
  assert.equal(calendarResponse.status, 200, calendarBody);
  const calendar = JSON.parse(calendarBody);
  fileExpectedRevision = calendar.revision;
  const calendarSource = calendar.sources.find(
    (source) => source.key === "google_calendar"
  );
  assert.deepEqual(
    {
      key: calendarSource?.key,
      label: calendarSource?.label,
      status: calendarSource?.status
    },
    {
      key: "google_calendar",
      label: "Google Calendar file appointments",
      status: "fresh"
    }
  );
  assert.match(
    calendarSource?.checkedAt || "",
    /^\d{4}-\d{2}-\d{2}T/
  );

  const blockedGeneralCatalogResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision,
        prompt:
          `fixture-document-catalog: review documents for ${fileRef}`,
        mode: "auto"
      })
    }
  );
  const blockedGeneralCatalogBody =
    await blockedGeneralCatalogResponse.text();
  assert.equal(
    blockedGeneralCatalogResponse.status,
    403,
    blockedGeneralCatalogBody
  );
  assert.match(
    JSON.parse(blockedGeneralCatalogBody).error,
    /choose the exact assigned client/i
  );

  const catalogResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: fileExpectedRevision,
        prompt:
          `fixture-document-catalog: review documents for ${fileRef}`,
        mode: "auto"
      })
    }
  );
  const catalogBody = await catalogResponse.text();
  assert.equal(
    catalogResponse.status,
    200,
    `${catalogBody}\n${JSON.stringify(providerObservations)}`
  );
  const catalog = JSON.parse(catalogBody);
  fileExpectedRevision = catalog.revision;
  assert.equal(catalog.message, ASSISTANT_RESPONSE);
  assert.equal(catalog.plan, null);
  const catalogJobNimbusSource = catalog.sources.find(
    (source) => source.key === "jobnimbus"
  );
  assert.deepEqual(
    {
      key: catalogJobNimbusSource?.key,
      label: catalogJobNimbusSource?.label,
      status: catalogJobNimbusSource?.status
    },
    {
      key: "jobnimbus",
      label: "JobNimbus document catalog",
      status: "fresh"
    }
  );

  assignedFileActive = false;
  const reassignedDetailResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/detail`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        offset: 0,
        limit: 100
      })
    }
  );
  assert.equal(reassignedDetailResponse.status, 404);
  assignedFileActive = true;

  const deepResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: fileExpectedRevision,
        prompt: "Review the claim evidence carefully.",
        mode: "deep"
      })
    }
  );
  assert.equal(deepResponse.status, 200);
  const deep = await deepResponse.json();
  assert.equal(deep.schema, "hcn.console.assistant-turn.v4");
  assert.equal(deep.routing.route, "deep");
  assert.equal(
    deep.routing.profileId,
    "hcn.thresher.groq.gpt-oss-20b.high.v1"
  );
  assert.equal(deep.routing.modelUsed, true);
  fileExpectedRevision = deep.revision;

  const escalationResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/turns`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef: fileConversationRef,
        expectedRevision: fileExpectedRevision,
        prompt: "Call the homeowner right now.",
        mode: "auto"
      })
    }
  );
  assert.equal(escalationResponse.status, 200);
  const escalation = await escalationResponse.json();
  assert.equal(escalation.routing.route, "codex_escalation");
  assert.equal(escalation.routing.modelUsed, false);
  assert.match(escalation.message, /Nothing was changed, sent, called/);

  const detailResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/detail`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        offset: 0,
        limit: 100
      })
    }
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(
    detail.schema,
    "hcn.console.assistant-conversation-detail.v1"
  );
  assert.equal(detail.conversation.messageCount, 6);
  assert.equal(detail.messages.length, 6);
  assert.equal(
    detail.messages[0].content,
    "How many assigned files are ready for review right now? Give me only the count and source status. Do not open any individual file and do not take any action."
  );
  assert.equal(detail.messages[1].content, assignedWorkSummary.message);
  assert.doesNotMatch(
    JSON.stringify(
      detail.messages.map((message) => message.content)
    ),
    /Assigned File Fixture|123 Main Street|2739|assigned-file-provider-id/
  );
  assert.deepEqual(
    detail.messages.map((message) => message.role),
    [
      "user", "assistant", "user", "assistant",
      "user", "assistant"
    ]
  );

  const renamedResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/rename`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        title: "Assigned File Fixture / Job 2739",
        expectedRevision
      })
    }
  );
  assert.equal(renamedResponse.status, 403);
  assert.match(
    (await renamedResponse.json()).error,
    /fixed privacy-safe title/i
  );

  const archivedResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/archive`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision
      })
    }
  );
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.conversation.state, "archived");
  assert.equal(archived.conversation.title, GENERAL_CONVERSATION_TITLE);

  const archivedListResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/list`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        state: "archived",
        offset: 0,
        limit: 100
      })
    }
  );
  assert.equal(archivedListResponse.status, 200);
  const archivedList = await archivedListResponse.json();
  assert.deepEqual(
    archivedList.items.map((conversation) => conversation.conversationRef),
    [conversationRef]
  );
  assert.equal(archivedList.items[0].title, GENERAL_CONVERSATION_TITLE);

  const restoredResponse = await fetch(
    `${bridgeOrigin}/hcn/api/v1/assistant/conversations/restore`,
    {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: bridgeOrigin,
        "x-hcn-csrf": session.browserSession.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        conversationRef,
        expectedRevision: archived.conversation.revision
      })
    }
  );
  assert.equal(restoredResponse.status, 200);
  assert.equal(
    (await restoredResponse.json()).conversation.state,
    "active"
  );

  const providerLines = (
    await readFile(providerRecordPath, "utf8")
  ).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(providerLines.length, 8);
  const providerRequests = providerLines.map((line) => JSON.parse(line));
  const serializedInput = (request) => JSON.stringify(request.body.input);
  const latestUserMessage = (request) => [
    ...(Array.isArray(request.body.input) ? request.body.input : [])
  ].reverse().find(
    (item) => item?.role === "user" && typeof item?.content === "string"
  )?.content || "";
  const requestsForPrompt = (prompt) => providerRequests.filter(
    (request) => latestUserMessage(request).includes(prompt)
  );
  assert.deepEqual(
    requestsForPrompt("Tell me what you can safely help with."),
    []
  );
  assert.deepEqual(requestsForPrompt("Assigned File Fixture"), []);

  const requiredReviewRequests = providerRequests.filter(
    (request) => request.body.tool_choice === "required"
  );
  assert.equal(requiredReviewRequests.length, 0);
  for (const prompt of ordinaryFilePrompts) {
    const rounds = requestsForPrompt(prompt);
    assert.equal(rounds.length, 1);
    assert.equal(Object.hasOwn(rounds[0].body, "tool_choice"), false);
    assert.equal(Object.hasOwn(rounds[0].body, "tools"), false);
    assert.match(serializedInput(rounds[0]), /hcn\.console\.file\.v1/);
    const reviewEvidence = rounds[0].body.input.find(
      (item) =>
        item?.role === "user"
        && item?.content?.startsWith("Server-fetched read-only HCN evidence")
    );
    assert.ok(reviewEvidence);
    assert.ok(
      Buffer.byteLength(reviewEvidence.content, "utf8") <= 24 * 1024
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(rounds[0].body), "utf8")
        <= 20 * 1024,
      `ordinary exact-file provider request is ${Buffer.byteLength(
        JSON.stringify(rounds[0].body),
        "utf8"
      )} bytes`
    );
    assert.equal(
      reviewEvidence.content.includes('"thresher"'),
      false
    );
  }

  const noReviewRounds = requestsForPrompt(
    "fixture-skip-required-review"
  );
  assert.equal(noReviewRounds.length, 1);
  assert.equal(Object.hasOwn(noReviewRounds[0].body, "tool_choice"), false);

  const calendarRounds = requestsForPrompt("fixture-calendar-day");
  assert.equal(calendarRounds.length, 2);
  for (const request of calendarRounds) {
    assert.equal(request.body.tool_choice, "auto");
    assert.deepEqual(
      request.body.tools.map((tool) => tool.name),
      ["read_calendar_day"]
    );
  }
  assert.match(serializedInput(calendarRounds[0]), /hcn\.console\.file\.v1/);
  assert.match(
    serializedInput(calendarRounds[1]),
    /hcn\.assistant\.calendar-file-appointments\.v1/
  );

  const catalogRounds = requestsForPrompt("fixture-document-catalog");
  assert.equal(catalogRounds.length, 2);
  const fileCatalogRounds = catalogRounds.filter(
    (request) => Array.isArray(request.body.tools)
      && request.body.tools.some(
        (tool) => tool.name === "read_file_document_catalog"
      )
  );
  assert.equal(fileCatalogRounds.length, 2);
  for (const request of fileCatalogRounds) {
    assert.equal(request.body.tool_choice, "auto");
    assert.deepEqual(
      request.body.tools.map((tool) => tool.name),
      ["read_file_document_catalog", "read_file_document"]
    );
  }
  assert.match(
    serializedInput(fileCatalogRounds[0]),
    /hcn\.console\.file\.v1/
  );
  assert.match(
    serializedInput(fileCatalogRounds[1]),
    /hcn\.assistant\.document-catalog\.v1/
  );

  for (const request of providerRequests) {
    assert.equal(Object.hasOwn(request.body, "store"), false);
    assert.equal(Object.hasOwn(request.body, "stream"), false);
    assert.equal(request.body.parallel_tool_calls, false);
    assert.equal(
      Object.hasOwn(request.body, "previous_response_id"),
      false
    );
    assert.equal(
      (request.body.tools || []).some((tool) =>
        /execute|approve/i.test(tool.name)
      ),
      false
    );
  }

  const deepProviderRequest = requestsForPrompt(
    "Review the claim evidence carefully."
  )[0];
  assert.equal(deepProviderRequest.body.model, "openai/gpt-oss-20b");
  assert.equal(deepProviderRequest.body.reasoning.effort, "high");
  assert.equal(deepProviderRequest.body.max_output_tokens, 2400);
  const serializedProviderRequest = JSON.stringify(providerRequests);
  assert.doesNotMatch(
    serializedProviderRequest,
    /assigned-file-provider-id|assigned-document-provider-id|assigned-employee-google-subject|assigned-employee-jobnimbus-owner|assigned\.employee@wavepa\.com|assigned-employee-connector-access-token|gsk_hcn_route_fixture_key/
  );

  assert.deepEqual(externalMutations, []);
  const allowedProviderReads = new Set([
    "/account/users",
    "/contacts",
    "/contacts/assigned-file-provider-id",
    "/activities",
    "/tasks",
    "/files",
    "/tokeninfo",
    "/userinfo"
  ]);
  for (const observation of providerObservations) {
    if (observation.pathname === "/token") {
      assert.equal(observation.method, "POST");
      continue;
    }
    assert.equal(observation.method, "GET");
    assert.equal(allowedProviderReads.has(observation.pathname), true);
  }
  for (const pathname of ["/activities", "/tasks", "/files"]) {
    const reads = providerObservations.filter(
      (observation) => observation.pathname === pathname
    );
    assert.equal(reads.length >= 4, true);
    assert.equal(reads.every(({ method }) => method === "GET"), true);
  }
});

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function reserveLoopbackPort() {
  const server = createServer();
  await listenOnLoopback(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function cookieStartingWith(setCookies, prefix) {
  const value = setCookies.find((cookie) => cookie.startsWith(prefix));
  assert.ok(value, `Missing cookie ${prefix}`);
  return value.split(";", 1)[0];
}

async function waitForServer(child, port) {
  let output = "";
  const capture = (chunk) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before test: ${output}`);
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`
      );
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server: ${output}`);
}

async function waitForOutput(readOutput, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (readOutput().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for server output: ${expected}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
