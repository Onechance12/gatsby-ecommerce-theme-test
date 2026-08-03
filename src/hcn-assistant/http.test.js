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

const ASSISTANT_RESPONSE =
  "You are signed in. I can review assigned files and recommend next steps; this chat cannot prepare or execute actions.";
const EMPLOYEE_EMAIL = "assigned.employee@wavepa.com";
const EMPLOYEE_SUBJECT = "assigned-employee-google-subject";
const EMPLOYEE_OWNER_ID = "assigned-employee-jobnimbus-owner";
const HCN_REFERENCE_KEY =
  Buffer.alloc(32, 0x41).toString("base64url");

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
        HCN_ASSISTANT_HISTORY_KEY:
          Buffer.alloc(32, 0x44).toString("base64url"),
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
        HCN_TENANT_ID: "tenant_0123456789abcdef",
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
  assert.equal(health.hcnAssistant.responsesApiStore, false);
  assert.equal(health.hcnAssistant.historyConfigured, true);
  assert.equal(health.hcnAssistant.historyReady, true);
  assert.equal(
    health.hcnAssistant.sessionHistory,
    "encrypted_principal_scoped_durable_transcript"
  );

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
        title: "Assigned work",
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
  let expectedRevision = 0;

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
  assert.equal(
    deterministicResponse.status,
    200,
    deterministicBody
  );
  const deterministic = JSON.parse(deterministicBody);
  assert.equal(
    deterministic.schema,
    "hcn.console.assistant-turn.v4"
  );
  assert.equal(deterministic.persisted, true);
  assert.equal(deterministic.conversationRef, conversationRef);
  expectedRevision = deterministic.revision;
  assert.equal(deterministic.routing.route, "deterministic");
  assert.equal(deterministic.routing.profileId, "hcn.deterministic.v1");
  assert.equal(deterministic.routing.modelUsed, false);
  assert.match(deterministic.message, /2739/);
  assert.match(deterministic.message, /Nothing was changed/);
  assert.deepEqual(
    deterministic.sources.map(({ key, status }) => ({ key, status })),
    [{ key: "jobnimbus", status: "fresh" }]
  );

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
  assert.equal(assistant.message, ASSISTANT_RESPONSE);
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
  assert.equal(assistant.routing.route, "standard");
  assert.equal(
    assistant.routing.profileId,
    "hcn.thresher.groq.gpt-oss-20b.medium.v1"
  );
  assert.deepEqual(assistant.routing.reasonCodes, [
    "general_assistance"
  ]);
  assert.equal(assistant.routing.modelUsed, true);

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
    /file chat may use only exact-file read tools/i
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
  assert.deepEqual(filteredList.page, {
    offset: 0,
    limit: 100,
    total: 1,
    hasMore: false
  });
  assignedFileActive = true;

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
        expectedRevision: 0,
        prompt:
          "fixture-calendar-day: check this file's calendar appointment.",
        mode: "auto"
      })
    }
  );
  const calendarBody = await calendarResponse.text();
  assert.equal(calendarResponse.status, 200, calendarBody);
  const calendar = JSON.parse(calendarBody);
  assert.equal(calendar.sources.length, 1);
  assert.deepEqual(
    {
      key: calendar.sources[0].key,
      label: calendar.sources[0].label,
      status: calendar.sources[0].status
    },
    {
      key: "google_calendar",
      label: "Google Calendar file appointments",
      status: "fresh"
    }
  );
  assert.match(
    calendar.sources[0].checkedAt,
    /^\d{4}-\d{2}-\d{2}T/
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
        conversationRef,
        expectedRevision,
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
  expectedRevision = catalog.revision;
  assert.equal(catalog.message, ASSISTANT_RESPONSE);
  assert.equal(catalog.plan, null);
  assert.deepEqual(
    catalog.sources.map(({ key, label, status }) => ({
      key,
      label,
      status
    })),
    [{
      key: "jobnimbus",
      label: "JobNimbus document catalog",
      status: "fresh"
    }]
  );

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
        conversationRef,
        expectedRevision,
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
  expectedRevision = deep.revision;

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
        conversationRef,
        expectedRevision,
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
  assert.equal(detail.conversation.messageCount, 10);
  assert.equal(detail.messages.length, 10);
  assert.deepEqual(
    detail.messages.map((message) => message.role),
    [
      "user", "assistant", "user", "assistant", "user",
      "assistant", "user", "assistant", "user", "assistant"
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
        title: "Assigned work follow-up",
        expectedRevision: escalation.revision
      })
    }
  );
  assert.equal(renamedResponse.status, 200);
  const renamed = await renamedResponse.json();
  assert.equal(
    renamed.conversation.title,
    "Assigned work follow-up"
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
        expectedRevision: renamed.conversation.revision
      })
    }
  );
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.conversation.state, "archived");

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
  assert.equal(providerLines.length, 6);
  const providerRequest = JSON.parse(providerLines[0]);
  assert.equal(
    providerRequest.url,
    "https://api.groq.com/openai/v1/responses"
  );
  assert.equal(providerRequest.method, "POST");
  assert.equal(providerRequest.body.model, "openai/gpt-oss-20b");
  assert.equal(providerRequest.body.reasoning.effort, "medium");
  assert.equal(providerRequest.body.max_output_tokens, 1800);
  assert.equal(Object.hasOwn(providerRequest.body, "store"), false);
  assert.equal(Object.hasOwn(providerRequest.body, "stream"), false);
  assert.equal(providerRequest.body.parallel_tool_calls, false);
  assert.equal(
    Object.hasOwn(providerRequest.body, "previous_response_id"),
    false
  );
  assert.deepEqual(
    providerRequest.body.tools.map((tool) => tool.name),
    [
      "read_work_center",
      "review_file",
      "read_file_document_catalog",
      "read_file_document",
      "read_file_photo_catalog",
      "research_file_hail_dates",
      "read_calendar_day",
      "run_management_sweep",
      "read_closed_file_benchmark"
    ]
  );
  assert.equal(
    providerRequest.body.tools.some((tool) =>
      /execute|approve/i.test(tool.name)
    ),
    false
  );
  const calendarToolRequest = JSON.parse(providerLines[1]);
  const calendarToolOutputRequest = JSON.parse(providerLines[2]);
  assert.match(
    JSON.stringify(calendarToolRequest.body.input),
    /fixture-calendar-day/
  );
  assert.match(
    JSON.stringify(calendarToolOutputRequest.body.input),
    /hcn\.assistant\.calendar-file-appointments\.v1/
  );
  assert.doesNotMatch(
    JSON.stringify(calendarToolOutputRequest),
    /Assigned File Fixture|assigned-file-provider-id|assigned-employee-connector-access-token/
  );
  const catalogToolRequest = JSON.parse(providerLines[3]);
  const catalogToolOutputRequest = JSON.parse(providerLines[4]);
  assert.match(
    JSON.stringify(catalogToolRequest.body.input),
    /fixture-document-catalog/
  );
  assert.match(
    JSON.stringify(catalogToolOutputRequest.body.input),
    /hcn\.assistant\.document-catalog\.v1/
  );
  assert.doesNotMatch(
    JSON.stringify(catalogToolOutputRequest),
    /assigned-file-provider-id|assigned-document-provider-id/
  );
  const deepProviderRequest = JSON.parse(providerLines[5]);
  assert.equal(deepProviderRequest.body.model, "openai/gpt-oss-20b");
  assert.equal(deepProviderRequest.body.reasoning.effort, "high");
  assert.equal(deepProviderRequest.body.max_output_tokens, 2400);
  const serializedProviderRequest = JSON.stringify([
    providerRequest,
    deepProviderRequest
  ]);
  assert.doesNotMatch(
    serializedProviderRequest,
    /assigned-employee-google-subject|assigned-employee-jobnimbus-owner|assigned\.employee@wavepa\.com|gsk_hcn_route_fixture_key/
  );

  assert.deepEqual(externalMutations, []);
  assert.deepEqual(
    providerObservations
      .map(({ method, pathname }) => `${method} ${pathname}`)
      .sort(),
    [
      "GET /account/users",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts",
      "GET /contacts/assigned-file-provider-id",
      "GET /contacts/assigned-file-provider-id",
      "GET /contacts/assigned-file-provider-id",
      "GET /contacts/assigned-file-provider-id",
      "GET /contacts/assigned-file-provider-id",
      "GET /files",
      "GET /tokeninfo",
      "GET /tokeninfo",
      "GET /userinfo",
      "GET /userinfo",
      "POST /token",
      "POST /token"
    ]
  );
  assert.deepEqual(
    providerObservations.filter(({ pathname }) =>
      ["/activities", "/tasks"].some(
        (prefix) =>
          pathname === prefix || pathname.startsWith(`${prefix}/`)
      )
    ),
    []
  );
  assert.deepEqual(
    providerObservations.filter(({ pathname }) => pathname === "/files"),
    [{ method: "GET", pathname: "/files" }]
  );
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

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
