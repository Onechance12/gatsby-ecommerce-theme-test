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
    clean(env.OPENAI_API_KEY),
    clean(env.TWILIO_AUTH_TOKEN),
    clean(env.JOBNIMBUS_BRIDGE_TOKEN),
    clean(env.VOICE_STREAM_TOKEN)
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
