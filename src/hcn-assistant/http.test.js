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

const ASSISTANT_RESPONSE =
  "You are signed in. I can review assigned files and prepare actions for approval; nothing was changed.";
const EMPLOYEE_EMAIL = "assigned.employee@wavepa.com";
const EMPLOYEE_SUBJECT = "assigned-employee-google-subject";
const EMPLOYEE_OWNER_ID = "assigned-employee-jobnimbus-owner";

test("enabled assistant route serves an assigned employee without model execution or external mutation", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "hcn-assistant-http-")
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const providerRecordPath = path.join(
    temporaryRoot,
    "openai-requests.ndjson"
  );
  await writeFile(providerRecordPath, "", "utf8");

  const providerObservations = [];
  const externalMutations = [];
  const provider = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${provider.address().port}`;
    const url = new URL(req.url || "/", origin);
    providerObservations.push({
      method: req.method,
      pathname: url.pathname
    });

    if (url.pathname === "/token" && req.method === "POST") {
      await readRequestBody(req);
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
        HCN_ASSISTANT_ENABLED: "true",
        HCN_ASSISTANT_OPENAI_API_KEY:
          "sk-hcn-route-fixture-key-1234567890",
        HCN_ASSISTANT_MODEL: "gpt-5.6-terra",
        HCN_ASSISTANT_REASONING_EFFORT: "low",
        HCN_ASSISTANT_MAX_OUTPUT_TOKENS: "1200",
        HCN_TEST_OPENAI_RECORD_PATH: providerRecordPath,
        HCN_TEST_OPENAI_RESPONSE_TEXT: ASSISTANT_RESPONSE,
        HCN_TENANT_ID: "tenant_0123456789abcdef",
        HCN_REFERENCE_KEY:
          Buffer.alloc(32, 0x41).toString("base64url"),
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
        WAVE_AUTH_USERS_JSON: JSON.stringify([
          {
            email: EMPLOYEE_EMAIL,
            name: "Assigned Employee",
            role: "employee",
            enabled: true,
            googleSubject: EMPLOYEE_SUBJECT,
            jobNimbusOwnerId: EMPLOYEE_OWNER_ID,
            jobNimbusScope: "assigned"
          }
        ]),
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
  assert.equal(health.hcnAssistant.modelHasReadTools, true);
  assert.equal(health.hcnAssistant.modelCanPrepareActionPlans, true);
  assert.equal(health.hcnAssistant.modelCanExecute, false);
  assert.equal(health.hcnAssistant.responsesApiStore, false);

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
        prompt: "Tell me what you can safely help with."
      })
    }
  );
  assert.equal(assistantResponse.status, 200);
  assert.equal(
    assistantResponse.headers.get("cache-control"),
    "no-store, max-age=0"
  );
  const assistant = await assistantResponse.json();
  assert.equal(assistant.schema, "hcn.console.assistant-turn.v1");
  assert.equal(assistant.message, ASSISTANT_RESPONSE);
  assert.equal(assistant.plan, null);
  assert.deepEqual(assistant.sources, []);
  assert.equal(assistant.ephemeral, true);
  assert.equal(assistant.cachePolicy, "no_store");
  assert.deepEqual(assistant.authority, {
    fileScope: "signed_in_employee_assignments_only",
    liveSourcesWin: true,
    canRead: true,
    canPrepareActionPlans: true,
    canExecuteActions: false,
    exactHumanApprovalRequired: true
  });

  const providerLines = (
    await readFile(providerRecordPath, "utf8")
  ).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(providerLines.length, 1);
  const providerRequest = JSON.parse(providerLines[0]);
  assert.equal(
    providerRequest.url,
    "https://api.openai.com/v1/responses"
  );
  assert.equal(providerRequest.method, "POST");
  assert.equal(providerRequest.body.model, "gpt-5.6-terra");
  assert.equal(providerRequest.body.store, false);
  assert.equal(providerRequest.body.stream, false);
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
      "run_management_sweep",
      "prepare_action_plan"
    ]
  );
  assert.equal(
    providerRequest.body.tools.some((tool) =>
      /execute|approve/i.test(tool.name)
    ),
    false
  );
  const serializedProviderRequest = JSON.stringify(providerRequest);
  assert.doesNotMatch(
    serializedProviderRequest,
    /assigned-employee-google-subject|assigned-employee-jobnimbus-owner|assigned\.employee@wavepa\.com|hcn-route-fixture-key/
  );

  assert.deepEqual(externalMutations, []);
  assert.deepEqual(
    providerObservations
      .map(({ method, pathname }) => `${method} ${pathname}`)
      .sort(),
    [
      "GET /account/users",
      "GET /tokeninfo",
      "GET /userinfo",
      "POST /token"
    ]
  );
  assert.deepEqual(
    providerObservations.filter(({ pathname }) =>
      ["/contacts", "/activities", "/tasks", "/files"].some(
        (prefix) =>
          pathname === prefix || pathname.startsWith(`${prefix}/`)
      )
    ),
    []
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
