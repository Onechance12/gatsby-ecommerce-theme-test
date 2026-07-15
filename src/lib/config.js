import fs from "node:fs";
import path from "node:path";

export function loadConfig() {
  const projectRoot = process.cwd();
  loadEnvFile(path.join(projectRoot, ".env"));

  const env = process.env;
  const apiKey = clean(env.JOBNIMBUS_API_KEY);
  const dataDir = path.join(projectRoot, "data");

  const secrets = [
    apiKey,
    clean(env.QUO_API_KEY),
    clean(env.GOOGLE_CLIENT_SECRET),
    clean(env.GOOGLE_REFRESH_TOKEN),
    clean(env.OPENAI_API_KEY),
    clean(env.TWILIO_AUTH_TOKEN),
    clean(env.JOBNIMBUS_BRIDGE_TOKEN),
    clean(env.VOICE_STREAM_TOKEN),
    clean(env.RETELL_API_KEY)
  ].filter(Boolean);

  return {
    projectRoot,
    useFixtures: truthy(env.JOBNIMBUS_USE_FIXTURES),
    apiBaseUrl: clean(env.JOBNIMBUS_API_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    authScheme: clean(env.JOBNIMBUS_AUTH_SCHEME) || "Bearer",
    actor: clean(env.JOBNIMBUS_ACTOR),
    pageSize: intOr(env.JOBNIMBUS_PAGE_SIZE, 1000),
    maxOffset: intOr(env.JOBNIMBUS_MAX_OFFSET, 100000),
    resultWindowLimit: intOr(env.JOBNIMBUS_RESULT_WINDOW_LIMIT, 10000),
    staleDays: intOr(env.JOBNIMBUS_STALE_DAYS, 7),
    highPriorityStaleDays: intOr(env.JOBNIMBUS_HIGH_PRIORITY_STALE_DAYS, 14),
    reviewScope: clean(env.REVIEW_SCOPE) || "auto",
    allowJobNimbusWrites: truthy(env.ALLOW_JOBNIMBUS_WRITES),
    endpoints: {
      contacts: clean(env.JOBNIMBUS_CONTACTS_ENDPOINT) || "/contacts",
      jobs: clean(env.JOBNIMBUS_JOBS_ENDPOINT) || "/jobs",
      tasks: clean(env.JOBNIMBUS_TASKS_ENDPOINT) || "/tasks",
      activities: clean(env.JOBNIMBUS_ACTIVITIES_ENDPOINT) || "/activities",
      documents: clean(env.JOBNIMBUS_DOCUMENTS_ENDPOINT) || "/files",
      payments: clean(env.JOBNIMBUS_PAYMENTS_ENDPOINT) || "/payments"
    },
    metadataEndpoints: {
      accountSettings: clean(env.JOBNIMBUS_ACCOUNT_SETTINGS_ENDPOINT) || "/account/settings",
      accountUsers: clean(env.JOBNIMBUS_ACCOUNT_USERS_ENDPOINT) || "/account/users"
    },
    paths: {
      dataDir,
      rawDir: path.join(dataDir, "raw"),
      normalizedDir: path.join(dataDir, "normalized"),
      reportsDir: path.join(projectRoot, "reports"),
      workDir: path.join(projectRoot, "work"),
      fixture: clean(env.JOBNIMBUS_FIXTURE_PATH) || path.join(projectRoot, "fixtures", "sample-data.json")
    },
    quo: {
      apiKey: clean(env.QUO_API_KEY),
      baseUrl: clean(env.QUO_API_BASE_URL).replace(/\/+$/, "") || "https://api.openphone.com/v1",
      allowSend: truthy(env.ALLOW_QUO_SEND)
    },
    google: {
      clientId: clean(env.GOOGLE_CLIENT_ID),
      clientSecret: clean(env.GOOGLE_CLIENT_SECRET),
      refreshToken: clean(env.GOOGLE_REFRESH_TOKEN),
      allowSend: truthy(env.ALLOW_GMAIL_SEND)
    },
    openai: {
      apiKey: clean(env.OPENAI_API_KEY),
      realtimeModel: clean(env.OPENAI_REALTIME_MODEL) || "gpt-realtime",
      voice: clean(env.OPENAI_VOICE) || "marin"
    },
    twilio: {
      accountSid: clean(env.TWILIO_ACCOUNT_SID),
      authToken: clean(env.TWILIO_AUTH_TOKEN),
      fromNumber: clean(env.TWILIO_FROM_NUMBER),
      verifiedTestNumber: clean(env.TWILIO_VERIFIED_TEST_NUMBER),
      statusCallbackUrl: clean(env.TWILIO_STATUS_CALLBACK_URL),
      mediaStreamUrl: clean(env.TWILIO_MEDIA_STREAM_URL),
      allowVoiceCalls: truthy(env.ALLOW_VOICE_CALLS)
    },
    voice: {
      serverPort: intOr(env.VOICE_SERVER_PORT, 8787),
      publicBaseUrl: clean(env.VOICE_PUBLIC_BASE_URL),
      streamToken: clean(env.VOICE_STREAM_TOKEN)
    },
    bridge: {
      port: intOr(env.PORT, 8788),
      token: clean(env.JOBNIMBUS_BRIDGE_TOKEN),
      allowWrites: truthy(env.BRIDGE_ALLOW_WRITES)
    },
    retell: {
      // Retell AI (retellai.com) - outbound carrier IVR calling with a real press_digit
      // DTMF tool, separate from the conversational LLM. See src/voice/retell.js.
      apiKey: clean(env.RETELL_API_KEY),
      agentId: clean(env.RETELL_AGENT_ID),
      llmId: clean(env.RETELL_LLM_ID),
      voiceId: clean(env.RETELL_VOICE_ID),
      fromNumber: clean(env.RETELL_FROM_NUMBER),
      terminationUri: clean(env.RETELL_TERMINATION_URI),
      // Calls stay dry-run unless this is true AND the command passes execute:true.
      // Chance's Retell account is on the FREE TRIAL - keep this false by default.
      allowRetellCalls: truthy(env.ALLOW_RETELL_CALLS)
    },
    redact(text) {
      let output = String(text ?? "");
      for (const secret of secrets) {
        if (secret) output = output.split(secret).join("[redacted]");
      }
      return output;
    }
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function truthy(value) {
  return /^(true|1|yes|on)$/i.test(String(value || "").trim());
}

function clean(value) {
  return String(value || "").trim();
}

function intOr(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
