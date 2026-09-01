import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import {
  analyzeClaimCall,
  assertApprovalDigest,
  buildClaimFilingPlan,
  buildPostClaimWorkflow,
  buildCallbackDynamicVariables,
  buildCallbackMetadata,
  callbackDynamicVariablesDigest,
  digest,
  retellCallBody,
  callbackCandidateFromCall,
  selectCallbackCandidate,
  validateRetellCallChainOwnership
} from "./claim-filing-adapter.js";
import { renderBrain } from "./memory/brain.js";
import { safeCloseoutAction } from "./memory/actionCloseout.js";
import { latestActionReceipts, listMemory } from "./memory/store.js";
import { readFileSnapshot, refreshFileSnapshot, summarizeFileSnapshot } from "./memory/fileSnapshot.js";
import {
  createOperationalAdvisory,
  operationalState,
  reconcileOperationalState
} from "./memory/operationalBrain.js";
import {
  createOpenAiOperationalProvider,
  createZaiOperationalProvider,
  ZAI_OPERATIONAL_MODEL as DEFAULT_ZAI_OPERATIONAL_MODEL
} from "./memory/operationalAdvisoryProvider.js";
import {
  listQuoNumbers,
  readQuoHistory,
  readQuoHistoryStrict,
  readQuoInbox,
  readQuoTranscript,
  sendQuoText
} from "./quo/client.js";
import { buildRetellLlmFromPacket, postCallAnalysisSchema } from "./claim-filing-core/retellPrompt.js";
import { evaluateGuardedEndCall } from "./claim-filing-core/endCallGuard.js";
import { extractCallResults } from "./claim-filing-core/resultExtraction.js";
import { evaluateClaimCallResource } from "./claim-filing-core/resourceLock.js";
import {
  buildClientCoordinatorAgentSettings,
  buildClientCoordinatorConversation,
  buildClientCoordinatorLlmConfig,
  clientCoordinatorAnalysisSchema,
  extractClientCoordinatorResult
} from "./client-coordinator/agent.js";
import {
  CARRIER_DESTINATION_TYPES,
  CARRIER_FOLLOW_UP_GOALS,
  buildCarrierFollowUpAgentSettings,
  buildCarrierFollowUpConversation,
  buildCarrierFollowUpLlmConfig,
  carrierFollowUpAnalysisSchema,
  extractCarrierFollowUpResult
} from "./carrier-follow-up/agent.js";
import {
  appointmentFitsAvailability,
  availabilityRange,
  buildUnifiedAvailability,
  busyIntervalsFromJobNimbusTasks
} from "./scheduling/availability.js";
import { researchPropertyHailDates } from "./weather/dolResearch.js";
import { canonicalizeContactFieldAliases } from "./jobnimbus/contact-fields.js";
import { createLorPdf } from "./documents/lor.js";
import { buildPhotoCandidateCatalog, createPhotoReviewPdf, isPhotoMetadata } from "./documents/photo-review.js";
import { localDateKey, selectTodaysInspectionTasks } from "./operations/inspection-discovery.js";
import { buildCommunicationRecoveryQueue } from "./operations/communication-recovery.js";
import {
  CHANCE_OPERATOR_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS,
  CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS,
  chanceManifestFileBinding,
  chanceOperatorRunManifestSummary,
  loadChanceOperatorRunManifest,
  resolveChanceOperatorRunPolicy,
  validateThresherTransition
} from "./operations/thresher-policy.js";
import {
  authenticateGoogleAccessToken,
  hcnConsoleChanceUserConfigured,
  hcnConsoleSessionMatchesApprovedUser,
  parseWaveUsers,
  publicIdentity,
  routeAllowed
} from "./auth/google-user.js";
import {
  createHcnConsoleOAuthCoordinator
} from "./auth/hcn-console-auth.js";
import { hcnLoginSourceFromRequest } from "./auth/hcn-console-client-source.js";
import {
  HCN_LOGIN_COOKIE_NAME,
  HCN_SESSION_COOKIE_NAME,
  clearHcnLoginCookie,
  clearHcnSessionCookie,
  hcnNoStoreSecurityHeaders,
  readHcnCookie,
  validateExactHcnOrigin
} from "./auth/hcn-console-http.js";
import { createHcnConsoleLoginAdmission } from "./auth/hcn-console-login-admission.js";
import { createHcnConsoleSessionStore } from "./auth/hcn-console-session-store.js";
import {
  createHcnConsoleStateCodec,
  isHcnConsoleStateEnvelope
} from "./auth/hcn-console-state-codec.js";
import {
  fetchBoundedProviderJson,
  resolveGoogleProviderEndpoint
} from "./auth/google-provider-http.js";
import { assertStrongOAuthSessionSecret } from "./auth/oauth-secret.js";
import { buildPlatformMeta, buildPlatformSession } from "./platform/metadata.js";
import { readReleaseGates } from "./platform/release-gates.js";
import {
  HCN_CONSOLE_SECURITY_HEADERS,
  readHcnConsoleAsset
} from "./console/static.js";
import {
  createHcnConsoleFreshReadService
} from "./hcn-console/fresh-read.js";
import {
  loadHcnConsoleReferenceConfiguration,
  projectHcnReferenceConfigurationReadiness
} from "./hcn-console/reference-config.js";
import {
  createHcnReadAdmissionController
} from "./hcn-console/read-admission.js";
import {
  HCN_BROWSER_ACTION_TYPES,
  HcnBrowserActionContractError,
  projectHcnBrowserActionDryRun,
  translateHcnBrowserActionsToPrivateEngineRequest,
  validateHcnBrowserActionDetailInput,
  validateHcnBrowserActionExecuteInput,
  validateHcnBrowserActionInvalidateInput,
  validateHcnBrowserActionListInput,
  validateHcnBrowserActionPrepareInput
} from "./hcn-actions/browser-contracts.js";
import {
  createHcnPendingActionPlanStore
} from "./hcn-actions/pending-plans.js";
import {
  createHcnActionReceiptIndex
} from "./hcn-actions/receipt-index.js";
import {
  mapJobNimbusFileEnvelope,
  mapJobNimbusIndexEnvelope,
  mapScopedGmailEnvelope,
  mapScopedQuoEnvelope
} from "./hcn-console/provider-mappers.js";
import { fetchBoundedJson } from "./http/bounded-json.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const RELEASE_GATES = readReleaseGates(process.env);
const API_BASE = stripTrailingSlash(process.env.JOBNIMBUS_API_BASE_URL || "https://app.jobnimbus.com/api1");
const JOBNIMBUS_FILE_BASE_URL = stripTrailingSlash(process.env.JOBNIMBUS_FILE_BASE_URL || "https://app.jobnimbus.com/files");
const API_KEY = process.env.JOBNIMBUS_API_KEY || "";
const BRIDGE_TOKEN = process.env.JOBNIMBUS_BRIDGE_TOKEN || "";
const CODEX_OPERATOR_TOKEN = process.env.CODEX_OPERATOR_TOKEN || "";
const CODEX_MAC_OPERATOR_TOKEN = process.env.CODEX_MAC_OPERATOR_TOKEN || "";
const RETELL_GUARDED_END_CALL_TOKEN = process.env.RETELL_GUARDED_END_CALL_TOKEN || "";
const RETELL_INBOUND_WEBHOOK_TOKEN = process.env.RETELL_INBOUND_WEBHOOK_TOKEN || "";
const ALLOW_WRITES = RELEASE_GATES.BRIDGE_ALLOW_WRITES;
const HCN_ACTION_EXECUTION_ENABLED =
  RELEASE_GATES.HCN_ACTION_EXECUTION_ENABLED;
const PUBLIC_BASE_URL = stripTrailingSlash(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://jobnimbus-chatgpt-bridge.onrender.com");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS = process.env.NODE_ENV === "test";
const GOOGLE_TOKEN_URL = resolveGoogleProviderEndpoint(
  "token",
  process.env.GOOGLE_TOKEN_URL,
  { allowLoopbackForTests: ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS }
);
const GOOGLE_TOKENINFO_URL = resolveGoogleProviderEndpoint(
  "tokenInfo",
  process.env.GOOGLE_TOKENINFO_URL,
  { allowLoopbackForTests: ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS }
);
const GOOGLE_USERINFO_URL = resolveGoogleProviderEndpoint(
  "userInfo",
  process.env.GOOGLE_USERINFO_URL,
  { allowLoopbackForTests: ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS }
);
const GOOGLE_OAUTH_ALLOWED_DOMAIN = process.env.GOOGLE_OAUTH_ALLOWED_DOMAIN || "wavepa.com";
const ALLOW_GOOGLE_USER_AUTH = process.env.ALLOW_GOOGLE_USER_AUTH === "true";
const AUTO_ENROLL_WAVE_USERS = process.env.AUTO_ENROLL_WAVE_USERS === "true";
const GPT_OAUTH_CLIENT_ID = process.env.GPT_OAUTH_CLIENT_ID || "wave-jobnimbus-gpt";
const GPT_OAUTH_CLIENT_SECRET = process.env.GPT_OAUTH_CLIENT_SECRET || "";
const OAUTH_SESSION_SECRET = assertStrongOAuthSessionSecret(
  process.env.OAUTH_SESSION_SECRET || "",
  { required: false }
);
const HCN_CONSOLE_ENABLED = process.env.HCN_CONSOLE_ENABLED === "true";
const HCN_CONSOLE_ORIGIN = resolveHcnConsoleOrigin(
  process.env.HCN_CONSOLE_ORIGIN || PUBLIC_BASE_URL
);
const HCN_REFERENCE_CONFIGURATION =
  loadHcnConsoleReferenceConfiguration(process.env);
const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly"
];
const CHANCE_GOOGLE_EMAIL = String(
  process.env.CHANCE_GOOGLE_EMAIL || "cpearson@wavepa.com"
).trim().toLowerCase();
const WAVE_AUTH_USERS = parseWaveUsers(process.env.WAVE_AUTH_USERS_JSON, [{
  email: CHANCE_GOOGLE_EMAIL,
  name: "Chance Pearson",
  role: "chance",
  googleSubject: process.env.CHANCE_GOOGLE_SUBJECT || "",
  jobNimbusOwnerId: process.env.CHANCE_JOBNIMBUS_OWNER_ID || "fc95a213f70e4c9daddc5fa366be9941",
  jobNimbusScope: "assigned"
}]);
const GMAIL_API_BASE_URL = stripTrailingSlash(process.env.GMAIL_API_BASE_URL || "https://gmail.googleapis.com");
const GMAIL_USER = process.env.GMAIL_USER || "me";
const STANDARD_W9_GMAIL_MESSAGE_ID = String(process.env.STANDARD_W9_GMAIL_MESSAGE_ID || "").trim();
const STANDARD_W9_GMAIL_ATTACHMENT_ID = String(process.env.STANDARD_W9_GMAIL_ATTACHMENT_ID || "").trim();
const STANDARD_W9_SHA256 = String(process.env.STANDARD_W9_SHA256 || "").trim().toLowerCase();
const ALLOW_GMAIL_SEND = RELEASE_GATES.ALLOW_GMAIL_SEND;
const PERSISTENT_DATA_ROOT = process.env.MEMORY_ROOT || tmpdir();
const BRIDGE_DATA_DIR = path.join(PERSISTENT_DATA_ROOT, "bridge");
const HANDOFF_STORE_PATH = process.env.HANDOFF_STORE_PATH || path.join(BRIDGE_DATA_DIR, "handoffs.json");
const HANDOFF_UPLOAD_DIR = process.env.HANDOFF_UPLOAD_DIR || path.join(BRIDGE_DATA_DIR, "handoff-uploads");
const ARTIFACT_STORE_PATH = process.env.ARTIFACT_STORE_PATH || path.join(BRIDGE_DATA_DIR, "artifacts.json");
const ARTIFACT_UPLOAD_DIR = process.env.ARTIFACT_UPLOAD_DIR || path.join(BRIDGE_DATA_DIR, "artifact-uploads");
const ARTIFACT_FILE_DIR = process.env.ARTIFACT_FILE_DIR || path.join(BRIDGE_DATA_DIR, "artifacts");
const MAX_ARTIFACT_BYTES = positiveIntegerEnv("MAX_ARTIFACT_BYTES", 5 * 1024 * 1024);
const MAX_CHATGPT_FILE_BYTES = Math.min(positiveIntegerEnv("MAX_CHATGPT_FILE_BYTES", 8 * 1024 * 1024), 10 * 1024 * 1024);
const ARTIFACT_TTL_HOURS = Math.max(1, Math.min(positiveIntegerEnv("ARTIFACT_TTL_HOURS", 72), 168));
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 12 * 1024 * 1024);
const HCN_CONSOLE_API_BODY_BYTES = 4 * 1024;
const HCN_ACTION_PREPARE_BODY_BYTES = 64 * 1024;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const OPENAI_OPERATIONAL_MODEL = process.env.OPENAI_OPERATIONAL_MODEL || "gpt-5.6-luna";
const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
const ZAI_OPERATIONAL_MODEL = process.env.ZAI_OPERATIONAL_MODEL || DEFAULT_ZAI_OPERATIONAL_MODEL;
const OPERATIONAL_LLM_PROVIDER = String(process.env.OPERATIONAL_LLM_PROVIDER || "zai").trim().toLowerCase();
const OPERATIONAL_LLM_FALLBACK_PROVIDER = String(process.env.OPERATIONAL_LLM_FALLBACK_PROVIDER || "").trim().toLowerCase();
const OPENAI_VOICE = process.env.OPENAI_VOICE || "marin";
const VOICE_PUBLIC_BASE_URL = stripTrailingSlash(process.env.VOICE_PUBLIC_BASE_URL || PUBLIC_BASE_URL);
const VOICE_STREAM_TOKEN = process.env.VOICE_STREAM_TOKEN || BRIDGE_TOKEN || "";
const VOICE_STREAM_PATH = "/voice/twilio-stream";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_API_BASE_URL = stripTrailingSlash(process.env.TWILIO_API_BASE_URL || "https://api.twilio.com");
const QUO_VERIFICATION_FROM_NUMBER = process.env.QUO_VERIFICATION_FROM_NUMBER || TWILIO_FROM_NUMBER;
const TWILIO_STATUS_CALLBACK_URL = process.env.TWILIO_STATUS_CALLBACK_URL || "";
const TWILIO_VERIFIED_TEST_NUMBER = process.env.TWILIO_VERIFIED_TEST_NUMBER || "";
const ALLOW_VOICE_CALLS = RELEASE_GATES.ALLOW_VOICE_CALLS;
const RETELL_API_BASE_URL = stripTrailingSlash(process.env.RETELL_API_BASE_URL || "https://api.retellai.com");
const RETELL_API_KEY = process.env.RETELL_API_KEY || "";
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID || "";
const RETELL_HOMEOWNER_AGENT_ID = process.env.RETELL_HOMEOWNER_AGENT_ID || "agent_83d18f8328f04e88ba2d5dcdd9";
const RETELL_CLIENT_COORDINATOR_AGENT_ID = process.env.RETELL_CLIENT_COORDINATOR_AGENT_ID || RETELL_HOMEOWNER_AGENT_ID;
const RETELL_CARRIER_FOLLOWUP_AGENT_ID = process.env.RETELL_CARRIER_FOLLOWUP_AGENT_ID || "agent_66fb8a49fc6ab5a777eb9f0474";
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || TWILIO_FROM_NUMBER || "";
const ALLOW_RETELL_CALLS = RELEASE_GATES.ALLOW_RETELL_CALLS;
const ALLOW_RETELL_CLAIM_CALLS = RELEASE_GATES.ALLOW_RETELL_CLAIM_CALLS;
const ALLOW_CLIENT_COORDINATOR_CALLS = RELEASE_GATES.ALLOW_CLIENT_COORDINATOR_CALLS;
const ALLOW_CARRIER_FOLLOWUP_CALLS = RELEASE_GATES.ALLOW_CARRIER_FOLLOWUP_CALLS;
const CHANCE_OWNER_ID = process.env.CHANCE_JOBNIMBUS_OWNER_ID || "fc95a213f70e4c9daddc5fa366be9941";
const CLAIM_CALL_STORE_PATH = process.env.CLAIM_CALL_STORE_PATH || path.join(BRIDGE_DATA_DIR, "claim-call-ledger.json");
const ACTION_BATCH_STORE_PATH = process.env.ACTION_BATCH_STORE_PATH || path.join(BRIDGE_DATA_DIR, "action-batches.json");
const ACTION_APPROVAL_STORE_PATH = process.env.ACTION_APPROVAL_STORE_PATH || path.join(BRIDGE_DATA_DIR, "action-approvals.json");
const BRIDGE_BOOT_ID = randomUUID();
const HCN_ACTION_RECEIPT_STORE_PATH = process.env.HCN_ACTION_RECEIPT_STORE_PATH || path.join(BRIDGE_DATA_DIR, "hcn-action-receipts.json");
const ACTION_APPROVAL_TTL_SECONDS = Math.max(1, Math.min(positiveIntegerEnv("ACTION_APPROVAL_TTL_SECONDS", 900), 3600));
const CLAIM_CALL_APPROVAL_TTL_SECONDS = Math.max(
  1,
  Math.min(positiveIntegerEnv("CLAIM_CALL_APPROVAL_TTL_SECONDS", 900), 3600)
);
const ACTION_BATCH_LEDGER_TEST_FAIL_AT = process.env.NODE_ENV === "test"
  ? Number(process.env.ACTION_BATCH_LEDGER_TEST_FAIL_AT || 0)
  : 0;
const REQUIRE_CHANCE_RUN_POLICY = process.env.REQUIRE_CHANCE_RUN_POLICY === "true"
  || (
    process.env.REQUIRE_CHANCE_RUN_POLICY !== "false"
    && process.env.NODE_ENV !== "test"
  );
const CHANCE_OPERATOR_RUN_MANIFEST_STATE = initializeChanceOperatorRunManifest();
const CHANCE_OPERATOR_RUN_MANIFEST = CHANCE_OPERATOR_RUN_MANIFEST_STATE.manifest;
const CODEX_MAC_ASSIGNED_BATCH_MAX_FILES = 5;
const CODEX_MAC_ASSIGNED_MULTI_FILE_ACTION_TYPES = new Set([
  "jobnimbus.update_contact",
  "jobnimbus.update_status",
  "jobnimbus.ensure_current_task"
]);
const CHANCE_OPERATOR_EXCLUDED_FILES = new Set(CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS);
const CURRENT_CONTROL_TASK_MARKER = "[HCN_CURRENT_CONTROL_V1]";
const OUTBOUND_SEND_STORE_PATH = process.env.OUTBOUND_SEND_STORE_PATH || path.join(BRIDGE_DATA_DIR, "outbound-sends.json");
const QUO_LINE_LINK_STORE_PATH = process.env.QUO_LINE_LINK_STORE_PATH || path.join(BRIDGE_DATA_DIR, "quo-line-links.json");
const QUO_LINE_CHALLENGE_STORE_PATH = process.env.QUO_LINE_CHALLENGE_STORE_PATH || path.join(BRIDGE_DATA_DIR, "quo-line-challenges.json");
const AUTO_ENROLLED_USER_STORE_PATH = process.env.AUTO_ENROLLED_USER_STORE_PATH || path.join(BRIDGE_DATA_DIR, "auto-enrolled-users.json");
const QUO_API_KEY = process.env.QUO_API_KEY || "";
const QUO_API_BASE_URL = stripTrailingSlash(process.env.QUO_API_BASE_URL || "https://api.quo.com/v1");
const QUO_DEFAULT_FROM_NUMBER = process.env.QUO_DEFAULT_FROM_NUMBER || "";
const ALLOW_QUO_SEND = RELEASE_GATES.ALLOW_QUO_SEND;
const ALLOW_LEGACY_CLIENT_MEMORY_WRITES = RELEASE_GATES.ALLOW_LEGACY_CLIENT_MEMORY_WRITES;
const CHANCE_OPERATOR_LEGACY_ISOLATION_ID = "chance-58-prelock-receipts-v1";
const CHANCE_OPERATOR_LEGACY_ISOLATION_STATE = initializeChanceOperatorLegacyIsolation();
const RETELL_CALLBACK_TTL_HOURS = Math.max(1, Math.min(positiveIntegerEnv("RETELL_CALLBACK_TTL_HOURS", 72), 168));
const OPENAI_INPUT_TRANSCRIPTION_MODEL = process.env.OPENAI_INPUT_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const OPERATIONS_TIME_ZONE = "America/Chicago";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const SCHEDULING_HORIZON_DAYS = positiveIntegerEnv("SCHEDULING_HORIZON_DAYS", 21);
const SCHEDULING_APPOINTMENT_MINUTES = positiveIntegerEnv("SCHEDULING_APPOINTMENT_MINUTES", 120);
const SCHEDULING_TRAVEL_BUFFER_MINUTES = nonNegativeIntegerEnv("SCHEDULING_TRAVEL_BUFFER_MINUTES", 60);
const SCHEDULING_MIN_LEAD_HOURS = nonNegativeIntegerEnv("SCHEDULING_MIN_LEAD_HOURS", 24);
const SCHEDULING_WORKDAY_START = process.env.SCHEDULING_WORKDAY_START || "08:00";
const SCHEDULING_WORKDAY_END = process.env.SCHEDULING_WORKDAY_END || "18:00";
const CENSUS_GEOCODER_URL = process.env.CENSUS_GEOCODER_URL || "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const HAIL_REPORTS_URL = process.env.HAIL_REPORTS_URL || "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/lsr.py";

function initializeChanceOperatorRunManifest() {
  const raw = String(process.env.CHANCE_OPERATOR_RUN_MANIFEST_JSON || "").trim();
  if (!raw) {
    return {
      manifest: null,
      error: REQUIRE_CHANCE_RUN_POLICY
        ? "CHANCE_OPERATOR_RUN_MANIFEST_JSON is not configured."
        : ""
    };
  }
  try {
    return { manifest: loadChanceOperatorRunManifest(raw), error: "" };
  } catch (error) {
    return { manifest: null, error: String(error?.message || error) };
  }
}

function initializeChanceOperatorLegacyIsolation() {
  const raw = String(process.env.CHANCE_OPERATOR_LEGACY_ISOLATION_JSON || "").trim();
  if (!raw) return { config: null, error: "" };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Legacy isolation must be one JSON object.");
    }
    const allowedTopLevel = new Set([
      "schemaVersion",
      "id",
      "runPolicyId",
      "runPolicySha256",
      "entries"
    ]);
    if (Object.keys(parsed).some((key) => !allowedTopLevel.has(key))) {
      throw new Error("Legacy isolation contains an unsupported top-level field.");
    }
    if (Number(parsed.schemaVersion) !== 1) {
      throw new Error("Legacy isolation schemaVersion must be 1.");
    }
    if (String(parsed.id || "") !== CHANCE_OPERATOR_LEGACY_ISOLATION_ID) {
      throw new Error(`Legacy isolation id must be ${CHANCE_OPERATOR_LEGACY_ISOLATION_ID}.`);
    }
    const runPolicyId = String(parsed.runPolicyId || "").trim();
    const runPolicySha256 = String(parsed.runPolicySha256 || "").trim().toLowerCase();
    if (!runPolicyId || !/^[a-f0-9]{64}$/.test(runPolicySha256)) {
      throw new Error("Legacy isolation must pin one run-policy id and SHA-256.");
    }
    if (!Array.isArray(parsed.entries) || parsed.entries.length !== 6) {
      throw new Error("Legacy isolation must contain exactly six receipt fingerprints.");
    }
    const seen = new Set();
    const entries = parsed.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Every legacy isolation entry must be an object.");
      }
      const allowedEntryFields = new Set([
        "batchId",
        "rawRowSha256",
        "expectedStatus",
        "operationCount",
        "completedCount"
      ]);
      if (Object.keys(entry).some((key) => !allowedEntryFields.has(key))) {
        throw new Error("A legacy isolation entry contains an unsupported field.");
      }
      const batchId = String(entry.batchId || "").trim();
      const rawRowSha256 = String(entry.rawRowSha256 || "").trim().toLowerCase();
      const expectedStatus = String(entry.expectedStatus || "").trim();
      const operationCount = Number(entry.operationCount);
      const completedCount = Number(entry.completedCount);
      if (!/^[a-f0-9-]{36}$/.test(batchId) || seen.has(batchId)) {
        throw new Error("Legacy isolation batch IDs must be unique UUIDs.");
      }
      if (!/^[a-f0-9]{64}$/.test(rawRowSha256)) {
        throw new Error("Legacy isolation rawRowSha256 values must be lowercase SHA-256 digests.");
      }
      if (!["partial_failure", "completed_pending_verification"].includes(expectedStatus)) {
        throw new Error("Legacy isolation status is unsupported.");
      }
      if (
        !Number.isSafeInteger(operationCount)
        || operationCount < 1
        || operationCount > 15
        || !Number.isSafeInteger(completedCount)
        || completedCount < 0
        || completedCount > operationCount
      ) {
        throw new Error("Legacy isolation operation counts are invalid.");
      }
      seen.add(batchId);
      return Object.freeze({
        batchId,
        rawRowSha256,
        expectedStatus,
        operationCount,
        completedCount
      });
    });
    const partialFailures = entries.filter((entry) => (
      entry.expectedStatus === "partial_failure"
      && entry.completedCount === 0
    ));
    const pending = entries.filter((entry) => (
      entry.expectedStatus === "completed_pending_verification"
      && entry.operationCount === 1
      && entry.completedCount === 1
    ));
    if (partialFailures.length !== 5 || pending.length !== 1) {
      throw new Error("Legacy isolation must bind five empty partial failures and one one-operation pending-verification receipt.");
    }
    return {
      config: Object.freeze({
        schemaVersion: 1,
        id: CHANCE_OPERATOR_LEGACY_ISOLATION_ID,
        runPolicyId,
        runPolicySha256,
        entries: Object.freeze(entries)
      }),
      error: ""
    };
  } catch (error) {
    return { config: null, error: String(error?.message || error) };
  }
}
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const voiceCallLogs = new Map();
const claimScopeTextCache = new Map();
const MEMORY_CONFIG = {
  projectRoot: process.cwd(),
  redact: redactSensitiveText,
  allowLegacyClientMemoryWrites: ALLOW_LEGACY_CLIENT_MEMORY_WRITES
};
const REQUEST_CONTEXT = new AsyncLocalStorage();
const HTTP_RESPONSE = Symbol("httpResponse");
const INTERNAL_COMMUNICATION_SCOPE = Symbol("internalCommunicationScope");
const INTERNAL_GMAIL_ACTION_SCOPE = Symbol("internalGmailActionScope");
const GMAIL_DRAFT_MIME_BYTES = Symbol("gmailDraftMimeBytes");
const GMAIL_FILE_EMAIL_UNIQUE = Symbol("gmailFileEmailUnique");
const GMAIL_FILE_CLAIM_UNIQUE = Symbol("gmailFileClaimUnique");
const GMAIL_FILE_COMPANY_CONTACTS = Symbol("gmailFileCompanyContacts");
const HCN_FRESH_PROVIDER_CACHE = Symbol("hcnFreshProviderCache");
const GOOGLE_IDENTITY_CACHE = new Map();
const JOBNIMBUS_USER_CACHE = new Map();
const USED_OAUTH_CODES = new Map();
const HCN_CONSOLE_SESSION_STORE = createHcnConsoleSessionStore();
const HCN_CONSOLE_LOGIN_ADMISSION = createHcnConsoleLoginAdmission();
const HCN_CONSOLE_READ_ADMISSION = createHcnReadAdmissionController();
const HCN_ACTION_PREPARE_ADMISSION = createHcnReadAdmissionController({
  concurrentLimit: 1,
  requestLimit: 10,
  windowMs: 60_000,
  maxTrackedSessions: 512,
  idleTtlMs: 5 * 60_000,
  failureRetryAfterSeconds: 1
});
const HCN_ACTION_EXECUTE_ADMISSION = createHcnReadAdmissionController({
  concurrentLimit: 1,
  requestLimit: 3,
  windowMs: 60_000,
  maxTrackedSessions: 512,
  idleTtlMs: 5 * 60_000,
  failureRetryAfterSeconds: 1
});
const HCN_PENDING_ACTION_PLANS = createHcnPendingActionPlanStore();
const HCN_CONSOLE_STATE_CODEC = OAUTH_SESSION_SECRET
  ? createHcnConsoleStateCodec({ secret: OAUTH_SESSION_SECRET })
  : null;
let hcnConsoleOAuthCoordinatorInstance = null;
let hcnConsoleFreshReadServiceInstance = null;
let hcnActionReceiptIndexInstance = null;
let hcnActionExecutionInFlight = false;
const HCN_ACTION_SESSION_IN_FLIGHT = new Set();
let quoLineMutationQueue = Promise.resolve();
let actionBatchMutationQueue = Promise.resolve();
let actionBatchLedgerWriteCount = 0;
let actionApprovalMutationQueue = Promise.resolve();
let claimCallMutationQueue = Promise.resolve();
let outboundSendMutationQueue = Promise.resolve();
const ACTION_RECEIPT_RECOVERY_STATE = {
  status: "pending",
  lastStartupRecoveryAt: "",
  error: ""
};

for (const [name, token] of [
  ["CODEX_OPERATOR_TOKEN", CODEX_OPERATOR_TOKEN],
  ["CODEX_MAC_OPERATOR_TOKEN", CODEX_MAC_OPERATOR_TOKEN]
]) {
  if (token && !/^[\x21-\x7E]{32,512}$/.test(token)) {
    throw new Error(`${name} must contain 32 to 512 printable non-space ASCII characters.`);
  }
  if (BRIDGE_TOKEN && token && secureEqual(BRIDGE_TOKEN, token)) {
    throw new Error(`${name} must be different from JOBNIMBUS_BRIDGE_TOKEN.`);
  }
}
if (
  CODEX_OPERATOR_TOKEN
  && CODEX_MAC_OPERATOR_TOKEN
  && secureEqual(CODEX_OPERATOR_TOKEN, CODEX_MAC_OPERATOR_TOKEN)
) {
  throw new Error("CODEX_MAC_OPERATOR_TOKEN must be different from CODEX_OPERATOR_TOKEN.");
}
for (const [name, token, pattern, message] of [
  [
    "RETELL_GUARDED_END_CALL_TOKEN",
    RETELL_GUARDED_END_CALL_TOKEN,
    /^[\x21-\x7E]{32,512}$/,
    "32 to 512 printable non-space ASCII characters"
  ],
  [
    "RETELL_INBOUND_WEBHOOK_TOKEN",
    RETELL_INBOUND_WEBHOOK_TOKEN,
    /^[A-Za-z0-9_-]{32,512}$/,
    "32 to 512 URL-safe characters"
  ]
]) {
  if (token && !pattern.test(token)) throw new Error(`${name} must contain ${message}.`);
}
const RETELL_BOUNDARY_TOKENS = [
  ["JOBNIMBUS_BRIDGE_TOKEN", BRIDGE_TOKEN],
  ["CODEX_OPERATOR_TOKEN", CODEX_OPERATOR_TOKEN],
  ["CODEX_MAC_OPERATOR_TOKEN", CODEX_MAC_OPERATOR_TOKEN],
  ["RETELL_GUARDED_END_CALL_TOKEN", RETELL_GUARDED_END_CALL_TOKEN],
  ["RETELL_INBOUND_WEBHOOK_TOKEN", RETELL_INBOUND_WEBHOOK_TOKEN]
].filter(([, token]) => Boolean(token));
for (let left = 0; left < RETELL_BOUNDARY_TOKENS.length; left += 1) {
  for (let right = left + 1; right < RETELL_BOUNDARY_TOKENS.length; right += 1) {
    const [leftName, leftToken] = RETELL_BOUNDARY_TOKENS[left];
    const [rightName, rightToken] = RETELL_BOUNDARY_TOKENS[right];
    if (secureEqual(leftToken, rightToken)) {
      throw new Error(`${leftName} and ${rightName} must use distinct credentials.`);
    }
  }
}
if (
  ALLOW_RETELL_CALLS
  && ALLOW_RETELL_CLAIM_CALLS
  && (!RETELL_GUARDED_END_CALL_TOKEN || !RETELL_INBOUND_WEBHOOK_TOKEN)
) {
  throw new Error("Enabled Retell claim filing requires distinct RETELL_GUARDED_END_CALL_TOKEN and RETELL_INBOUND_WEBHOOK_TOKEN credentials.");
}

const routes = new Map([
  ["GET /health", health],
  ["GET /api/v1/meta", hcnPlatformMeta],
  ["GET /api/v1/session", hcnPlatformSession],
  ["GET /hcn/auth/session", hcnBrowserSession],
  ["POST /hcn/auth/logout", hcnBrowserLogout],
  ["POST /hcn/api/v1/work-center", hcnReadWorkCenter],
  ["POST /hcn/api/v1/file-review", hcnReadFile],
  ["POST /hcn/api/v1/action-plans/prepare", hcnPrepareActionPlan],
  ["POST /hcn/api/v1/action-plans/list", hcnListActionPlans],
  ["POST /hcn/api/v1/action-plans/detail", hcnReadActionPlan],
  ["POST /hcn/api/v1/action-plans/execute", hcnExecuteActionPlan],
  ["POST /hcn/api/v1/action-plans/invalidate", hcnInvalidateActionPlan],
  ["POST /hcn/api/v1/action-receipts/list", hcnListActionReceipts],
  ["POST /hcn/api/v1/action-receipts/detail", hcnReadActionReceipt],
  ["GET /auth/whoami", authWhoAmI],
  ["POST /auth/quo-line", quoLineLink],
  ["GET /openapi.json", openapi],
  ["GET /openapi-chatgpt.json", chatgptOpenapi],
  ["GET /privacy", privacy],
  ["GET /handoff", handoffPage],
  ["GET /voice/twiml", voiceTwiml],
  ["POST /voice/outbound-call", outboundVoiceCall],
  ["POST /voice/transcript", voiceTranscript],
  ["POST /voice/transcripts", voiceTranscripts],
  ["POST /handoff", createHandoff],
  ["POST /handoff/chunk", createHandoffChunk],
  ["POST /handoff/pending", pendingHandoffs],
  ["POST /handoff/get", getHandoff],
  ["POST /handoff/process", processHandoff],
  ["POST /handoff/complete", completeHandoff],
  ["POST /artifacts/chunk", createArtifactChunk],
  ["POST /artifacts/list", listArtifacts],
  ["POST /artifacts/get", getArtifact],
  ["POST /artifacts/complete", completeArtifact],
  ["POST /brain/context", brainContext],
  ["POST /memory/file-actions", memoryFileActions],
  ["POST /memory/persistence-check", memoryPersistenceCheck],
  ["POST /ops/start-session", startThresherOperationalSession],
  ["POST /ops/recover-scheduling-communications", recoverSchedulingCommunications],
  ["POST /ops/review-chance-files", reviewChanceFiles],
  ["GET /ops/run-policy", operatorRunPolicy],
  ["POST /ops/action-batch-receipts", actionBatchReceipts],
  ["POST /ops/action-batch-reconcile", actionBatchReconcile],
  ["POST /ops/action-batch", processActionBatch],
  ["POST /scheduling/availability", schedulingAvailability],
  ["POST /jobnimbus/search", searchContacts],
  ["POST /jobnimbus/review-file", reviewFile],
  ["POST /jobnimbus/assigned-files", assignedFiles],
  ["POST /jobnimbus/assigned-counts", assignedCounts],
  ["POST /jobnimbus/document-text", documentText],
  ["POST /jobnimbus/document-review", documentReview],
  ["POST /jobnimbus/document-file", documentFileForChat],
  ["POST /jobnimbus/photo-review", photoReview],
  ["POST /weather/dol-research", dateOfLossResearch],
  ["POST /jobnimbus/upload-file", uploadJobNimbusFile],
  ["POST /jobnimbus/update-contact", updateContact],
  ["POST /jobnimbus/update-status", updateStatus],
  ["POST /jobnimbus/process-update", processUpdate],
  ["POST /jobnimbus/create-note", createNote],
  ["POST /jobnimbus/create-task", createTask],
  ["POST /jobnimbus/update-task", updateTask],
  ["POST /jobnimbus/create-calendar-event", createCalendarEvent],
  ["POST /jobnimbus/update-calendar-event", updateCalendarEvent],
  ["POST /claim-filing/prepare", prepareClaimFiling],
  ["POST /claim-filing/configuration", claimFilingConfiguration],
  ["POST /claim-filing/call", placeClaimFilingCall],
  ["POST /claim-filing/result", claimFilingResult],
  ["POST /claim-filing/callbacks", pendingClaimCallbacks],
  ["POST /claim-filing/writeback", claimFilingWriteback],
  ["POST /retell/configure-agent", configureRetellAgent],
  ["POST /retell/guarded-end-call", guardedRetellEndCall],
  ["POST /retell/configure-client-coordinator", configureClientCoordinatorAgent],
  ["POST /retell/client-coordinator-call", retellClientCoordinatorCall],
  ["POST /retell/client-coordinator-call-result", retellClientCoordinatorCallResult],
  ["POST /retell/configure-carrier-follow-up", configureCarrierFollowUpAgent],
  ["POST /retell/carrier-follow-up-call", retellCarrierFollowUpCall],
  ["POST /retell/carrier-follow-up-call-result", retellCarrierFollowUpCallResult],
  ["POST /retell/homeowner-call", retellHomeownerCall],
  ["POST /retell/homeowner-call-result", retellHomeownerCallResult],
  ["POST /retell/inbound", retellInbound],
  ["POST /gmail/search", gmailSearch],
  ["POST /gmail/thread", gmailThread],
  ["POST /gmail/attachment-review", gmailAttachmentReview],
  ["POST /gmail/draft", gmailDraft],
  ["POST /gmail/send", gmailSend],
  ["POST /quo/numbers", quoNumbers],
  ["POST /quo/history", quoHistory],
  ["POST /quo/transcript", quoTranscript],
  ["POST /quo/send", quoSend]
]);

await hydrateAutoEnrolledWaveUsers();
await initializeOperatorReceiptBoundary();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/oauth/authorize") return oauthAuthorize(res, url);
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      return oauthGoogleCallback(req, res, url);
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") return oauthToken(req, res);
    if (req.method === "GET" && url.pathname === "/hcn/auth/login") {
      return hcnConsoleLogin(req, res, url);
    }
    if (HCN_CONSOLE_ENABLED && req.method === "GET" && url.pathname === "/hcn") {
      res.writeHead(308, {
        ...HCN_CONSOLE_SECURITY_HEADERS,
        location: "/hcn/"
      });
      return res.end();
    }
    if (HCN_CONSOLE_ENABLED && req.method === "GET") {
      const consoleAsset = await readHcnConsoleAsset(url.pathname);
      if (consoleAsset) {
        res.writeHead(200, consoleAsset.headers);
        return res.end(consoleAsset.body);
      }
    }
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, { error: "Not found" });
    if (url.pathname.startsWith("/artifacts/") && (!BRIDGE_TOKEN || !authorized(req))) {
      return send(res, 401, { error: "Artifact mailbox requires bridge bearer authentication." });
    }
    if (url.pathname === "/retell/inbound" && !retellInboundAuthorized(url)) {
      return send(res, 401, { error: "Unauthorized inbound webhook" });
    }
    let authentication = null;
    let identity = null;
    if (url.pathname !== "/retell/inbound" && !isPublicRoute(req.method, url.pathname)) {
      authentication = await authenticateRequest(req);
      identity = authentication?.identity || null;
      if (!identity) return send(res, 401, { error: "Unauthorized" });
      if (!routeAllowed(identity, req.method, url.pathname)) {
        return send(res, 403, { error: "This Wave Ops role is not permitted to use that action." });
      }
      assertHcnCookieRequestSafety(req, authentication);
    }
    const parsedBody = req.method === "GET"
      ? { body: {}, rawBody: Buffer.alloc(0) }
      : await readJsonEnvelope(
          req,
          url.pathname.startsWith("/hcn/api/")
            ? hcnApiBodyLimit(url.pathname)
            : MAX_JSON_BODY_BYTES
        );
    if (
      url.pathname === "/retell/inbound"
      && !retellInboundSignatureAuthorized(req, parsedBody.rawBody)
    ) {
      return send(res, 401, { error: "Unauthorized inbound webhook" });
    }
    const body = parsedBody.body;
    const operatorScope = resolveCodexOperatorRequestScope(
      identity,
      req.method,
      url.pathname,
      body
    );
    assertIdentityRequestScope(
      identity,
      req.method,
      url.pathname,
      body,
      operatorScope
    );
    const result = await REQUEST_CONTEXT.run(
      {
        ...(authentication || { identity }),
        operatorScope
      },
      () => handler(body)
    );
    if (result?.[HTTP_RESPONSE]) {
      send(
        res,
        result.status,
        result.body,
        result.headers
      );
    } else if (result?.html) sendHtml(res, 200, result.html);
    else if (typeof result === "string") sendText(res, 200, result);
    else send(
      res,
      200,
      result,
      authentication?.authenticationMethod === "hcn_cookie"
        ? {
            ...hcnNoStoreSecurityHeaders(),
            vary: "Cookie, Authorization",
            "x-hcn-session-idle-expires-at":
              authentication.hcnSession.idleExpiresAt,
            "x-hcn-session-expires-at":
              authentication.hcnSession.expiresAt
          }
        : {}
    );
  } catch (error) {
    const retryAfterSeconds = Number(error?.retryAfterSeconds);
    send(
      res,
      error.statusCode || 500,
      {
        error: redactSensitiveText(error.message || String(error))
      },
      Number.isSafeInteger(retryAfterSeconds)
        && retryAfterSeconds >= 1
        && retryAfterSeconds <= 3600
        ? { "retry-after": String(retryAfterSeconds) }
        : {}
    );
  }
});

const voiceWebSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== VOICE_STREAM_PATH && !url.pathname.startsWith(`${VOICE_STREAM_PATH}/`)) {
    socket.destroy();
    return;
  }

  if (!voiceStreamAuthorized(url)) {
    console.log(JSON.stringify({
      type: "twilio_stream_rejected",
      reason: "invalid_stream_token",
      pathHasToken: url.pathname.startsWith(`${VOICE_STREAM_PATH}/`),
      queryHasToken: url.searchParams.has("token")
    }));
    socket.destroy();
    return;
  }

  voiceWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
    bridgeTwilioToOpenAI(webSocket, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`JobNimbus ChatGPT bridge listening on http://${HOST}:${PORT}`);
  console.log(`Auth: ${BRIDGE_TOKEN ? "enabled" : "disabled"}`);
  console.log(`Writes: ${ALLOW_WRITES ? "enabled" : "dry-run only"}`);
  console.log(`Voice stream: ${OPENAI_API_KEY ? "available" : "missing OPENAI_API_KEY"}`);
});

function health() {
  const status = {
    ok: true,
    service: "jobnimbus-chatgpt-bridge",
    jobNimbusConfigured: Boolean(API_KEY),
    gmailConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
    userOAuth: {
      available: oauthBrokerConfigured() || hcnConsoleAuthConfigured(),
      provider: "google_via_bridge",
      allowedWorkspaceDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
      approvedUserCount: WAVE_AUTH_USERS.size,
      automaticEmployeeEnrollment: {
        enabled: AUTO_ENROLL_WAVE_USERS,
        requirements: ["verified_wavepa_google", "active_jobnimbus_user", "verified_company_quo_line"],
        accessBeforeQuoVerification: "onboarding_only",
        accessAfterVerification: "full_company_operations"
      },
      sharedBridgeTokenFallback: Boolean(BRIDGE_TOKEN),
      perUserGmail: true,
      roleEnforcement: true,
      authorizationUrl: `${PUBLIC_BASE_URL}/oauth/authorize`,
      tokenUrl: `${PUBLIC_BASE_URL}/oauth/token`
    },
    hcnConsole: {
      enabled: HCN_CONSOLE_ENABLED,
      available: hcnConsoleAuthConfigured(),
      authentication: "google_workspace_server_session",
      sessionStore: "bounded_in_memory_single_instance",
      browserCredential: "secure_http_only_host_cookie",
      csrfProtection: "exact_origin_and_session_token",
      authorizedSurface: hcnConsoleFreshReadConfigured()
        ? "chance_assigned_fresh_read_only"
        : "foundation_metadata_only",
      clientDataPersistence: "none",
      referenceConfiguration:
        projectHcnReferenceConfigurationReadiness(
          HCN_REFERENCE_CONFIGURATION
        ),
      providerTokensExposedToBrowser: false,
      chanceBrainDataFlow: false,
      jobroloDataFlow: false,
      loginAdmission: HCN_CONSOLE_LOGIN_ADMISSION.stats()
    },
    codexOperator: {
      available: Boolean(CODEX_OPERATOR_TOKEN || CODEX_MAC_OPERATOR_TOKEN),
      configuredIdentities: [
        CODEX_OPERATOR_TOKEN ? "hp" : "",
        CODEX_MAC_OPERATOR_TOKEN ? "mac" : ""
      ].filter(Boolean),
      role: "codex_operator",
      assignedJobNimbusFilesOnly: !CODEX_MAC_OPERATOR_TOKEN,
      hpAssignedJobNimbusFilesOnly: true,
      defaultScope: "chance_assigned",
      macCompanyExactFileScope: Boolean(CODEX_MAC_OPERATOR_TOKEN),
      companyWideIndexOrSweep: false,
      macAssignedBatchMaxFiles: CODEX_MAC_ASSIGNED_BATCH_MAX_FILES,
      macAssignedMultiFileActionTypes: [...CODEX_MAC_ASSIGNED_MULTI_FILE_ACTION_TYPES],
      macAssignedMultiFileExecution: "sequential_fail_stop_no_rollback",
      chanceRunPolicy: chanceOperatorRunManifestSummary(CHANCE_OPERATOR_RUN_MANIFEST),
      actionReceiptRecovery: { ...ACTION_RECEIPT_RECOVERY_STATE },
      companyBatchMaxFiles: 1,
      gmailReadsRequireExactAssignedFile: true,
      quoReadsRequireExactAssignedFile: true,
      broadUnmatchedCommunicationsSweep: false,
      existingDraftSendRequiresBridgeReceipt: true,
      existingDraftSendApprovalBatched: true,
      existingDraftSendAllowed: Boolean(
        CHANCE_OPERATOR_RUN_MANIFEST?.allowedActionTypes.includes("gmail.send_existing_draft")
      ),
      retainedDraftIdIsOneShot: true,
      querylessIndexIsPiiMinimized: true,
      chanceBrainClientMemory: "disabled",
      directUnapprovedWriteUploadSendOrCallRoutes: false,
      directApprovedClaimCallRoute: true,
      actionBatchOnly: false,
      jobNimbusWritesActionBatchOnly: true,
      claimFilingApprovalLane: Boolean(CODEX_MAC_OPERATOR_TOKEN),
      claimFilingSingleFileOnly: true,
      claimFilingWritebackAllowed: false,
      approvalChallenge: "short_lived_identity_bound_single_use"
    },
    gmailSendAllowed: ALLOW_GMAIL_SEND,
    quoConfigured: Boolean(QUO_API_KEY),
    quoSendAllowed: ALLOW_QUO_SEND,
    quoLineVerification: {
      available: Boolean(QUO_API_KEY && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && QUO_VERIFICATION_FROM_NUMBER),
      method: "google_identity_plus_sms_otp",
      codeTtlMinutes: 10,
      maxAttempts: 5,
      persistentLinks: true,
      actualMessagesRemainApprovalGated: true
    },
    writesAllowed: ALLOW_WRITES,
    hcnActions: {
      preparationAvailable:
        HCN_CONSOLE_ENABLED
        && HCN_REFERENCE_CONFIGURATION.ready === true
        && Boolean(API_KEY),
      executionGateEnabled: HCN_ACTION_EXECUTION_ENABLED,
      executionReady:
        ALLOW_WRITES
        && HCN_ACTION_EXECUTION_ENABLED,
      browserApprovalChallengeExposed: false,
      pendingPlanStore: "bounded_in_memory_session_scoped",
      durableReceiptIndex: "metadata_only_atomic_disk",
      automaticRetry: false,
      prepareAdmission: HCN_ACTION_PREPARE_ADMISSION.stats(),
      executeAdmission: HCN_ACTION_EXECUTE_ADMISSION.stats()
    },
    releaseGates: RELEASE_GATES,
    outboundSafety: {
      automaticEmailOrTextSending: false,
      explicitChanceApprovalRequired: true,
      exactDryRunDigestRequired: true,
      shortLivedSingleUseChallengeRequired: true,
      changedPayloadInvalidatesApproval: true,
      duplicateSendBlocked: true,
      failedSendRequiresFreshApproval: true
    },
    ocrMode: "poppler+tesseract",
    chatgptDocumentReturn: {
      available: true,
      mode: "openaiFileResponse_inline",
      maxBytes: MAX_CHATGPT_FILE_BYTES,
      nativeConversationFile: true,
      readOnly: true,
      imagesAndVideoAllowed: false
    },
    dateOfLossResearch: {
      available: true,
      mode: "read_only_candidate_research",
      automaticJobNimbusUpdate: false,
      confirmedDateOfLoss: false,
      sources: [
        "U.S. Census Geocoder",
        "Iowa Environmental Mesonet archive of National Weather Service Local Storm Reports"
      ]
    },
    artifactMailbox: {
      available: Boolean(BRIDGE_TOKEN),
      authentication: "bearer_token_required",
      acceptedTypes: [".patch", ".diff"],
      maxBytes: MAX_ARTIFACT_BYTES,
      ttlHours: ARTIFACT_TTL_HOURS,
      storage: "ephemeral_unless_paths_use_persistent_disk",
      automaticExecution: false
    },
    voice: {
      available: Boolean(OPENAI_API_KEY),
      model: OPENAI_REALTIME_MODEL,
      voice: OPENAI_VOICE,
      streamPath: VOICE_STREAM_PATH,
      streamAuth: VOICE_STREAM_TOKEN ? "token_required" : "disabled",
      twilioConfigured: Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER),
      callsAllowed: ALLOW_VOICE_CALLS
    },
    claimFiling: {
      available: Boolean(
        RETELL_API_KEY
        && RETELL_AGENT_ID
        && RETELL_FROM_NUMBER
        && RETELL_GUARDED_END_CALL_TOKEN
        && RETELL_INBOUND_WEBHOOK_TOKEN
      ),
      engine: "retell",
      callsAllowed: ALLOW_RETELL_CALLS && ALLOW_RETELL_CLAIM_CALLS,
      dedicatedCallGate: ALLOW_RETELL_CLAIM_CALLS,
      ownerScope: "Chance Pearson",
      approvalDigestRequired: true,
      shortLivedSingleUseChallengeRequired: true,
      operatorSingleFileOnly: true,
      operatorWritebackAllowed: false,
      writebackRequiresSeparateApproval: true,
      callbackWebhookAvailable: Boolean(RETELL_INBOUND_WEBHOOK_TOKEN),
      guardedEndCredentialConfigured: Boolean(RETELL_GUARDED_END_CALL_TOKEN),
      guardedEndCredentialIsolated: Boolean(RETELL_GUARDED_END_CALL_TOKEN),
      inboundWebhookCredentialIsolated: Boolean(RETELL_INBOUND_WEBHOOK_TOKEN),
      inboundWebhookSignatureVerification: "retell_hmac_sha256_raw_body_timestamp",
      inboundFallbackAgent: "unset_fail_closed",
      exactPublishedAgentVersionRequired: true,
      callbackPacketRestoration: "full_approved_packet",
      callbackTtlHours: RETELL_CALLBACK_TTL_HOURS,
      retryRequiresPriorCallId: true
    },
    clientCoordinator: {
      available: Boolean(RETELL_API_KEY && RETELL_CLIENT_COORDINATOR_AGENT_ID && RETELL_FROM_NUMBER),
      engine: "retell",
      supportedModes: ["appointment_confirmation", "missing_document_request", "status_update", "client_check_in"],
      appointmentCallsAllowed: ALLOW_RETELL_CALLS && ALLOW_CLIENT_COORDINATOR_CALLS,
      expandedModesAllowed: ALLOW_RETELL_CALLS && ALLOW_CLIENT_COORDINATOR_CALLS,
      ownerScope: "Chance Pearson",
      freshEvidenceRequired: true,
      approvalDigestRequired: true,
      automaticTextOrWriteback: false
    },
    carrierFollowUp: {
      available: Boolean(RETELL_API_KEY && RETELL_CARRIER_FOLLOWUP_AGENT_ID && RETELL_FROM_NUMBER),
      engine: "retell",
      supportedGoals: CARRIER_FOLLOW_UP_GOALS,
      supportedDestinations: CARRIER_DESTINATION_TYPES,
      callsAllowed: ALLOW_RETELL_CALLS && ALLOW_CARRIER_FOLLOWUP_CALLS,
      extensionsSupported: true,
      ownerScope: "Chance Pearson",
      freshEvidenceRequired: true,
      approvalDigestRequired: true,
      automaticScheduling: false,
      automaticJobNimbusWriteback: false
    },
    schedulingAvailability: {
      jobNimbusCalendarConfigured: Boolean(API_KEY),
      googleCalendarConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
      googleCalendarId: GOOGLE_CALENDAR_ID === "primary" ? "primary" : "configured",
      timeZone: OPERATIONS_TIME_ZONE,
      appointmentMinutes: SCHEDULING_APPOINTMENT_MINUTES,
      travelBufferMinutes: SCHEDULING_TRAVEL_BUFFER_MINUTES,
      failClosed: true
    },
    brain: {
      available: true,
      mode: "legacy_v1_client_snapshot_persistence_requires_v2_privacy_migration",
      autonomousLearning: false,
      externalActions: false,
      codexOperatorClientMemory: "disabled_no_read_no_write",
      clientMemoryExposed: "legacy_read_only_non_operator_paths",
      clientSnapshots: "legacy_v1_unsafe_until_migrated",
      legacyClientMemoryWritesAllowed: ALLOW_LEGACY_CLIENT_MEMORY_WRITES,
      automaticRefreshOnReview: ALLOW_LEGACY_CLIENT_MEMORY_WRITES
        ? "legacy_non_operator_paths_only"
        : "disabled_privacy_gate",
      legacySnapshotPurgeRequiresSeparateApproval: true,
      operationalOpenLoops: true,
      deterministicRulesRunOnExactReview: true,
      optionalModelAdvisory: operationalAdvisoryProviderDescriptors().length > 0,
      operationalProvider: OPERATIONAL_LLM_PROVIDER,
      operationalModel: operationalModelName(OPERATIONAL_LLM_PROVIDER),
      operationalProviderConfigured: operationalProviderConfigured(OPERATIONAL_LLM_PROVIDER),
      fallbackProvider: OPERATIONAL_LLM_FALLBACK_PROVIDER || "disabled",
      fallbackProviderConfigured: Boolean(
        OPERATIONAL_LLM_FALLBACK_PROVIDER
        && operationalProviderConfigured(OPERATIONAL_LLM_FALLBACK_PROVIDER)
      ),
      providerNeutralAdapter: true,
      exactClientDataMinimized: false,
      modelHasTools: false,
      modelCanExecute: false,
      liveSourcesWin: true,
      doesNotAuthorizeActions: true,
      persistentRootConfigured: Boolean(process.env.MEMORY_ROOT)
    }
  };
  return {
    ...status,
    platform: buildPlatformMeta({ runtime: status })
  };
}

function oauthBrokerConfigured() {
  return Boolean(
    ALLOW_GOOGLE_USER_AUTH
    && GOOGLE_CLIENT_ID
    && GOOGLE_CLIENT_SECRET
    && GPT_OAUTH_CLIENT_ID
    && GPT_OAUTH_CLIENT_SECRET
    && OAUTH_SESSION_SECRET
  );
}

function hcnConsoleAuthConfigured() {
  if (
    !HCN_CONSOLE_ENABLED
    || !ALLOW_GOOGLE_USER_AUTH
    || !GOOGLE_CLIENT_ID
    || !GOOGLE_CLIENT_SECRET
    || !OAUTH_SESSION_SECRET
    || !HCN_CONSOLE_STATE_CODEC
    || !HCN_CONSOLE_ORIGIN
    || !hcnConsoleChanceUserConfigured(
      WAVE_AUTH_USERS,
      CHANCE_GOOGLE_EMAIL
    )
  ) {
    return false;
  }
  let publicOrigin;
  try {
    publicOrigin = new URL(PUBLIC_BASE_URL).origin;
  } catch {
    return false;
  }
  if (publicOrigin !== HCN_CONSOLE_ORIGIN) return false;
  const originUrl = new URL(HCN_CONSOLE_ORIGIN);
  if (originUrl.protocol === "https:") return true;
  return process.env.NODE_ENV === "test"
    && originUrl.protocol === "http:"
    && originUrl.hostname === "127.0.0.1";
}

function hcnConsoleOAuthCoordinator() {
  if (!hcnConsoleAuthConfigured()) {
    throw oauthError(
      "temporarily_unavailable",
      "HCN console sign-in is not fully configured.",
      503
    );
  }
  if (!hcnConsoleOAuthCoordinatorInstance) {
    hcnConsoleOAuthCoordinatorInstance = createHcnConsoleOAuthCoordinator({
      store: HCN_CONSOLE_SESSION_STORE,
      sealState: HCN_CONSOLE_STATE_CODEC.seal,
      openState: HCN_CONSOLE_STATE_CODEC.open,
      authenticateGoogleAccessToken,
      resolveApprovedUser: async (candidate) => {
        const approved = WAVE_AUTH_USERS.get(candidate.email);
        if (
          !approved
          || approved.enabled === false
          || !approved.googleSubject
        ) {
          return null;
        }
        return {
          ...approved,
          email: candidate.email,
          googleSubject: approved.googleSubject
        };
      },
      canonicalOrigin: HCN_CONSOLE_ORIGIN,
      allowTestProviderEndpoints:
        ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS,
      google: {
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: GOOGLE_TOKEN_URL,
        tokenInfoUrl: GOOGLE_TOKENINFO_URL,
        userInfoUrl: GOOGLE_USERINFO_URL,
        allowedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
        prompt: "select_account"
      }
    });
  }
  return hcnConsoleOAuthCoordinatorInstance;
}

async function hcnConsoleLogin(req, res, url) {
  try {
    const admission = HCN_CONSOLE_LOGIN_ADMISSION.admit(
      hcnLoginSourceFromRequest(req, {
        renderProxy: Boolean(process.env.RENDER)
      })
    );
    if (!admission.allowed) {
      return send(
        res,
        429,
        {
          error: "rate_limited",
          error_description:
            "HCN console sign-in is temporarily rate limited.",
          retryAfterSeconds: admission.retryAfterSeconds
        },
        {
          ...hcnNoStoreSecurityHeaders(),
          vary: "Cookie, Authorization",
          "retry-after": String(admission.retryAfterSeconds)
        }
      );
    }
    const result = await hcnConsoleOAuthCoordinator().beginAuthorization({
      returnTo: url.searchParams.get("returnTo") || "/hcn"
    });
    res.writeHead(302, {
      ...hcnNoStoreSecurityHeaders(),
      vary: "Cookie, Authorization",
      location: result.redirectUrl,
      "set-cookie": result.setCookies
    });
    res.end();
  } catch (error) {
    sendHcnOAuthError(res, error);
  }
}

function operationalAdvisoryProviders() {
  const names = [...new Set([
    OPERATIONAL_LLM_PROVIDER,
    OPERATIONAL_LLM_FALLBACK_PROVIDER
  ].filter(Boolean))];
  const providers = [];
  for (const name of names) {
    if (name === "zai" && ZAI_API_KEY) {
      providers.push(createZaiOperationalProvider({
        apiKey: ZAI_API_KEY,
        model: ZAI_OPERATIONAL_MODEL
      }));
    }
    if (name === "openai" && OPENAI_API_KEY) {
      providers.push(createOpenAiOperationalProvider({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_OPERATIONAL_MODEL
      }));
    }
  }
  return providers;
}

function operationalAdvisoryProviderDescriptors() {
  return [...new Set([
    OPERATIONAL_LLM_PROVIDER,
    OPERATIONAL_LLM_FALLBACK_PROVIDER
  ].filter(Boolean))]
    .filter(operationalProviderConfigured)
    .map((provider) => ({
      provider,
      model: operationalModelName(provider)
    }));
}

function operationalProviderConfigured(provider) {
  if (provider === "zai") return Boolean(ZAI_API_KEY);
  if (provider === "openai") return Boolean(OPENAI_API_KEY);
  return false;
}

function operationalModelName(provider) {
  if (provider === "zai") return ZAI_OPERATIONAL_MODEL;
  if (provider === "openai") return OPENAI_OPERATIONAL_MODEL;
  return "unconfigured";
}

function oauthAuthorize(res, url) {
  if (!oauthBrokerConfigured()) return sendOAuthError(res, 503, "temporarily_unavailable", "Employee OAuth is not fully configured.");
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const responseType = url.searchParams.get("response_type") || "";
  const state = url.searchParams.get("state") || "";
  if (!secureEqual(clientId, GPT_OAUTH_CLIENT_ID)) return sendOAuthError(res, 401, "invalid_client", "Unknown OAuth client.");
  if (responseType !== "code") return sendOAuthError(res, 400, "unsupported_response_type", "Only authorization code is supported.");
  if (!approvedChatGptRedirect(redirectUri)) return sendOAuthError(res, 400, "invalid_request", "Unapproved OAuth redirect URI.");
  if (!state) return sendOAuthError(res, 400, "invalid_request", "OAuth state is required.");

  const brokerState = sealOAuthPayload({
    kind: "authorize_state",
    exp: Date.now() + 10 * 60 * 1000,
    redirectUri,
    clientState: state,
    codeChallenge: url.searchParams.get("code_challenge") || "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") || ""
  });
  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", `${PUBLIC_BASE_URL}/oauth/google/callback`);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  googleUrl.searchParams.set("access_type", "offline");
  googleUrl.searchParams.set("prompt", "consent");
  googleUrl.searchParams.set("state", brokerState);
  res.writeHead(302, { location: googleUrl.toString(), "cache-control": "no-store" });
  res.end();
}

async function oauthGoogleCallback(req, res, url) {
  const sealedState = String(url.searchParams.get("state") || "");
  if (isHcnConsoleStateEnvelope(sealedState)) {
    return oauthHcnConsoleCallback(req, res, url, sealedState);
  }
  try {
    required(sealedState, "state");
    const state = openOAuthPayload(sealedState);
    if (state.kind !== "authorize_state") {
      throw oauthError("invalid_request", "OAuth state is invalid or expired.");
    }
    return oauthBrokerGoogleCallback(res, url, state);
  } catch (error) {
    sendOAuthError(res, error.statusCode || 400, error.oauthCode || "invalid_request", error.message || "OAuth callback failed.");
  }
}

async function oauthBrokerGoogleCallback(res, url, state) {
  if (!oauthBrokerConfigured()) throw oauthError("temporarily_unavailable", "Employee OAuth is not fully configured.", 503);
  if (Number(state.exp || 0) <= Date.now()) {
    throw oauthError("invalid_request", "OAuth state is invalid or expired.");
  }
  if (url.searchParams.get("error")) {
    return redirectOAuthError(res, state.redirectUri, state.clientState, url.searchParams.get("error"));
  }
  const code = required(url.searchParams.get("code"), "code");
  const tokenResult = await fetchBoundedProviderJson(
    fetch,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_BASE_URL}/oauth/google/callback`,
        grant_type: "authorization_code"
      })
    }
  );
  const tokenResponse = tokenResult.response;
  const tokens = tokenResult.payload;
  if (!tokenResponse.ok || !tokens.access_token) throw oauthError("access_denied", "Google sign-in could not be completed.", 401);
  const identity = await authenticateGoogleAccessToken({
    token: tokens.access_token,
    clientId: GOOGLE_CLIENT_ID,
    tokenInfoUrl: GOOGLE_TOKENINFO_URL,
    userInfoUrl: GOOGLE_USERINFO_URL,
    allowedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
    users: WAVE_AUTH_USERS,
    resolveUser: resolveFirstUseWaveUser,
    allowTestProviderEndpoints:
      ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS
  });
  if (!tokens.refresh_token) throw oauthError("access_denied", "Google did not return offline access. Reconnect and approve the requested access.", 401);

  const brokerCode = sealOAuthPayload({
    kind: "authorization_code",
    jti: randomUUID(),
    exp: Date.now() + 5 * 60 * 1000,
    redirectUri: state.redirectUri,
    codeChallenge: state.codeChallenge,
    codeChallengeMethod: state.codeChallengeMethod,
    googleAccessToken: tokens.access_token,
    googleRefreshToken: tokens.refresh_token,
    googleExpiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    identity: oauthIdentityPayload(identity)
  });
  const destination = new URL(state.redirectUri);
  destination.searchParams.set("code", brokerCode);
  destination.searchParams.set("state", state.clientState);
  res.writeHead(302, { location: destination.toString(), "cache-control": "no-store" });
  res.end();
}

async function oauthHcnConsoleCallback(req, res, url, sealedState) {
  try {
    const loginBinding = readHcnCookie(
      req.headers.cookie,
      HCN_LOGIN_COOKIE_NAME
    );
    const result = await hcnConsoleOAuthCoordinator().completeCallback({
      state: sealedState,
      code: url.searchParams.get("code") || "",
      error: url.searchParams.get("error") || "",
      loginBinding
    });
    res.writeHead(302, {
      ...hcnNoStoreSecurityHeaders(),
      vary: "Cookie, Authorization",
      location: result.redirectPath,
      "set-cookie": result.setCookies
    });
    res.end();
  } catch (error) {
    sendHcnOAuthError(res, error, [clearHcnLoginCookie()]);
  }
}

async function oauthToken(req, res) {
  try {
    if (!oauthBrokerConfigured()) throw oauthError("temporarily_unavailable", "Employee OAuth is not fully configured.", 503);
    const form = await readForm(req);
    const credentials = oauthClientCredentials(req, form);
    if (!secureEqual(credentials.clientId, GPT_OAUTH_CLIENT_ID) || !secureEqual(credentials.clientSecret, GPT_OAUTH_CLIENT_SECRET)) {
      throw oauthError("invalid_client", "Invalid OAuth client credentials.", 401);
    }

    if (form.grant_type === "authorization_code") {
      const payload = openOAuthPayload(required(form.code, "code"));
      if (payload.kind !== "authorization_code" || Number(payload.exp || 0) <= Date.now()) throw oauthError("invalid_grant", "Authorization code is invalid or expired.");
      if (USED_OAUTH_CODES.has(payload.jti)) throw oauthError("invalid_grant", "Authorization code has already been used.");
      if (payload.redirectUri !== form.redirect_uri) throw oauthError("invalid_grant", "Redirect URI does not match.");
      verifyPkce(payload, form.code_verifier || "");
      USED_OAUTH_CODES.set(payload.jti, Date.now() + 10 * 60 * 1000);
      cleanupUsedOAuthCodes();
      return send(res, 200, issueBrokerTokens(payload));
    }

    if (form.grant_type === "refresh_token") {
      const refresh = openOAuthPayload(required(form.refresh_token, "refresh_token"));
      if (refresh.kind !== "refresh_token" || Number(refresh.exp || 0) <= Date.now()) throw oauthError("invalid_grant", "Refresh token is invalid or expired.");
      const googleResult = await fetchBoundedProviderJson(
        fetch,
        GOOGLE_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json"
          },
          body: new URLSearchParams({
            refresh_token: refresh.googleRefreshToken,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            grant_type: "refresh_token"
          })
        }
      );
      const googleResponse = googleResult.response;
      const google = googleResult.payload;
      if (!googleResponse.ok || !google.access_token) throw oauthError("invalid_grant", "Google access could not be refreshed.", 401);
      return send(res, 200, issueBrokerTokens({
        ...refresh,
        googleAccessToken: google.access_token,
        googleExpiresAt: Date.now() + Number(google.expires_in || 3600) * 1000
      }, form.refresh_token));
    }

    throw oauthError("unsupported_grant_type", "Unsupported OAuth grant type.");
  } catch (error) {
    sendOAuthError(res, error.statusCode || 400, error.oauthCode || "invalid_request", error.message || "OAuth token exchange failed.");
  }
}

function issueBrokerTokens(payload, existingRefreshToken = "") {
  const identity = approvedIdentityFromPayload(payload.identity);
  const accessExpiresIn = Math.max(60, Math.min(3600, Math.floor((Number(payload.googleExpiresAt || 0) - Date.now()) / 1000)));
  const accessToken = sealOAuthPayload({
    kind: "access_token",
    exp: Date.now() + accessExpiresIn * 1000,
    googleAccessToken: payload.googleAccessToken,
    identity: oauthIdentityPayload(identity)
  });
  const refreshToken = existingRefreshToken || sealOAuthPayload({
    kind: "refresh_token",
    exp: Date.now() + 90 * 24 * 60 * 60 * 1000,
    googleRefreshToken: payload.googleRefreshToken,
    identity: oauthIdentityPayload(identity)
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessExpiresIn,
    refresh_token: refreshToken,
    scope: GOOGLE_OAUTH_SCOPES.join(" ")
  };
}

async function authWhoAmI() {
  const identity = currentRequestIdentity();
  if (!identity) badRequest("No authenticated employee identity is available for this request.");
  const publicEmployee = publicIdentity(identity);
  const quoLine = await authorizedQuoLine(identity);
  publicEmployee.quoLineConfigured = Boolean(quoLine.number);
  publicEmployee.quoLine = quoLine.number ? {
    number: quoLine.number,
    name: quoLine.name,
    source: quoLine.source
  } : null;
  return {
    authenticated: true,
    identity: publicEmployee,
    operatorAccess: identity.type === "codex_operator_token"
      ? {
          defaultScope: "chance_assigned",
          companyExactFileScope:
            identity.subject === "codex-mac-operator",
          companyWideIndexOrSweep: false,
          assignedBatchMaxFiles:
            identity.subject === "codex-mac-operator"
              ? CODEX_MAC_ASSIGNED_BATCH_MAX_FILES
              : 1,
          assignedMultiFileActionTypes:
            identity.subject === "codex-mac-operator"
              ? [...CODEX_MAC_ASSIGNED_MULTI_FILE_ACTION_TYPES]
              : [],
          assignedMultiFileExecution:
            identity.subject === "codex-mac-operator"
              ? "sequential_fail_stop_no_rollback"
              : "unavailable",
          chanceRunPolicy:
            identity.subject === "codex-mac-operator"
              ? chanceOperatorRunManifestSummary(CHANCE_OPERATOR_RUN_MANIFEST)
              : { available: false, enforced: false },
          actionReceiptRecovery:
            identity.subject === "codex-mac-operator"
              ? { ...ACTION_RECEIPT_RECOVERY_STATE }
              : { status: "unavailable", lastStartupRecoveryAt: "", error: "" },
          companyBatchMaxFiles: 1,
          claimFilingSingleFileOnly:
            identity.subject === "codex-mac-operator",
          claimFilingWritebackAllowed: false,
          claimFilingSupportedGoals:
            identity.subject === "codex-mac-operator"
              ? ["file_new_claim", "find_existing_claim"]
              : [],
          callApprovalChallenge:
            identity.subject === "codex-mac-operator"
              ? "short_lived_identity_bound_single_use"
              : "unavailable",
          actionPath: identity.subject === "codex-mac-operator"
            ? "approval_batch_plus_retell_claim_filing"
            : "approval_batch_only"
        }
      : null,
    gmailMode: identity.type === "google_oauth" ? "signed_in_employee_mailbox" : "legacy_chance_mailbox",
    instruction: identity.type === "google_oauth"
      ? "The bridge will use this signed-in employee's Google token for Gmail and enforce this employee's Wave Ops role."
      : identity.type === "codex_operator_token"
        ? `This task is using the dedicated least-privilege ${identity.name || "Codex operator"} credential. JobNimbus writes remain approval-batch-only. The Mac operator may separately place one exact Retell claim-filing call after a fresh single-file plan and a short-lived single-use approval; uploads, sends, generic calls, and claim-result writeback remain denied.`
        : "This task is using the temporary shared bridge-token fallback and Chance's legacy Gmail connection."
  };
}

function hcnPlatformMeta() {
  return health().platform;
}

function hcnPlatformSession() {
  return buildPlatformSession({
    identity: currentRequestIdentity(),
    runtime: health()
  });
}

function hcnBrowserSession() {
  const context = currentRequestAuthentication();
  if (
    context?.authenticationMethod !== "hcn_cookie"
    || !context.hcnSession
    || !context.hcnSession.csrfToken
  ) {
    const error = new Error("HCN browser session authentication is required.");
    error.statusCode = 403;
    throw error;
  }
  return {
    ...hcnPlatformSession(),
    browserSession: {
      schemaVersion: "hcn.console.browser-session.v1",
      idleExpiresAt: context.hcnSession.idleExpiresAt,
      expiresAt: context.hcnSession.expiresAt,
      csrfToken: context.hcnSession.csrfToken
    }
  };
}

function hcnBrowserLogout() {
  const context = currentRequestAuthentication();
  if (
    context?.authenticationMethod !== "hcn_cookie"
    || !context.hcnSessionId
  ) {
    const error = new Error("HCN browser session authentication is required.");
    error.statusCode = 403;
    throw error;
  }
  HCN_PENDING_ACTION_PLANS.invalidateSession({
    sessionBinding: hcnActionSessionBinding()
  });
  HCN_CONSOLE_SESSION_STORE.revokeSession(context.hcnSessionId);
  return httpResponse(200, {
    signedOut: true
  }, {
    ...hcnNoStoreSecurityHeaders(),
    vary: "Cookie, Authorization",
    "set-cookie": clearHcnSessionCookie()
  });
}

async function hcnReadWorkCenter(input = {}) {
  assertChanceHcnReadSession();
  return withHcnReadAdmission(
    () => hcnConsoleFreshReadService().readWorkCenter(input)
  );
}

async function hcnReadFile(input = {}) {
  assertChanceHcnReadSession();
  return withHcnReadAdmission(
    () => hcnConsoleFreshReadService().readFile(input)
  );
}

async function hcnPrepareActionPlan(input = {}) {
  assertChanceHcnReadSession();
  const prepareInput = validateHcnBrowserActionPrepareInput(input);
  assertHcnActionOperationConflicts(prepareInput.operations);
  const sessionBinding = hcnActionSessionBinding();
  return withHcnActionAdmission(
    HCN_ACTION_PREPARE_ADMISSION,
    async () => withHcnRestrictedEffects(async () => {
      let approval = null;
      try {
        const scope = await resolveHcnActionScope({
          fileRef: prepareInput.fileRef,
          taskRefs: hcnTaskRefsFromPrepareInput(prepareInput)
        });
        const privateEngineRequest =
          await translateHcnBrowserActionsToPrivateEngineRequest(
            prepareInput,
            {
              resolveProviderJobId: ({ fileRef }) => {
                if (fileRef !== scope.fileRef) throw hcnActionScopeChanged();
                return scope.providerJobId;
              },
              resolveProviderTaskId: ({ fileRef, taskRef, providerJobId }) => {
                if (
                  fileRef !== scope.fileRef
                  || providerJobId !== scope.providerJobId
                ) {
                  throw hcnActionScopeChanged();
                }
                const providerTaskId = scope.providerTaskIds.get(taskRef);
                if (!providerTaskId) throw hcnActionScopeChanged();
                return providerTaskId;
              }
            }
          );
        const preparedBatch = await prepareCanonicalActionBatch(
          privateEngineRequest.operations
        );
        approval = await issueActionApprovalChallenge(
          preparedBatch.approvalDigest,
          preparedBatch.operations.length,
          preparedBatch.batchScope
        );
        const engineDryRun = {
          mode: "dry_run",
          operationCount: preparedBatch.operations.length,
          operations: preparedBatch.plans,
          approvalDigest: preparedBatch.approvalDigest,
          approvalChallenge: approval.challenge,
          approvalExpiresAt: approval.expiresAt
        };
        const presentation = projectHcnBrowserActionDryRun({
          prepareInput,
          privateEngineRequest,
          engineDryRun,
          fileDisplayLabel: scope.fileDisplayLabel
        });
        const plan = HCN_PENDING_ACTION_PLANS.create({
          sessionBinding,
          fileRef: scope.fileRef,
          fileDisplayLabel: presentation.file.displayLabel,
          fileScopeBinding: scope.fileScopeBinding,
          operations: preparedBatch.operations,
          dryRun: {
            mode: "dry_run",
            operationCount: preparedBatch.operations.length,
            approvalDigest: preparedBatch.approvalDigest,
            approvalChallenge: approval.challenge,
            approvalExpiresAt: approval.expiresAt,
            operations: presentation.operations
          }
        });
        return hcnActionEnvelope({ plan });
      } catch (error) {
        if (approval?.id) {
          await revokeActionApprovalChallenge(approval.id).catch(() => {});
          HCN_PENDING_ACTION_PLANS.invalidateSession({ sessionBinding });
        }
        throw hcnPublicActionError(error, "prepare");
      }
    }),
    { exclusiveSession: true }
  );
}

function hcnListActionPlans(input = {}) {
  assertChanceHcnReadSession();
  validateHcnBrowserActionListInput(input);
  const plans = HCN_PENDING_ACTION_PLANS.list({
    sessionBinding: hcnActionSessionBinding(),
    summary: true
  });
  return hcnActionEnvelope({ plans });
}

function hcnReadActionPlan(input = {}) {
  assertChanceHcnReadSession();
  const { planId } = validateHcnBrowserActionDetailInput(input);
  const plan = HCN_PENDING_ACTION_PLANS.get({
    sessionBinding: hcnActionSessionBinding(),
    planId
  });
  return hcnActionEnvelope({ plan });
}

function hcnInvalidateActionPlan(input = {}) {
  assertChanceHcnReadSession();
  const { planId } = validateHcnBrowserActionInvalidateInput(input);
  const plan = HCN_PENDING_ACTION_PLANS.invalidate({
    sessionBinding: hcnActionSessionBinding(),
    planId
  });
  return hcnActionEnvelope({ plan });
}

async function hcnExecuteActionPlan(input = {}) {
  assertChanceHcnReadSession();
  const { planId } = validateHcnBrowserActionExecuteInput(input);
  if (!ALLOW_WRITES || !HCN_ACTION_EXECUTION_ENABLED) {
    const error = new Error(
      "HCN action execution is not enabled. The reviewed plan remains unexecuted."
    );
    error.statusCode = 503;
    throw error;
  }
  const sessionBinding = hcnActionSessionBinding();
  const sessionPrincipalRef = hcnActionReceiptPrincipalRef();
  return withHcnActionAdmission(
    HCN_ACTION_EXECUTE_ADMISSION,
    async () => withHcnRestrictedEffects(async () => {
      const receiptIndex = hcnActionReceiptIndex();
      const pending = HCN_PENDING_ACTION_PLANS.get({
        sessionBinding,
        planId
      });
      const scope = await resolveHcnActionScope({
        fileRef: pending.fileRef,
        taskRefs: hcnTaskRefsFromPresentation(pending.operations)
      });
      const execution = HCN_PENDING_ACTION_PLANS.beginExecution({
        sessionBinding,
        planId,
        fileScopeBinding: scope.fileScopeBinding,
        approvalDigest: pending.approvalDigest
      });

      let executingReceipt;
      try {
        executingReceipt = receiptIndex.appendExecuting({
          sessionPrincipalRef,
          fileRef: execution.fileRef,
          planId: execution.planId,
          digest: execution.approvalDigest,
          operationCount: execution.operationCount
        });
      } catch {
        HCN_PENDING_ACTION_PLANS.recoverExecution({
          sessionBinding,
          planId,
          reason:
            "Execution did not begin because the durable receipt boundary was unavailable."
        });
        const error = new Error(
          "The durable HCN receipt boundary is unavailable. Nothing was intentionally executed."
        );
        error.statusCode = 503;
        throw error;
      }

      let engineResult;
      try {
        engineResult = await processActionBatch({
          operations: execution.operations,
          execute: true,
          approvalDigest: execution.approvalDigest,
          approvalChallenge: execution.approvalChallenge
        });
      } catch {
        return reconcileHcnExecution({
          receiptIndex,
          executingReceipt,
          execution,
          sessionBinding,
          sessionPrincipalRef,
          succeededCount: 0
        });
      }

      const outcome = hcnExecutionOutcome(
        engineResult,
        execution.operationCount
      );
      if (outcome.status === "reconciliation_required") {
        return reconcileHcnExecution({
          receiptIndex,
          executingReceipt,
          execution,
          sessionBinding,
          sessionPrincipalRef,
          succeededCount: outcome.succeededCount
        });
      }

      let receipt;
      try {
        receipt = receiptIndex.transition({
          sessionPrincipalRef,
          fileRef: execution.fileRef,
          planId: execution.planId,
          digest: execution.approvalDigest,
          batchRef: executingReceipt.batchRef,
          status: outcome.status,
          succeededCount: outcome.succeededCount,
          failedCount: outcome.failedCount,
          blockedCount: outcome.blockedCount,
          unknownCount: outcome.unknownCount
        });
      } catch {
        HCN_PENDING_ACTION_PLANS.recoverExecution({
          sessionBinding,
          planId,
          reason:
            "The provider outcome could not be durably terminalized. Reconcile from fresh evidence."
        });
        const error = new Error(
          "The HCN execution outcome requires reconciliation."
        );
        error.statusCode = 503;
        throw error;
      }
      const plan = HCN_PENDING_ACTION_PLANS.finishExecution({
        sessionBinding,
        planId,
        result: hcnPendingExecutionResult(outcome)
      });
      return hcnActionEnvelope({ plan, receipt });
    }),
    { exclusiveSession: true, globalExecution: true }
  );
}

function hcnListActionReceipts(input = {}) {
  assertChanceHcnReadSession();
  validateHcnBrowserActionListInput(input);
  const receipts = hcnActionReceiptIndex().list({
    sessionPrincipalRef: hcnActionReceiptPrincipalRef(),
    limit: 100
  });
  return hcnActionEnvelope({ receipts });
}

function hcnReadActionReceipt(input = {}) {
  assertChanceHcnReadSession();
  const { planId } = validateHcnBrowserActionDetailInput(input);
  const receipt = hcnActionReceiptIndex().get({
    sessionPrincipalRef: hcnActionReceiptPrincipalRef(),
    planId
  });
  return hcnActionEnvelope({ receipt });
}

function hcnActionEnvelope(value) {
  return {
    schema: "hcn.console.actions.v1",
    generatedAt: new Date().toISOString(),
    ephemeral: true,
    cachePolicy: "no_store",
    authority: {
      mode: "explicit_chance_approval",
      automaticExecution: false,
      automaticRetry: false,
      providerIdentifiersExposed: false
    },
    ...value
  };
}

function hcnActionSessionBinding() {
  return hcnSessionDerivedHash("pending-action-plan:v1");
}

function hcnActionReceiptPrincipalRef() {
  const context = currentRequestAuthentication();
  const googleSubject = String(context?.hcnSession?.googleSubject || "");
  if (
    context?.authenticationMethod !== "hcn_cookie"
    || !context.hcnSessionId
    || !googleSubject
  ) {
    const error = new Error(
      "Chance HCN browser session authentication is required."
    );
    error.statusCode = 403;
    throw error;
  }
  const references = HCN_REFERENCE_CONFIGURATION.requireFactory();
  const stableOperatorRef = references.sourceRecordRef(
    "hcn_operator",
    googleSubject
  );
  return `principal_${createHash("sha256")
    .update("hcn-console:durable-receipt-principal:v2", "utf8")
    .update("\0", "utf8")
    .update(references.tenantId, "utf8")
    .update("\0", "utf8")
    .update(stableOperatorRef, "utf8")
    .digest("hex")}`;
}

function hcnSessionDerivedHash(domain) {
  const context = currentRequestAuthentication();
  const sessionId = String(context?.hcnSessionId || "");
  if (
    context?.authenticationMethod !== "hcn_cookie"
    || !sessionId
  ) {
    const error = new Error(
      "Chance HCN browser session authentication is required."
    );
    error.statusCode = 403;
    throw error;
  }
  return createHash("sha256")
    .update(`hcn-console:${domain}`, "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .digest("hex");
}

async function withHcnActionAdmission(
  controller,
  callback,
  { exclusiveSession = false, globalExecution = false } = {}
) {
  const sessionBinding = hcnActionSessionBinding();
  const release = controller.enter(sessionBinding);
  let ownsSession = false;
  let ownsGlobalExecution = false;
  try {
    if (exclusiveSession) {
      if (HCN_ACTION_SESSION_IN_FLIGHT.has(sessionBinding)) {
        const error = new Error(
          "HCN action capacity is temporarily unavailable for this session."
        );
        error.statusCode = 429;
        error.retryAfterSeconds = 1;
        throw error;
      }
      HCN_ACTION_SESSION_IN_FLIGHT.add(sessionBinding);
      ownsSession = true;
    }
    if (globalExecution) {
      if (hcnActionExecutionInFlight) {
        const error = new Error(
          "HCN action execution capacity is temporarily unavailable."
        );
        error.statusCode = 429;
        error.retryAfterSeconds = 1;
        throw error;
      }
      hcnActionExecutionInFlight = true;
      ownsGlobalExecution = true;
    }
    return await callback();
  } finally {
    if (ownsGlobalExecution) hcnActionExecutionInFlight = false;
    if (ownsSession) HCN_ACTION_SESSION_IN_FLIGHT.delete(sessionBinding);
    release();
  }
}

function hcnActionReceiptIndex() {
  if (hcnActionReceiptIndexInstance) return hcnActionReceiptIndexInstance;
  try {
    hcnActionReceiptIndexInstance = createHcnActionReceiptIndex({
      filePath: HCN_ACTION_RECEIPT_STORE_PATH
    });
    return hcnActionReceiptIndexInstance;
  } catch {
    const error = new Error(
      "The durable HCN action receipt service is unavailable."
    );
    error.statusCode = 503;
    throw error;
  }
}

async function resolveHcnActionScope({ fileRef, taskRefs = [] } = {}) {
  const references = HCN_REFERENCE_CONFIGURATION.requireFactory();
  let page;
  try {
    page = await hcnCachedContactIndex({ maxRecords: 5000 });
  } catch {
    throw hcnActionScopeUnavailable();
  }
  if (!page?.complete || !Array.isArray(page.rows)) {
    throw hcnActionScopeUnavailable();
  }
  const matches = page.rows.filter((contact) => {
    const id = String(contact?.jnid || contact?.id || "");
    return Boolean(
      id
      && isInsuranceFile(contact)
      && assignedTo(contact, CHANCE_OWNER_ID)
      && hcnContactIsExplicitlyActive(contact)
      && references.subjectId("jobnimbus", id) === fileRef
    );
  });
  if (matches.length !== 1) throw hcnActionScopeChanged();
  const providerJobId = String(
    matches[0].jnid || matches[0].id || ""
  );
  let contact;
  try {
    contact = await hcnCachedContact(providerJobId);
  } catch {
    throw hcnActionScopeUnavailable();
  }
  if (
    String(contact?.jnid || contact?.id || "") !== providerJobId
    || !isInsuranceFile(contact)
    || !assignedTo(contact, CHANCE_OWNER_ID)
    || !hcnContactIsExplicitlyActive(contact)
    || references.subjectId("jobnimbus", providerJobId) !== fileRef
  ) {
    throw hcnActionScopeChanged();
  }

  const uniqueTaskRefs = [...new Set(taskRefs)];
  if (uniqueTaskRefs.length !== taskRefs.length) {
    throw new HcnBrowserActionContractError(
      "duplicate_task_action",
      400,
      "A task may be updated only once in an exact HCN action plan."
    );
  }
  const providerTaskIds = new Map();
  if (uniqueTaskRefs.length) {
    let taskPage;
    try {
      taskPage = await listHcnResourceComplete("/tasks", {
        maxRecords: 500,
        relatedContactId: providerJobId
      });
    } catch {
      throw hcnActionScopeUnavailable();
    }
    if (!taskPage.complete) throw hcnActionScopeUnavailable();
    for (const taskRef of uniqueTaskRefs) {
      const taskMatches = taskPage.rows.filter((task) => {
        const id = String(task?.jnid || task?.id || "");
        const recordType = String(
          task?.record_type_name || task?.type_name || task?.type || ""
        ).trim().toLowerCase();
        return Boolean(
          id
          && recordType === "task"
          && referencesContact(task, providerJobId)
          && references.sourceRecordRef("jobnimbus", id) === taskRef
        );
      });
      if (taskMatches.length !== 1) throw hcnActionScopeChanged();
      providerTaskIds.set(
        taskRef,
        String(taskMatches[0].jnid || taskMatches[0].id)
      );
    }
  }

  const compact = compactContact(contact);
  const rawLabel = `${compact.number || ""} ${compact.name || ""}`
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fileDisplayLabel = [...(rawLabel || "Selected HCN file")]
    .slice(0, 256)
    .join("");
  const fileScopeBinding = createHash("sha256")
    .update("hcn-console:action-file-scope:v1", "utf8")
    .update("\0", "utf8")
    .update(fileRef, "utf8")
    .update("\0", "utf8")
    .update(providerJobId, "utf8")
    .update("\0", "utf8")
    .update(
      [...providerTaskIds.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([taskRef, providerTaskId]) => `${taskRef}:${providerTaskId}`)
        .join("|"),
      "utf8"
    )
    .digest("hex");
  return {
    fileRef,
    providerJobId,
    providerTaskIds,
    fileDisplayLabel,
    fileScopeBinding
  };
}

function hcnTaskRefsFromPrepareInput(input) {
  return input.operations
    .filter((operation) => operation.type === "jobnimbus.update_task")
    .map((operation) => operation.input.taskRef);
}

function hcnTaskRefsFromPresentation(operations) {
  if (!Array.isArray(operations)) throw hcnActionScopeChanged();
  return operations
    .filter((operation) => operation?.type === "jobnimbus.update_task")
    .map((operation) => String(operation?.material?.taskRef || ""))
    .filter(Boolean);
}

function assertHcnActionOperationConflicts(operations) {
  for (const singletonType of [
    "jobnimbus.update_status",
    "jobnimbus.update_contact"
  ]) {
    if (
      operations.filter((operation) => operation.type === singletonType)
        .length > 1
    ) {
      throw new HcnBrowserActionContractError(
        "conflicting_actions",
        400,
        "An exact HCN plan may contain only one status or date-of-loss change."
      );
    }
  }
}

function hcnActionScopeUnavailable() {
  return new HcnBrowserActionContractError(
    "fresh_scope_unavailable",
    503,
    "Fresh JobNimbus action scope is unavailable. Nothing was executed."
  );
}

function hcnActionScopeChanged() {
  return new HcnBrowserActionContractError(
    "file_scope_changed",
    409,
    "The selected HCN file or task scope changed. Prepare and review a fresh plan."
  );
}

function hcnPublicActionError(error, stage) {
  if (
    error
    && [
      "HcnBrowserActionContractError",
      "HcnPendingActionPlanError",
      "HcnActionReceiptIndexError"
    ].includes(error.name)
  ) {
    return error;
  }
  const safe = new Error(
    stage === "prepare"
      ? "The action plan could not be prepared from fresh JobNimbus evidence."
      : "The HCN action request could not be completed."
  );
  safe.statusCode = [502, 503, 504].includes(Number(error?.statusCode))
    ? 503
    : 409;
  return safe;
}

function hcnExecutionOutcome(result, operationCount) {
  const batchStatus = String(result?.batch?.status || "");
  if (result?.mode === "blocked_duplicate") {
    const completedCount = hcnValidatedCompletedBatchCount(
      result?.batch,
      operationCount
    );
    if (
      batchStatus === "completed"
      && completedCount === operationCount
    ) {
      return {
        status: "blocked_duplicate",
        succeededCount: 0,
        failedCount: 0,
        blockedCount: operationCount,
        unknownCount: 0
      };
    }
    if (
      batchStatus === "completed_pending_verification"
      && completedCount === operationCount
    ) {
      return {
        status: "completed_pending_verification",
        succeededCount: operationCount,
        failedCount: 0,
        blockedCount: 0,
        unknownCount: 0
      };
    }
    const succeededCount = Number.isInteger(completedCount)
      ? completedCount
      : 0;
    return {
      status: "reconciliation_required",
      succeededCount,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: operationCount - succeededCount
    };
  }
  if (batchStatus === "completed") {
    return {
      status: "executed",
      succeededCount: operationCount,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: 0
    };
  }
  if (batchStatus === "completed_pending_verification") {
    return {
      status: "completed_pending_verification",
      succeededCount: operationCount,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: 0
    };
  }
  const succeededCount = Math.min(
    operationCount,
    Array.isArray(result?.batch?.completed)
      ? result.batch.completed.length
      : 0
  );
  return {
    status: "reconciliation_required",
    succeededCount,
    failedCount: 0,
    blockedCount: 0,
    unknownCount: operationCount - succeededCount
  };
}

function hcnValidatedCompletedBatchCount(batch, operationCount) {
  if (
    !batch
    || typeof batch !== "object"
    || Array.isArray(batch)
    || batch.operationCount !== operationCount
    || !Array.isArray(batch.completed)
    || batch.completed.length > operationCount
  ) {
    return null;
  }
  for (let index = 0; index < batch.completed.length; index += 1) {
    const completed = batch.completed[index];
    if (
      !completed
      || typeof completed !== "object"
      || Array.isArray(completed)
      || completed.index !== index
      || completed.status !== "executed"
      || !HCN_BROWSER_ACTION_TYPES.includes(completed.type)
    ) {
      return null;
    }
  }
  return batch.completed.length;
}

function hcnPendingExecutionResult(outcome) {
  if (outcome.status === "executed") {
    return {
      mode: "executed",
      batch: {
        status: "completed",
        operationCount: outcome.succeededCount
      }
    };
  }
  if (outcome.status === "completed_pending_verification") {
    return {
      mode: "completed_pending_verification",
      batch: {
        status: "completed_pending_verification",
        operationCount: outcome.succeededCount
      }
    };
  }
  return {
    mode: outcome.status,
    reason:
      outcome.status === "blocked_duplicate"
        ? "The exact approved batch was already reserved and was not repeated."
        : "The provider outcome requires reconciliation from fresh evidence."
  };
}

function reconcileHcnExecution({
  receiptIndex,
  executingReceipt,
  execution,
  sessionBinding,
  sessionPrincipalRef,
  succeededCount
}) {
  let receipt;
  try {
    receipt = receiptIndex.transition({
      sessionPrincipalRef,
      fileRef: execution.fileRef,
      planId: execution.planId,
      digest: execution.approvalDigest,
      batchRef: executingReceipt.batchRef,
      status: "reconciliation_required",
      succeededCount,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: Math.max(0, execution.operationCount - succeededCount)
    });
  } catch {
    HCN_PENDING_ACTION_PLANS.recoverExecution({
      sessionBinding,
      planId: execution.planId,
      reason:
        "The provider outcome and durable receipt both require reconciliation."
    });
    const error = new Error(
      "The HCN execution outcome requires reconciliation."
    );
    error.statusCode = 503;
    throw error;
  }
  const plan = HCN_PENDING_ACTION_PLANS.finishExecution({
    sessionBinding,
    planId: execution.planId,
    result: {
      mode: "reconciliation_required",
      reason:
        "The provider outcome is uncertain. Review fresh JobNimbus evidence before any new action."
    }
  });
  return hcnActionEnvelope({ plan, receipt });
}

function assertChanceHcnReadSession() {
  const context = currentRequestAuthentication();
  const identity = currentRequestIdentity();
  if (
    context?.authenticationMethod !== "hcn_cookie"
    || identity?.type !== "hcn_browser_session"
    || identity.role !== "chance"
    || String(context.hcnSession?.subject || "").trim().toLowerCase()
      !== CHANCE_GOOGLE_EMAIL
  ) {
    const error = new Error(
      "Chance HCN browser session authentication is required."
    );
    error.statusCode = 403;
    throw error;
  }
}

function hcnConsoleFreshReadConfigured() {
  return Boolean(
    API_KEY
    && HCN_REFERENCE_CONFIGURATION.ready === true
  );
}

async function withHcnReadAdmission(callback) {
  const context = currentRequestAuthentication();
  const sessionId = String(context?.hcnSessionId || "");
  if (!sessionId) {
    const error = new Error(
      "Chance HCN browser session authentication is required."
    );
    error.statusCode = 403;
    throw error;
  }
  const sessionBinding = createHash("sha256")
    .update("hcn-console:fresh-read:session:v1", "utf8")
    .update("\0", "utf8")
    .update(sessionId, "utf8")
    .digest("hex");
  const release = HCN_CONSOLE_READ_ADMISSION.enter(sessionBinding);
  try {
    return await callback();
  } finally {
    release();
  }
}

function hcnConsoleFreshReadService() {
  if (!API_KEY) {
    const error = new Error("Fresh JobNimbus evidence is unavailable.");
    error.statusCode = 503;
    throw error;
  }
  if (!hcnConsoleFreshReadServiceInstance) {
    hcnConsoleFreshReadServiceInstance = createHcnConsoleFreshReadService({
      referenceFactory: HCN_REFERENCE_CONFIGURATION.requireFactory(),
      loadJobNimbusIndex: loadHcnJobNimbusIndex,
      loadJobNimbusFile: loadHcnJobNimbusFile,
      loadGmailFile: loadHcnGmailFile,
      loadQuoFile: loadHcnQuoFile
    });
  }
  return hcnConsoleFreshReadServiceInstance;
}

function brainContext(input = {}) {
  const maxPerSection = clamp(Number(input.maxPerSection || 25), 1, 25);
  return {
    generatedAt: new Date().toISOString(),
    scope: "company_only",
    authority: "verified records guide review; candidates are quarantined; live JobNimbus/Gmail/Quo evidence always wins",
    execution: "none",
    context: renderBrain(
      MEMORY_CONFIG,
      { maxPerSection, clientLane: "none", includeEpisodes: false }
    )
  };
}

function reviewBrainContext(subjectKey = "", maxPerSection = 25) {
  const scoped = Boolean(subjectKey);
  return {
    scope: scoped ? "company_and_exact_file" : "company_only",
    subjectKey: scoped ? subjectKey : "",
    authority: "Verified company rules guide review. Client snapshots provide continuity only. Live evidence wins and explicit approval is required for every action.",
    execution: "none",
    context: renderBrain(MEMORY_CONFIG, {
      maxPerSection: clamp(Number(maxPerSection || 25), 1, 25),
      clientLane: scoped ? "subject" : "none",
      subjectKey: scoped ? subjectKey : "",
      includeEpisodes: scoped
    })
  };
}

function clientMemoryEnvelope(snapshot) {
  return {
    snapshot: summarizeFileSnapshot(snapshot),
    authority: "Private read-through continuity only. Fresh source evidence wins. This snapshot never authorizes a write, send, call, task, event, upload, or status change."
  };
}

function isCodexOperatorRequest() {
  return currentRequestIdentity()?.type === "codex_operator_token";
}

function isMacCodexOperatorRequest() {
  const identity = currentRequestIdentity();
  return identity?.type === "codex_operator_token"
    && identity.subject === "codex-mac-operator";
}

function currentOperatorScope() {
  return currentRequestAuthentication()?.operatorScope === "company"
    ? "company"
    : "assigned";
}

function operatorCompanyScopeActive() {
  return isMacCodexOperatorRequest() && currentOperatorScope() === "company";
}

function operatorFileScopeLabel() {
  return operatorCompanyScopeActive()
    ? "explicit_company_file"
    : "chance_assigned_file";
}

function operatorFileDescription() {
  return operatorCompanyScopeActive()
    ? "explicit company insurance file"
    : "Chance-assigned file";
}

function operatorShortFileDescription() {
  return operatorCompanyScopeActive() ? "company file" : "Chance file";
}

function isHcnRestrictedEffectRequest() {
  return currentRequestAuthentication()?.hcnRestrictedEffects === true;
}

function isRestrictedEffectRequest() {
  return isCodexOperatorRequest() || isHcnRestrictedEffectRequest();
}

async function withHcnRestrictedEffects(callback) {
  const context = currentRequestAuthentication();
  if (
    typeof callback !== "function"
    || context?.authenticationMethod !== "hcn_cookie"
    || !context.hcnSessionId
  ) {
    const error = new Error(
      "Chance HCN browser session authentication is required."
    );
    error.statusCode = 403;
    throw error;
  }
  return REQUEST_CONTEXT.run(
    {
      ...context,
      hcnRestrictedEffects: true
    },
    callback
  );
}

function operatorBrainBoundary() {
  return {
    status: "not_read",
    scope: "disabled_for_codex_operator",
    persistedClientMemory: false,
    authority: "The Codex operator does not read or write Chance Brain client snapshots, episodes, receipts, or operational state. Fresh, exact-file source evidence is authoritative."
  };
}

function operatorEphemeralContinuity(file, sourceStatus = {}, counts = {}) {
  return {
    persistence: "disabled_for_codex_operator",
    persisted: false,
    existingClientMemoryRead: false,
    snapshot: {
      schemaVersion: 2,
      ephemeral: true,
      observedAt: new Date().toISOString(),
      file: cleanObject({
        id: file?.id || "",
        number: file?.number || "",
        name: file?.name || "",
        status: file?.status || ""
      }),
      sourceStatus: cleanObject(sourceStatus),
      counts: cleanObject(counts)
    },
    authority: "Ephemeral continuity metadata only. It is not persisted to Chance Brain and never authorizes an action."
  };
}

function operatorMemoryCloseoutBoundary() {
  return {
    recorded: false,
    reason: "operator_privacy_boundary",
    authority: "The external action security ledger remains authoritative; no client receipt, free text, or source evidence was written to Chance Brain."
  };
}

async function memoryFileActions(input = {}) {
  const query = required(input.query, "query");
  const limit = clamp(Number(input.limit || 20), 1, 100);
  const { contact } = await findChanceContact(query);
  const file = compactContact(contact);
  const receipts = latestActionReceipts(MEMORY_CONFIG, limit, { subjectKey: file.id });
  const clientSnapshot = summarizeFileSnapshot(readFileSnapshot(MEMORY_CONFIG, file.id));
  const operational = operationalState(MEMORY_CONFIG, file.id);
  const claimCallLedger = (await readClaimCallLedger())
    .filter((row) => row.contactId === file.id || String(row.fileNumber || "") === String(file.number || ""))
    .slice(-limit)
    .reverse();
  return {
    generatedAt: new Date().toISOString(),
    file,
    subjectKey: file.id,
    clientMemory: {
      snapshot: clientSnapshot,
      authority: "Continuity only. Live evidence wins and explicit approval is still required for every action."
    },
    operational,
    references: buildFileReferenceRegistry(file, receipts, claimCallLedger),
    receipts,
    claimCalls: claimCallLedger.map((row) => cleanObject({
      callId: row.callId,
      callStatus: row.callStatus,
      goal: row.goal,
      createdAt: row.createdAt,
      retryOfCallId: row.retryOfCallId,
      writebackAt: row.writebackAt
    })),
    context: renderBrain(MEMORY_CONFIG, {
      maxPerSection: clamp(Number(input.maxPerSection || 15), 1, 25),
      clientLane: "subject",
      subjectKey: file.id,
      includeEpisodes: true
    }),
    authority: "Receipts prove past execution only. Re-read live evidence before proposing the next action."
  };
}

function buildFileReferenceRegistry(file, receipts, claimCalls) {
  const references = [];
  for (const receipt of receipts) {
    if (!receipt.externalId) continue;
    references.push(cleanObject({
      source: receipt.channel,
      kind: receipt.action,
      id: receipt.externalId,
      at: receipt.at,
      status: receipt.status,
      summary: receipt.summary,
      origin: "action_receipt"
    }));
  }
  for (const call of claimCalls) {
    if (!call.callId) continue;
    references.push(cleanObject({
      source: "retell",
      kind: "claim_call",
      id: call.callId,
      at: call.createdAt,
      status: call.callStatus,
      summary: `Retell claim call for JobNimbus #${file.number || file.id}.`,
      origin: "claim_call_ledger"
    }));
  }
  const deduped = new Map();
  for (const reference of references) {
    const key = `${reference.source}:${reference.id}`;
    const prior = deduped.get(key);
    if (!prior || String(reference.at || "") > String(prior.at || "")) deduped.set(key, reference);
  }
  return [...deduped.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

function memoryPersistenceCheck(input = {}) {
  const label = String(input.label || "render-disk-check").trim().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "render-disk-check";
  const subjectKey = `persistence:${label}`;
  if (input.execute !== true) {
    return {
      mode: "read_only",
      subjectKey,
      receipts: latestActionReceipts(MEMORY_CONFIG, 20, { subjectKey }),
      instruction: "Set execute:true only for an approved persistence probe. No external system is contacted."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true to record a persistence probe.");
  const marker = randomUUID();
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
    channel: "bridge",
    action: "persistence_probe",
    status: "recorded",
    subjectKey,
    fileLabel: label,
    summary: `Recorded approved Render persistence probe ${label}.`,
    externalId: marker,
    evidence: [`probe:${marker}`]
  });
  return { mode: "recorded", marker, subjectKey, memoryCloseout };
}

function openapi() {
  return { ...OPENAPI, servers: [{ url: PUBLIC_BASE_URL }] };
}

const CHATGPT_ACTION_PATHS = [
  "/auth/whoami",
  "/auth/quo-line",
  "/brain/context",
  "/memory/file-actions",
  "/ops/start-session",
  "/ops/recover-scheduling-communications",
  "/ops/review-chance-files",
  "/ops/action-batch",
  "/scheduling/availability",
  "/jobnimbus/search",
  "/jobnimbus/document-review",
  "/jobnimbus/document-file",
  "/jobnimbus/photo-review",
  "/weather/dol-research",
  "/jobnimbus/upload-file",
  "/gmail/search",
  "/gmail/thread",
  "/gmail/attachment-review",
  "/quo/history",
  "/quo/transcript",
  "/claim-filing/prepare",
  "/claim-filing/call",
  "/claim-filing/result",
  "/claim-filing/callbacks",
  "/claim-filing/writeback",
  "/retell/client-coordinator-call",
  "/retell/client-coordinator-call-result",
  "/retell/configure-carrier-follow-up",
  "/retell/carrier-follow-up-call",
  "/retell/carrier-follow-up-call-result"
];

function chatgptOpenapi() {
  const googleOAuth = {
    type: "oauth2",
    flows: {
      authorizationCode: {
        authorizationUrl: `${PUBLIC_BASE_URL}/oauth/authorize`,
        tokenUrl: `${PUBLIC_BASE_URL}/oauth/token`,
        scopes: {
          openid: "Verify the signed-in employee identity.",
          email: "Verify the signed-in employee email address.",
          profile: "Read the signed-in employee display name.",
          "https://www.googleapis.com/auth/gmail.modify": "Search, draft, send, and manage the signed-in employee Gmail account through approval-gated bridge actions.",
          "https://www.googleapis.com/auth/calendar.readonly": "Read the signed-in employee calendar for availability checks."
        }
      }
    }
  };
  return {
    ...OPENAPI,
    info: {
      ...OPENAPI.info,
      title: "Chance JobNimbus Ops Assistant",
      description: "Consolidated 30-operation workflow schema for role-aware HCN/Wave Custom GPTs. Employee identity comes from approved Google OAuth or the temporary Chance bridge-token fallback. All external writes and calls remain exact and approval-gated."
    },
    servers: [{ url: PUBLIC_BASE_URL }],
    security: [{ googleOAuth: [] }],
    components: {
      ...OPENAPI.components,
      securitySchemes: { googleOAuth }
    },
    paths: Object.fromEntries(CHATGPT_ACTION_PATHS.map((routePath) => [routePath, OPENAPI.paths[routePath]]))
  };
}

function privacy() {
  return [
    "JobNimbus ChatGPT Bridge Privacy Policy",
    "",
    "This private bridge is used by Chance Pearson to connect ChatGPT to JobNimbus operations data.",
    "It does not sell or share data.",
    "Requests are authenticated before JobNimbus data is accessed.",
    "The bridge passes user-authorized requests to JobNimbus and returns the response to ChatGPT.",
    "JobNimbus API keys and bridge tokens are stored as Render environment variables and are not exposed by this page."
  ].join("\n");
}

function voiceTwiml() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXml(voiceStreamUrl())}" />`,
    "  </Connect>",
    "</Response>"
  ].join("");
}

async function outboundVoiceCall(input) {
  const to = normalizePhone(input.to || TWILIO_VERIFIED_TEST_NUMBER);
  const from = normalizePhone(input.from || TWILIO_FROM_NUMBER);
  const goal = String(input.goal || "general_call").trim();
  const prompt = String(input.prompt || "").trim();
  const voice = normalizeRealtimeVoice(input.voice || OPENAI_VOICE);
  const callId = randomUUID();
  const execute = input.execute === true;
  const streamUrl = voiceStreamUrlWithContext({ goal, prompt, voice, callId });

  const plan = {
    from,
    to,
    streamUrl,
    goal,
    voice,
    callId,
    prompt: prompt ? "[set]" : "(not set)",
    execute,
    requirements: {
      twilioAccountSid: Boolean(TWILIO_ACCOUNT_SID),
      twilioAuthToken: Boolean(TWILIO_AUTH_TOKEN),
      openaiApiKey: Boolean(OPENAI_API_KEY),
      fromNumber: Boolean(from),
      toNumber: Boolean(to),
      publicWssStreamUrl: /^wss:\/\//i.test(streamUrl),
      allowVoiceCalls: ALLOW_VOICE_CALLS
    }
  };

  const missing = Object.entries(plan.requirements)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  if (!execute) {
    return {
      mode: "dry_run",
      plan,
      instruction: "This did not place a call. Set execute:true only after user approval."
    };
  }

  if (missing.length) {
    return {
      mode: "blocked",
      plan,
      missing,
      reason: "Realtime voice calls require Twilio credentials, OpenAI credentials, ALLOW_VOICE_CALLS=true, and a public wss:// stream URL."
    };
  }

  initVoiceCallLog(callId, { to, from, goal, prompt, voice });
  const result = await createTwilioRealtimeCall({ to, from, streamUrl, goal, prompt });
  const log = voiceCallLogs.get(callId);
  if (log) {
    log.twilioCallSid = result.sid;
    log.status = result.status || "created";
    log.updatedAt = new Date().toISOString();
  }
  return {
    mode: "executed",
    call: {
      callId,
      sid: result.sid,
      status: result.status,
      to: result.to,
      from: result.from,
      direction: result.direction
    }
  };
}

async function voiceTranscript(input) {
  const id = String(input.callId || input.sid || input.twilioCallSid || "").trim();
  if (!id) badRequest("callId or sid is required");
  const log = voiceCallLogs.get(id) || Array.from(voiceCallLogs.values()).find((item) => item.twilioCallSid === id);
  if (!log) {
    return {
      found: false,
      id,
      message: "No transcript found. Render memory may have restarted, or the call may not have connected to the media stream."
    };
  }
  return {
    found: true,
    call: summarizeVoiceCallLog(log),
    turns: log.turns,
    transcript: log.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n")
  };
}

async function voiceTranscripts(input = {}) {
  const limit = clamp(Number(input.limit || 10), 1, 50);
  const status = String(input.status || "").trim().toLowerCase();
  const calls = Array.from(voiceCallLogs.values())
    .filter((log) => !status || String(log.status || "").toLowerCase() === status)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, limit)
    .map((log) => ({
      call: summarizeVoiceCallLog(log),
      transcript: log.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"),
      turns: log.turns
    }));
  return {
    count: calls.length,
    calls
  };
}

function handoffPage() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JobNimbus Handoff Inbox</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101114; color: #f4f4f5; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 18px 48px; }
    h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: 0; }
    p { color: #c7c9d1; line-height: 1.45; }
    label { display: block; margin: 18px 0 8px; color: #d9dbe3; font-weight: 600; }
    input, textarea, button { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #3a3d46; background: #17191f; color: #f4f4f5; font: inherit; }
    input { padding: 12px; }
    textarea { min-height: 330px; padding: 12px; resize: vertical; }
    button { margin-top: 16px; padding: 12px 14px; background: #2f6fed; border-color: #2f6fed; cursor: pointer; font-weight: 700; }
    button.secondary { background: #242732; border-color: #3a3d46; }
    pre { white-space: pre-wrap; background: #17191f; border: 1px solid #30333d; padding: 14px; border-radius: 8px; min-height: 48px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 720px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>JobNimbus Handoff Inbox</h1>
    <p>Paste Gmail/Quo findings from another ChatGPT chat here. The JobNimbus assistant can then read the pending handoffs and turn them into approval-ready actions.</p>

    <label for="token">Bridge Token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Optional for submitting; required to load pending">

    <div class="row">
      <div>
        <label for="source">Source</label>
        <input id="source" value="regular-chat" placeholder="regular-chat, gmail, quo">
      </div>
      <div>
        <label for="client">Client/File</label>
        <input id="client" placeholder="Optional client name, job number, claim number">
      </div>
    </div>

    <label for="payload">Handoff Text or JSON</label>
    <input id="payloadFile" type="file" accept=".json,.txt,application/json,text/plain">
    <textarea id="payload" placeholder='Example: {"client":"Rosa Sanchez","summary":"Adjuster replied...","recommendedActions":["Send LOR"],"needsApproval":true}'></textarea>

    <button id="submit">Submit Handoff</button>
    <button class="secondary" id="pending">Load Pending</button>

    <label for="result">Result</label>
    <pre id="result"></pre>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    function headers() {
      const token = $("token").value.trim();
      return token
        ? { "content-type": "application/json", "authorization": "Bearer " + token }
        : { "content-type": "application/json" };
    }
    function parsePayload(text) {
      try { return JSON.parse(text); } catch { return { text }; }
    }
    $("payloadFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      $("payload").value = await file.text();
    });
    $("submit").addEventListener("click", async () => {
      $("result").textContent = "Submitting...";
      const source = $("source").value.trim() || "regular-chat";
      const client = $("client").value.trim();
      const payloadText = $("payload").value.trim();
      if (payloadText.length > 700000) {
        let uploadId = "";
        const chunkSize = 450000;
        const total = Math.ceil(payloadText.length / chunkSize);
        for (let index = 0; index < total; index += 1) {
          const chunk = payloadText.slice(index * chunkSize, (index + 1) * chunkSize);
          const res = await fetch("/handoff/chunk", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ uploadId, source, client, index, total, chunk })
          });
          const result = await res.json();
          $("result").textContent = JSON.stringify(result, null, 2);
          if (!res.ok) return;
          uploadId = result.uploadId;
        }
        return;
      }
      const body = { source, client, payload: parsePayload(payloadText) };
      const res = await fetch("/handoff", { method: "POST", headers: headers(), body: JSON.stringify(body) });
      $("result").textContent = JSON.stringify(await res.json(), null, 2);
    });
    $("pending").addEventListener("click", async () => {
      $("result").textContent = "Loading...";
      const res = await fetch("/handoff/pending", { method: "POST", headers: headers(), body: JSON.stringify({ limit: 25 }) });
      $("result").textContent = JSON.stringify(await res.json(), null, 2);
    });
  </script>
</body>
</html>`;
  return { html };
}

async function createHandoff(input) {
  const handoffs = await readHandoffStore();
  const payload = normalizeHandoffPayload(input);
  const handoff = {
    id: randomUUID(),
    status: "pending",
    source: payload.source,
    client: payload.client,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: "",
    payload: payload.payload,
    assistantRead: buildHandoffAssistantRead(payload)
  };
  handoffs.unshift(handoff);
  await writeHandoffStore(handoffs);
  return { created: true, handoff };
}

async function createHandoffChunk(input) {
  const uploadId = normalizeUploadId(input.uploadId || randomUUID());
  const index = Number(input.index);
  const total = Number(input.total);
  const chunk = String(input.chunk ?? "");
  if (!Number.isInteger(index) || index < 0) badRequest("index must be a zero-based integer");
  if (!Number.isInteger(total) || total < 1 || total > 1000) badRequest("total must be between 1 and 1000");
  if (index >= total) badRequest("index must be less than total");
  if (!chunk) badRequest("chunk is required");

  const dir = path.join(HANDOFF_UPLOAD_DIR, uploadId);
  await mkdir(dir, { recursive: true });
  const metaPath = path.join(dir, "meta.json");
  const metadata = cleanObject({
    uploadId,
    source: String(input.source || "regular-chat").trim(),
    client: String(input.client || "").trim(),
    total,
    createdAt: new Date().toISOString()
  });
  if (index === 0) await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  await writeFile(path.join(dir, `${index}.part`), chunk);

  const received = (await readdir(dir)).filter((name) => name.endsWith(".part")).length;
  if (received < total) return { uploadId, complete: false, received, total };

  const savedMeta = await readJsonFile(metaPath, metadata);
  const chunks = [];
  for (let part = 0; part < total; part += 1) {
    chunks.push(await readFile(path.join(dir, `${part}.part`), "utf8"));
  }
  const raw = chunks.join("");
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  const handoff = await createHandoff({
    source: savedMeta.source || metadata.source,
    client: savedMeta.client || metadata.client,
    ...(parsed && typeof parsed === "object" ? { payload: parsed } : { text: raw })
  });
  await rm(dir, { recursive: true, force: true });
  return { uploadId, complete: true, received, total, handoff };
}

async function pendingHandoffs(input = {}) {
  const limit = clamp(Number(input.limit || 25), 1, 100);
  const includeCompleted = input.includeCompleted === true;
  const clientQuery = normalizeCompare(input.client || input.query || "");
  const handoffs = await readHandoffStore();
  const matches = handoffs
    .filter((handoff) => includeCompleted || handoff.status !== "completed")
    .filter((handoff) => !clientQuery || normalizeCompare(`${handoff.client} ${JSON.stringify(handoff.payload)}`).includes(clientQuery))
    .slice(0, limit);
  return {
    count: matches.length,
    handoffs: matches,
    assistantRead: matches.map((handoff) => handoff.assistantRead).join("\n\n---\n\n")
  };
}

async function getHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const handoff = await findHandoffById(id);
  return { handoff, assistantRead: handoff.assistantRead };
}

async function processHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const handoff = await findHandoffById(id);
  const update = extractHandoffJobNimbusUpdate(handoff, input);
  if (!update) {
    return {
      mode: "no_action",
      handoff,
      error: "No jobNimbusUpdate payload found. Add payload.jobNimbusUpdate with query, fields, status, and/or note."
    };
  }
  const execute = input.execute === true || update.execute === true;
  const result = await processUpdate({ ...update, execute });
  if (execute && input.completeOnSuccess !== false) {
    const completionNote = String(input.completionNote || "Processed through processHandoff.").trim();
    await markHandoffComplete(handoff.id, completionNote);
  }
  return {
    mode: execute ? "executed" : "dry_run",
    handoff,
    result
  };
}

async function completeHandoff(input) {
  const id = required(input.id || input.handoffId, "id");
  const completionNote = String(input.completionNote || input.note || "").trim();
  const handoff = await markHandoffComplete(id, completionNote);
  return { completed: true, handoff };
}

async function createArtifactChunk(input) {
  if (!BRIDGE_TOKEN) badRequest("Artifact mailbox requires JOBNIMBUS_BRIDGE_TOKEN to be configured.");
  const uploadId = normalizeUploadId(input.uploadId || randomUUID());
  const index = Number(input.index);
  const total = Number(input.total);
  const chunk = String(input.chunk ?? "");
  if (!Number.isInteger(index) || index < 0) badRequest("index must be a zero-based integer");
  if (!Number.isInteger(total) || total < 1 || total > 1000) badRequest("total must be between 1 and 1000");
  if (index >= total) badRequest("index must be less than total");
  if (!chunk) badRequest("chunk is required");

  const dir = path.join(ARTIFACT_UPLOAD_DIR, uploadId);
  const metaPath = path.join(dir, "meta.json");
  await mkdir(dir, { recursive: true });

  let metadata;
  if (index === 0) {
    metadata = {
      uploadId,
      filename: normalizeArtifactFilename(input.filename),
      source: String(input.source || "claude").trim().slice(0, 80),
      baseCommit: normalizeCommitSha(input.baseCommit),
      summary: String(input.summary || "").trim().slice(0, 1000),
      expectedSha256: normalizeSha256(input.sha256 || input.expectedSha256),
      total,
      createdAt: new Date().toISOString()
    };
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  } else {
    metadata = await readJsonFile(metaPath, null);
    if (!metadata) badRequest("Upload metadata is missing. Send chunk index 0 first.");
    if (metadata.total !== total) badRequest("total must match the first chunk");
  }

  await writeFile(path.join(dir, `${index}.part`), chunk, "utf8");
  const received = (await readdir(dir)).filter((name) => name.endsWith(".part")).length;
  if (received < total) {
    return { uploadId, complete: false, received, total, maxArtifactBytes: MAX_ARTIFACT_BYTES };
  }

  const chunks = [];
  for (let part = 0; part < total; part += 1) {
    chunks.push(await readFile(path.join(dir, `${part}.part`), "utf8"));
  }
  const content = chunks.join("");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_ARTIFACT_BYTES) {
    await rm(dir, { recursive: true, force: true });
    const error = new Error(`Artifact is too large. Limit is ${MAX_ARTIFACT_BYTES} bytes.`);
    error.statusCode = 413;
    throw error;
  }
  if (content.includes("\u0000")) badRequest("Artifact must be UTF-8 text without NUL bytes.");

  const policyViolations = artifactPolicyViolations(content);
  if (policyViolations.length) {
    await rm(dir, { recursive: true, force: true });
    badRequest(`Artifact rejected: ${policyViolations.join("; ")}`);
  }

  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (sha256 !== metadata.expectedSha256) {
    await rm(dir, { recursive: true, force: true });
    badRequest(`SHA-256 mismatch. Expected ${metadata.expectedSha256}, received ${sha256}.`);
  }

  const now = new Date();
  const artifact = {
    id: randomUUID(),
    status: "uploaded",
    filename: metadata.filename,
    source: metadata.source,
    baseCommit: metadata.baseCommit,
    summary: metadata.summary,
    sha256,
    sizeBytes,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ARTIFACT_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    completedAt: "",
    completionNote: ""
  };

  await mkdir(ARTIFACT_FILE_DIR, { recursive: true });
  await writeFile(artifactFilePath(artifact.id), content, "utf8");
  const artifacts = await readArtifactStore();
  artifacts.unshift(artifact);
  await writeArtifactStore(artifacts);
  await rm(dir, { recursive: true, force: true });

  return { uploadId, complete: true, received, total, artifact };
}

async function listArtifacts(input = {}) {
  const artifacts = await pruneExpiredArtifacts();
  const limit = clamp(Number(input.limit || 25), 1, 100);
  const includeCompleted = input.includeCompleted === true;
  const status = String(input.status || "").trim().toLowerCase();
  const matches = artifacts
    .filter((artifact) => includeCompleted || artifact.status !== "completed")
    .filter((artifact) => !status || artifact.status === status)
    .slice(0, limit);
  return { count: matches.length, artifacts: matches };
}

async function getArtifact(input) {
  const id = normalizeArtifactId(input.id || input.artifactId);
  const artifacts = await pruneExpiredArtifacts();
  const artifact = artifacts.find((row) => row.id === id);
  if (!artifact) badRequest(`No active artifact found for id: ${id}`);
  const content = await readFile(artifactFilePath(id), "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (sha256 !== artifact.sha256) {
    const error = new Error("Stored artifact checksum does not match metadata.");
    error.statusCode = 409;
    throw error;
  }
  return {
    artifact,
    ...(input.includeContent === false ? {} : { content })
  };
}

async function completeArtifact(input) {
  const id = normalizeArtifactId(input.id || input.artifactId);
  const artifacts = await pruneExpiredArtifacts();
  const artifact = artifacts.find((row) => row.id === id);
  if (!artifact) badRequest(`No active artifact found for id: ${id}`);
  artifact.status = "completed";
  artifact.updatedAt = new Date().toISOString();
  artifact.completedAt = artifact.updatedAt;
  artifact.completionNote = String(input.completionNote || input.note || "").trim().slice(0, 2000);
  await writeArtifactStore(artifacts);
  return { completed: true, artifact };
}

async function searchContacts(input) {
  const rawQuery = required(input.query, "query");
  const query = rawQuery.toLowerCase();
  if (isCodexOperatorRequest() && normalizeCompare(query).length < 3) {
    badRequest("The Codex operator search query is too broad. Use at least three identifying characters, a JobNimbus number, claim number, or exact address.");
  }
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 10) });
  const eligible = contacts
    .filter(isInsuranceFile)
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => (
      operatorCompanyScopeActive()
      || assignedTo(contact, CHANCE_OWNER_ID)
    ));
  const matches = eligible
    .filter((contact) => (
      operatorCompanyScopeActive()
        ? chanceMatchScore(contact, rawQuery) >= 85
        : contactMatches(contact, query)
    ))
    .sort((a, b) => (
      chanceMatchScore(b, rawQuery) - chanceMatchScore(a, rawQuery)
      || fileSort(a, b)
    ))
    .slice(0, limit);
  const compactMatches = matches.map((contact) => {
    const file = compactContact(contact);
    return isCodexOperatorRequest()
      ? {
          id: file.id,
          number: file.number,
          name: file.name,
          status: file.status
        }
      : file;
  });
  return {
    query,
    ...(isCodexOperatorRequest() ? { scope: operatorFileScopeLabel() } : {}),
    count: compactMatches.length,
    matches: compactMatches,
    contacts: compactMatches,
    jobs: []
  };
}

async function reviewFile(input) {
  const query = required(input.query, "query");
  const { contact, alternatives } = await findChanceContact(query);
  const operatorRequest = isCodexOperatorRequest();
  const evidenceInventoryLimit = operatorRequest ? 5000 : 1000;
  const activities = await listRelated(
    "/activities",
    contact.jnid,
    operatorRequest ? 5000 : 30
  );
  const tasks = await listRelated(
    "/tasks",
    contact.jnid,
    operatorRequest ? 5000 : 30
  );
  const documents = await listRelated(
    "/files",
    contact.jnid,
    evidenceInventoryLimit
  );
  const file = compactContact(contact);
  const sortedActivities = [...activities].sort(
    (a, b) => providerTimeMs(b.date_created) - providerTimeMs(a.date_created)
  );
  const openTasks = tasks
    .filter((task) => !providerFlagTrue(task.is_completed))
    .sort(
      (a, b) => providerTimeMs(a.date_start || a.date_end)
        - providerTimeMs(b.date_start || b.date_end)
    );
  const operationalDocuments = documents.filter(isOperationalDocumentMetadata);
  const actionReceipts = operatorRequest
    ? []
    : latestActionReceipts(MEMORY_CONFIG, 20, { subjectKey: file.id });
  const sourceStatus = {
    jobNimbus: { status: "fresh", at: new Date().toISOString() },
    gmail: { status: "not_requested", at: new Date().toISOString() },
    quo: { status: "not_requested", at: new Date().toISOString() }
  };
  const liveJobNimbus = {
    recentActivities: sortedActivities.slice(0, 30).map(compactActivity),
    openTasks: openTasks.slice(0, 30).map(compactTask),
    operationalDocuments: operationalDocuments.slice(0, 60).map(compactDocument),
    excludedPhotoLikeDocumentCount: documents.length - operationalDocuments.length,
    assistantRead: buildAssistantRead(contact, activities, tasks, operationalDocuments)
  };
  const snapshot = operatorRequest
    ? null
    : ALLOW_LEGACY_CLIENT_MEMORY_WRITES
      ? refreshFileSnapshot(MEMORY_CONFIG, {
        subjectKey: file.id,
        file,
        liveJobNimbus,
        gmail: { status: "not_requested", messages: [], threads: [] },
        quo: { status: "not_requested", timeline: [], transcripts: [] },
        actionReceipts,
        sourceStatus,
        factualSignals: buildFactualSignals(file, sortedActivities, openTasks, operationalDocuments, {}, {})
      })
      : readFileSnapshot(MEMORY_CONFIG, file.id, { quarantineCorrupt: false });
  const operational = operatorRequest
    ? operatorBrainBoundary()
    : ALLOW_LEGACY_CLIENT_MEMORY_WRITES
      ? reconcileOperationalState(MEMORY_CONFIG, snapshot)
      : operationalState(MEMORY_CONFIG, file.id, { quarantineCorrupt: false });
  return {
    file,
    ...(operatorRequest ? { scope: operatorFileScopeLabel() } : {}),
    rawContact: contact,
    recentActivities: liveJobNimbus.recentActivities,
    openTasks: liveJobNimbus.openTasks,
    documents: documents.map(compactDocument),
    operationalDocuments: liveJobNimbus.operationalDocuments,
    excludedPhotoLikeDocumentCount: liveJobNimbus.excludedPhotoLikeDocumentCount,
    alternatives: alternatives.map(compactContact),
    assistantRead: liveJobNimbus.assistantRead,
    actionReceipts,
    sourceStatus,
    clientMemory: operatorRequest
      ? operatorEphemeralContinuity(file, sourceStatus, {
          recentActivityCount: liveJobNimbus.recentActivities.length,
          openTaskCount: liveJobNimbus.openTasks.length,
          operationalDocumentCount: liveJobNimbus.operationalDocuments.length
        })
      : clientMemoryEnvelope(snapshot),
    operational,
    brain: operatorRequest ? operatorBrainBoundary() : reviewBrainContext(file.id, input.maxPerSection)
  };
}

async function assignedFiles(input = {}) {
  const ownerId = String(input.ownerId || "fc95a213f70e4c9daddc5fa366be9941").trim();
  const activeOnly = input.activeOnly !== false;
  const limit = clamp(Number(input.limit || 100), 1, 250);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const files = contacts
    .filter((contact) => isInsuranceFile(contact))
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => assignedTo(contact, ownerId))
    .filter((contact) => !activeOnly || isOpenActive(contact))
    .sort(fileSort)
    .slice(0, limit)
    .map(compactContact);
  return {
    ownerId,
    ownerName: ownerId === "fc95a213f70e4c9daddc5fa366be9941" ? "Chance Pearson" : "",
    activeOnly,
    count: files.length,
    files
  };
}

async function assignedCounts(input = {}) {
  const ownerId = String(input.ownerId || "fc95a213f70e4c9daddc5fa366be9941").trim();
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const assigned = contacts
    .filter((contact) => isInsuranceFile(contact))
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => assignedTo(contact, ownerId));
  const active = assigned.filter(isOpenActive);
  return {
    ownerId,
    ownerName: ownerId === "fc95a213f70e4c9daddc5fa366be9941" ? "Chance Pearson" : "",
    totalAssigned: assigned.length,
    activeAssigned: active.length,
    closedOrInactive: assigned.length - active.length,
    byStatus: countBy(active, (contact) => contact.status_name || "Unknown"),
    byCarrier: countBy(active, (contact) => fieldValue(contact, ["Insurance Company", "Carrier", "insurance_company", "cf_string_1"]) || "Unknown"),
    files: active.sort(fileSort).slice(0, clamp(Number(input.sampleLimit || 25), 1, 100)).map(compactContact)
  };
}

async function schedulingAvailability() {
  return collectUnifiedSchedulingAvailability();
}

async function collectUnifiedSchedulingAvailability() {
  const range = availabilityRange({
    timeZone: OPERATIONS_TIME_ZONE,
    horizonDays: SCHEDULING_HORIZON_DAYS
  });
  const [jobNimbusResult, googleResult] = await Promise.allSettled([
    loadChanceJobNimbusBusy(range),
    loadGoogleCalendarBusy(range)
  ]);
  const jobNimbusBusy = jobNimbusResult.status === "fulfilled" ? jobNimbusResult.value : [];
  const googleBusy = googleResult.status === "fulfilled" ? googleResult.value : [];
  const sources = [
    sourceStatus("jobnimbus", jobNimbusResult, jobNimbusBusy.length),
    sourceStatus("google_calendar", googleResult, googleBusy.length)
  ];

  return buildUnifiedAvailability({
    range,
    timeZone: OPERATIONS_TIME_ZONE,
    horizonDays: SCHEDULING_HORIZON_DAYS,
    durationMinutes: SCHEDULING_APPOINTMENT_MINUTES,
    bufferMinutes: SCHEDULING_TRAVEL_BUFFER_MINUTES,
    minLeadHours: SCHEDULING_MIN_LEAD_HOURS,
    workdayStart: SCHEDULING_WORKDAY_START,
    workdayEnd: SCHEDULING_WORKDAY_END,
    jobNimbusBusy,
    googleBusy,
    sources
  });
}

async function attachSchedulingAvailability(plan) {
  if (plan.packet.goal !== "inspection_scheduling") return plan;
  const availability = await collectUnifiedSchedulingAvailability();
  const availabilityDigest = digest({
    status: availability.status,
    range: availability.range,
    settings: availability.settings,
    sources: availability.sources.map(({ name, status, busyCount }) => ({ name, status, busyCount })),
    availableWindows: availability.availableWindows
  });
  applyAvailabilityDynamicVariables(plan.callPlan.dynamicVariables, availability);

  if (availability.status !== "READY") {
    plan.readiness.ready = false;
    plan.readiness.blockers = [...new Set([
      ...(plan.readiness.blockers || []),
      availability.reason
    ])];
  }

  plan.planDigest = digest({ basePlanDigest: plan.planDigest, availabilityDigest });
  plan.callPlan.metadata.planDigest = plan.planDigest;
  plan.callPlan.metadata.availabilityDigest = availabilityDigest;
  plan.schedulingAvailability = availability;
  return plan;
}

function applyAvailabilityDynamicVariables(dynamicVariables, availability) {
  dynamicVariables.availabilityStatus = availability.status;
  dynamicVariables.availableAppointmentWindows = availability.voiceWindows;
  dynamicVariables.availabilityTimeZone = OPERATIONS_TIME_ZONE;
  dynamicVariables.appointmentDurationMinutes = String(SCHEDULING_APPOINTMENT_MINUTES);
  dynamicVariables.availabilitySources = "JobNimbus calendar and Google Calendar";
  dynamicVariables.availabilityWindowsJson = JSON.stringify(availability.availableWindows || []);
}

async function loadChanceJobNimbusBusy(range) {
  const tasks = await listResourcePages("/tasks", 25);
  return busyIntervalsFromJobNimbusTasks(tasks, {
    ownerId: CHANCE_OWNER_ID,
    timeMin: range.timeMin,
    timeMax: range.timeMax,
    defaultDurationMinutes: 60
  });
}

async function loadGoogleCalendarBusy(range) {
  if (!googleAccessConfiguredForRequest()) {
    throw new Error("Google Calendar OAuth is not configured.");
  }
  const token = await getGoogleAccessToken();
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      timeZone: OPERATIONS_TIME_ZONE,
      items: [{ id: GOOGLE_CALENDAR_ID }]
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = json?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Google Calendar availability failed: ${reason}`);
  }
  const calendar = json?.calendars?.[GOOGLE_CALENDAR_ID] || {};
  if (Array.isArray(calendar.errors) && calendar.errors.length) {
    throw new Error(`Google Calendar availability failed: ${calendar.errors.map((row) => row.reason || row.domain || "unknown").join(", ")}`);
  }
  return (calendar.busy || []).map((row) => ({
    start: row.start,
    end: row.end,
    source: "google_calendar"
  }));
}

function sourceStatus(name, settled, busyCount) {
  return settled.status === "fulfilled"
    ? { name, status: "ready", busyCount }
    : { name, status: "blocked", busyCount: 0, error: String(settled.reason?.message || settled.reason || "unavailable").slice(0, 300) };
}

async function assertMacOperatorNormalWorkReady() {
  if (!isMacCodexOperatorRequest()) return;
  assertOperatorReceiptBoundaryReady();
  const boundary = await operatorRunPolicy();
  if (boundary?.ready === true) return;
  const error = new Error(
    "The locked Chance run-policy or receipt boundary is not ready. Review bridge_restart_verify before claim work."
  );
  error.statusCode = 409;
  throw error;
}

async function assertMacOperatorClaimPlanningReady() {
  if (!isMacCodexOperatorRequest()) return;
  await assertMacOperatorNormalWorkReady();
  const expiresAt = String(CHANCE_OPERATOR_RUN_MANIFEST?.expiresAt || "").trim();
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) return;
  const error = new Error(
    "The Chance operator run manifest expired. Refresh and review the 58-file roster before configuring, preparing, or placing a claim call."
  );
  error.statusCode = 409;
  throw error;
}

function claimFilingApprovalScope(file = {}) {
  const runPolicy = chanceOperatorRunManifestSummary(CHANCE_OPERATOR_RUN_MANIFEST);
  return {
    mode: "claim_filing_single_file_v1",
    runPolicyId: runPolicy.id || "",
    runPolicySha256: runPolicy.sha256 || "",
    runPolicyExpiresAt: runPolicy.expiresAt || "",
    fileCount: 1,
    files: [{
      id: String(file.id || ""),
      number: String(file.number || "").replace(/^#/, ""),
      operationIndexes: [0],
      operationTypes: ["retell.claim_filing_call"]
    }]
  };
}

function bindClaimCallApproval(plan, input = {}, attestation = null) {
  const sourcePlanDigest = String(plan?.planDigest || "");
  const retryOfCallId = String(input.retryOfCallId || "").trim();
  const agentVersion = Number.isInteger(Number(attestation?.agentVersion))
    ? Number(attestation.agentVersion)
    : null;
  const agentConfigDigest = String(attestation?.agentConfigDigest || "");
  const callbackPacketDigest = callbackDynamicVariablesDigest(plan?.callPlan?.dynamicVariables || {});
  const planDigest = digest({
    mode: "retell_claim_call_v1",
    sourcePlanDigest,
    retryOfCallId,
    agentId: String(plan?.callPlan?.agentId || ""),
    agentVersion,
    agentConfigDigest,
    callbackPacketDigest
  });
  return {
    ...plan,
    sourcePlanDigest,
    planDigest,
    retryOfCallId,
    agentVersion,
    agentConfigDigest,
    callbackPacketDigest,
    configurationAttested: Boolean(agentVersion !== null && agentConfigDigest),
    callPlan: {
      ...plan.callPlan,
      agentVersion,
      metadata: {
        ...(plan.callPlan?.metadata || {}),
        sourcePlanDigest,
        planDigest,
        retryOfCallId,
        agentVersion,
        agentConfigDigest,
        callbackPacketDigest
      }
    }
  };
}

function claimFilingToolAttestation(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => cleanObject({
    type: String(tool?.type || ""),
    name: String(tool?.name || ""),
    description: String(tool?.description || ""),
    url: String(tool?.url || ""),
    method: String(tool?.method || ""),
    timeout_ms: Number.isFinite(Number(tool?.timeout_ms)) ? Number(tool.timeout_ms) : undefined,
    delay_ms: Number.isFinite(Number(tool?.delay_ms)) ? Number(tool.delay_ms) : undefined,
    speak_during_execution: typeof tool?.speak_during_execution === "boolean"
      ? tool.speak_during_execution
      : undefined,
    speak_after_execution: typeof tool?.speak_after_execution === "boolean"
      ? tool.speak_after_execution
      : undefined,
    parameters: tool?.parameters && typeof tool.parameters === "object"
      ? tool.parameters
      : undefined,
    headerNames: tool?.headers && typeof tool.headers === "object"
      ? Object.keys(tool.headers).sort()
      : undefined,
    authorizationHeaderSha256: tool?.headers && typeof tool.headers === "object"
      && String(tool.headers.Authorization || tool.headers.authorization || "")
      ? digest(String(tool.headers.Authorization || tool.headers.authorization))
      : undefined
  }));
}

function claimFilingAnalysisAttestation(fields) {
  return (Array.isArray(fields) ? fields : []).map((field) => cleanObject({
    type: String(field?.type || ""),
    name: String(field?.name || ""),
    description: String(field?.description || ""),
    choices: Array.isArray(field?.choices) ? field.choices.map(String) : undefined
  }));
}

function expectedRetellClaimPhoneConfiguration() {
  return {
    phoneNumber: RETELL_FROM_NUMBER,
    // Retell falls back to this list when the inbound webhook fails. Keep it
    // empty so an unattested callback cannot reach the claim agent without the
    // exact approved packet returned by our webhook.
    inboundAgents: [],
    inboundWebhookUrl: `${PUBLIC_BASE_URL}/retell/inbound?token=${encodeURIComponent(RETELL_INBOUND_WEBHOOK_TOKEN)}`
  };
}

function claimFilingPhoneAgentAttestation(bindings) {
  return (Array.isArray(bindings) ? bindings : []).map((binding) => cleanObject({
    agent_id: String(binding?.agent_id || ""),
    agent_version: typeof binding?.agent_version === "number"
      ? binding.agent_version
      : String(binding?.agent_version || ""),
    weight: Number(binding?.weight)
  }));
}

async function claimFilingConfiguration() {
  if (isMacCodexOperatorRequest()) await assertMacOperatorClaimPlanningReady();
  if (
    !RETELL_API_KEY
    || !RETELL_AGENT_ID
    || !RETELL_FROM_NUMBER
    || !RETELL_GUARDED_END_CALL_TOKEN
    || !RETELL_INBOUND_WEBHOOK_TOKEN
  ) {
    badRequest("Retell claim filing is not fully configured.");
  }
  const [agent, phone] = await Promise.all([
    retellApi("GET", `/get-agent/${encodeURIComponent(RETELL_AGENT_ID)}`),
    retellApi("GET", `/get-phone-number/${encodeURIComponent(RETELL_FROM_NUMBER)}`)
  ]);
  const agentVersion = Number(agent?.version);
  if (!Number.isInteger(agentVersion) || agentVersion < 0) {
    badRequest("The configured Retell claim agent does not have an exact published version.");
  }
  const llmId = String(agent?.response_engine?.llm_id || "").trim();
  const llmVersion = Number(agent?.response_engine?.version);
  if (
    agent?.response_engine?.type !== "retell-llm"
    || !llmId
    || !Number.isInteger(llmVersion)
    || llmVersion < 0
  ) {
    badRequest("The configured Retell claim agent does not have a versioned Retell LLM response engine.");
  }

  const llm = await retellApi(
    "GET",
    versionedRetellEndpoint(`/get-retell-llm/${encodeURIComponent(llmId)}`, llmVersion)
  );
  const expectedLlm = buildRetellLlmFromPacket(retellConfigurationPacket(), {
    guardedEndCallUrl: `${PUBLIC_BASE_URL}/retell/guarded-end-call`,
    guardedEndCallAuthorization: `Bearer ${RETELL_GUARDED_END_CALL_TOKEN}`
  }).toLlmRequestBody();
  const expectedAnalysis = postCallAnalysisSchema();
  const liveTools = Array.isArray(llm?.general_tools) ? llm.general_tools : [];
  const liveAnalysis = Array.isArray(agent?.post_call_analysis_data)
    ? agent.post_call_analysis_data
    : [];
  const expectedTools = claimFilingToolAttestation(expectedLlm.general_tools);
  const attestedLiveTools = claimFilingToolAttestation(liveTools);
  const expectedAnalysisFields = claimFilingAnalysisAttestation(expectedAnalysis);
  const attestedLiveAnalysis = claimFilingAnalysisAttestation(liveAnalysis);
  const expectedPhone = expectedRetellClaimPhoneConfiguration();
  const expectedInboundAgents = claimFilingPhoneAgentAttestation(expectedPhone.inboundAgents);
  const liveInboundAgents = claimFilingPhoneAgentAttestation(phone?.inbound_agents);
  const expectedConfiguration = {
    generalPrompt: expectedLlm.general_prompt,
    generalTools: expectedTools,
    postCallAnalysisData: expectedAnalysisFields,
    timeZone: OPERATIONS_TIME_ZONE
  };
  const liveConfiguration = {
    generalPrompt: String(llm?.general_prompt || ""),
    generalTools: attestedLiveTools,
    postCallAnalysisData: attestedLiveAnalysis,
    timeZone: String(agent?.timezone || "")
  };
  const expectedConfigDigest = digest(expectedConfiguration);
  const liveConfigDigest = digest(liveConfiguration);
  const expectedToolNames = expectedLlm.general_tools.map((tool) => String(tool.name || "")).sort();
  const liveToolNames = liveTools.map((tool) => String(tool?.name || "")).filter(Boolean).sort();
  const expectedGuardedEndTool = expectedTools.find((tool) => tool.name === "request_guarded_end_call");
  const liveGuardedEndTool = attestedLiveTools.find((tool) => tool.name === "request_guarded_end_call");
  const guardedEndAuthorizationMatches = Boolean(
    expectedGuardedEndTool?.authorizationHeaderSha256
    && liveGuardedEndTool?.authorizationHeaderSha256 === expectedGuardedEndTool.authorizationHeaderSha256
  );
  const promptMatches = liveConfiguration.generalPrompt === expectedConfiguration.generalPrompt;
  const toolsMatch = digest(attestedLiveTools) === digest(expectedTools);
  const analysisSchemaMatches = digest(attestedLiveAnalysis) === digest(expectedAnalysisFields);
  const timezoneMatches = liveConfiguration.timeZone === OPERATIONS_TIME_ZONE;
  const published = agent?.is_published === true && llm?.is_published === true;
  const phoneNumberMatches = String(phone?.phone_number || "") === expectedPhone.phoneNumber;
  const inboundWebhookUrlMatches = String(phone?.inbound_webhook_url || "") === expectedPhone.inboundWebhookUrl;
  const inboundAgentRoutingMatches = digest(liveInboundAgents) === digest(expectedInboundAgents);
  const expectedPhoneConfigDigest = digest({
    phoneNumber: expectedPhone.phoneNumber,
    inboundAgents: expectedInboundAgents,
    inboundWebhookUrl: expectedPhone.inboundWebhookUrl
  });
  const livePhoneConfigDigest = digest({
    phoneNumber: String(phone?.phone_number || ""),
    inboundAgents: liveInboundAgents,
    inboundWebhookUrl: String(phone?.inbound_webhook_url || "")
  });
  const agentConfigDigest = digest({
    agentId: RETELL_AGENT_ID,
    agentVersion,
    llmId,
    llmVersion,
    configurationDigest: liveConfigDigest,
    phoneConfigurationDigest: livePhoneConfigDigest
  });
  const callbackWebhookAvailable = phoneNumberMatches
    && inboundWebhookUrlMatches
    && inboundAgentRoutingMatches;
  const ready = published
    && promptMatches
    && toolsMatch
    && guardedEndAuthorizationMatches
    && analysisSchemaMatches
    && timezoneMatches
    && callbackWebhookAvailable
    && expectedConfigDigest === liveConfigDigest;

  return {
    mode: "read_only",
    ready,
    agentConfigured: true,
    fromNumberConfigured: true,
    callbackWebhookAvailable,
    guardedEndCredentialConfigured: true,
    guardedEndCredentialIsolated: true,
    inboundWebhookCredentialConfigured: true,
    inboundWebhookCredentialIsolated: true,
    inboundWebhookAuthentication: "dedicated_url_token_plus_retell_hmac_sha256_raw_body_timestamp",
    inboundFallbackAgentUnset: liveInboundAgents.length === 0,
    phoneNumberMatches,
    inboundWebhookUrlMatches,
    inboundAgentRoutingMatches,
    expectedPhoneConfigDigest,
    livePhoneConfigDigest,
    guardedEndAuthorizationMatches,
    callbackPacketRestoration: "full_approved_packet",
    agentPublished: agent?.is_published === true,
    llmPublished: llm?.is_published === true,
    agentVersion,
    llmVersion,
    agentConfigDigest,
    promptMatches,
    toolsMatch,
    toolNames: liveToolNames,
    expectedToolNames,
    dtmfPressDigitAvailable: liveToolNames.includes("press_digit"),
    guardedEndCallAvailable: liveToolNames.includes("request_guarded_end_call"),
    analysisSchemaMatches,
    analysisFields: liveAnalysis.map((field) => String(field?.name || "")).filter(Boolean),
    timezoneMatches,
    expectedConfigDigest,
    liveConfigDigest,
    approvalModel: "fresh_single_file_digest_plus_short_lived_identity_bound_single_use_challenge",
    writebackRequiresSeparateApproval: true,
    automaticJobNimbusWriteback: false,
    instruction: ready
      ? "The live Retell carrier agent matches this deployed bridge and is ready for separately approved single-file claim calls."
      : "Do not place a claim call. The live Retell carrier agent differs from this deployed bridge or is not fully published."
  };
}

async function prepareClaimFiling(input) {
  if (isMacCodexOperatorRequest()) await assertMacOperatorClaimPlanningReady();
  const claimInput = isMacCodexOperatorRequest()
    ? { ...input, includeCarrierBatch: false }
    : input;
  const context = await buildLiveClaimContext(required(input.query, "query"));
  let plan = await buildClaimPlanWithStormTime(claimInput, context.canonicalInput, context.file);
  plan = await attachSameCarrierBatch(plan, context, claimInput);
  plan = await attachSchedulingAvailability(plan);
  let retellConfiguration = null;
  if (plan.readiness.ready && ALLOW_RETELL_CALLS && ALLOW_RETELL_CLAIM_CALLS) {
    retellConfiguration = await claimFilingConfiguration();
    if (retellConfiguration.ready !== true) {
      plan.readiness.ready = false;
      plan.readiness.blockers = [...new Set([
        ...(plan.readiness.blockers || []),
        "the exact published Retell claim-agent version and configuration are not attested"
      ])];
    }
  }
  plan = bindClaimCallApproval(plan, claimInput, retellConfiguration);
  const approval = plan.readiness.ready && plan.configurationAttested
    ? await issueActionApprovalChallenge(
        plan.planDigest,
        1,
        claimFilingApprovalScope(context.file),
        "claim_filing_call",
        CLAIM_CALL_APPROVAL_TTL_SECONDS
      )
    : null;
  return {
    mode: "dry_run",
    approvalRequired: true,
    file: context.file,
    evidence: context.evidenceSummary,
    ...plan,
    approvalChallenge: approval?.challenge || "",
    approvalExpiresAt: approval?.expiresAt || "",
    nextStep: plan.readiness.ready && plan.configurationAttested
      ? "Review this exact single-file packet. To call, submit its planDigest and hidden single-use approval challenge to placeApprovedClaimFilingCall with execute=true before expiry."
      : plan.readiness.ready
        ? "Claim-call execution is disabled, so no executable approval was issued. Enable both Retell call gates and prepare the filing again to attest and bind the exact published agent version."
        : "Resolve the listed blockers, then prepare the filing again."
  };
}

async function placeClaimFilingCall(input) {
  if (isMacCodexOperatorRequest()) await assertMacOperatorClaimPlanningReady();
  const claimInput = isMacCodexOperatorRequest()
    ? { ...input, includeCarrierBatch: false }
    : input;
  const context = await buildLiveClaimContext(required(input.query, "query"));
  let plan = await buildClaimPlanWithStormTime(claimInput, context.canonicalInput, context.file);
  plan = await attachSameCarrierBatch(plan, context, claimInput);
  plan = await attachSchedulingAvailability(plan);
  if (!ALLOW_RETELL_CALLS || !ALLOW_RETELL_CLAIM_CALLS) {
    badRequest("Retell claim-filing calls are disabled. ALLOW_RETELL_CALLS and ALLOW_RETELL_CLAIM_CALLS must both be true.");
  }
  if (!RETELL_API_KEY || !RETELL_AGENT_ID || !RETELL_FROM_NUMBER) {
    badRequest("Retell claim filing is not configured. RETELL_API_KEY, RETELL_AGENT_ID, and RETELL_FROM_NUMBER are required.");
  }
  if (!plan.readiness.ready) badRequest(`Claim filing is blocked: ${plan.readiness.blockers.join("; ")}`);

  const retellConfiguration = await claimFilingConfiguration();
  if (retellConfiguration.ready !== true) {
    badRequest("The live Retell claim agent is not attested to the deployed bridge configuration.");
  }
  plan = bindClaimCallApproval(plan, claimInput, retellConfiguration);
  assertApprovalDigest(input.planDigest, plan.planDigest);

  const request = retellCallBody(plan);
  const operatorPrincipalHash = isMacCodexOperatorRequest()
    ? actionApprovalIdentityHash()
    : "";
  if (operatorPrincipalHash) {
    request.metadata.operatorLane = "codex_mac_single_file_claim_filing";
    request.metadata.operatorPrincipalHash = operatorPrincipalHash;
  }
  const retryOfCallId = String(input.retryOfCallId || "").trim();
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      file: context.file,
      planDigest: plan.planDigest,
      readiness: plan.readiness,
      request: previewRetellRequest(request)
    };
  }

  const admission = await withClaimCallMutation(async () => {
    const ledger = await readClaimCallLedger();
    const remoteCalls = await listRemoteClaimCalls();
    const localPrior = ledger.find((row) => (
      claimLedgerReservationMatchesPlan(row, plan, retryOfCallId, operatorPrincipalHash)
      && row.callId
    ));
    const remotePrior = localPrior
      ? null
      : findRemoteOperatorClaimCallAttemptInRows(
          remoteCalls,
          plan,
          retryOfCallId,
          operatorPrincipalHash
        );
    const prior = localPrior || remotePrior;
    if (prior) {
      let reconciledReservation = Boolean(localPrior);
      if (remotePrior) {
        const reservation = ledger.find((row) => (
          claimLedgerReservationMatchesPlan(row, plan, retryOfCallId, operatorPrincipalHash)
          && !row.callId
        ));
        if (reservation) {
          reservation.callId = remotePrior.callId;
          reservation.callStatus = remotePrior.callStatus;
          reservation.reconciledAt = new Date().toISOString();
          await writeClaimCallLedger(ledger.slice(-500));
          reconciledReservation = true;
        }
      }
      if (operatorPrincipalHash && !reconciledReservation) {
        conflictError("Retell contains this operator-stamped call, but its local durable approval reservation is missing. No second call was placed; manual reconciliation is required.");
      }
      return { mode: "duplicate", prior };
    }

    const resource = await buildClaimCallResourceSnapshot({
      file: context.file,
      ledger,
      remoteCalls
    });
    if (resource.ledgerChanged) await writeClaimCallLedger(ledger.slice(-500));
    const decision = evaluateClaimCallResource({
      ...resource,
      requestedGoal: plan.packet.goal,
      retryOfCallId
    });
    if (!decision.allowed) conflictError(decision.reason);

    const approval = await consumeActionApprovalChallenge(
      input.approvalChallenge,
      plan.planDigest,
      "claim_filing_call",
      claimFilingApprovalScope(context.file)
    );

    const record = {
      id: randomUUID(),
      approvalId: approval.id,
      planDigest: plan.planDigest,
      sourcePlanDigest: plan.sourcePlanDigest,
      callId: "",
      callStatus: "provider_pending",
      agentId: plan.callPlan.agentId,
      agentVersion: plan.agentVersion,
      agentConfigDigest: plan.agentConfigDigest,
      callbackPacketDigest: plan.callbackPacketDigest,
      ownerId: CHANCE_OWNER_ID,
      contactId: context.file.id,
      fileNumber: context.file.number,
      goal: plan.packet.goal,
      retryOfCallId,
      principalHash: operatorPrincipalHash,
      operatorLane: operatorPrincipalHash ? "codex_mac_single_file_claim_filing" : "",
      createdAt: new Date().toISOString()
    };
    ledger.push(record);
    await writeClaimCallLedger(ledger.slice(-500));
    return { mode: "reserved", record };
  });

  if (admission.mode === "duplicate") {
    const prior = admission.prior;
    return {
      mode: "duplicate_prevented",
      file: context.file,
      planDigest: plan.planDigest,
      callId: prior.callId,
      callStatus: prior.callStatus,
      createdAt: prior.createdAt,
      automaticJobNimbusWriteback: false,
      automaticChanceBrainWriteback: false,
      note: "This exact approved filing plan already created a Retell call. No second call was placed."
    };
  }

  if (retryOfCallId) request.metadata.retryOfCallId = retryOfCallId;
  const record = admission.record;
  let result;
  try {
    result = await retellApi("POST", "/v2/create-phone-call", request);
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(String(result?.call_id || ""))
      || !/^[A-Za-z0-9_-]{1,80}$/.test(String(result?.call_status || ""))
    ) {
      const error = new Error("Retell accepted the provider request but did not return a usable call id and status. Manual reconciliation is required before any retry.");
      error.statusCode = 502;
      throw error;
    }
  } catch (error) {
    await withClaimCallMutation(async () => {
      const latest = await readClaimCallLedger();
      const reserved = latest.find((row) => row.id === record.id);
      if (reserved) {
        reserved.callStatus = "provider_outcome_unknown";
        reserved.providerErrorAt = new Date().toISOString();
        await writeClaimCallLedger(latest.slice(-500));
      }
    });
    throw error;
  }
  await withClaimCallMutation(async () => {
    const latest = await readClaimCallLedger();
    const reserved = latest.find((row) => row.id === record.id);
    if (!reserved) throw new Error("The durable Retell call reservation is missing after provider execution.");
    reserved.callId = result.call_id;
    reserved.callStatus = result.call_status;
    reserved.providerConfirmedAt = new Date().toISOString();
    await writeClaimCallLedger(latest.slice(-500));
  });
  return {
    mode: "executed",
    file: context.file,
    planDigest: plan.planDigest,
    callId: result.call_id,
    callStatus: result.call_status,
    automaticJobNimbusWriteback: false,
    automaticChanceBrainWriteback: false,
    nextStep: "After the call ends, use reviewClaimFilingCallResult with this callId. Any JobNimbus update requires a separate approval batch."
  };
}

async function retellHomeownerCall(input) {
  return retellClientCoordinatorCall({ ...input, mode: input.mode || "appointment_confirmation" });
}

async function retellClientCoordinatorCall(input = {}) {
  const { contact } = await findChanceContact(required(input.query, "query"));
  const file = compactContact(contact);
  const to = normalizePhone(file.phone);
  if (!/^\+\d{10,15}$/.test(to)) {
    badRequest("The current Chance-owned JobNimbus file does not have a valid homeowner phone number.");
  }
  const mode = String(input.mode || "appointment_confirmation").trim().toLowerCase();
  let appointment = { date: "", window: "" };
  if (mode === "appointment_confirmation") {
    const dateStart = required(input.dateStart, "dateStart");
    const dateEnd = required(input.dateEnd, "dateEnd");
    if (!explicitOffsetDateTime(dateStart) || !explicitOffsetDateTime(dateEnd)) {
      badRequest("dateStart and dateEnd must be ISO datetimes with an explicit UTC offset.");
    }
    if (Date.parse(dateEnd) <= Date.parse(dateStart)) badRequest("dateEnd must be after dateStart.");
    appointment = homeownerAppointmentLabels(dateStart, dateEnd);
  }

  const evidencePacket = await buildChanceEvidencePacket(contact, {
    includeGmail: input.includeGmail !== false,
    includeQuo: input.includeQuo !== false,
    includeQuoTranscripts: input.includeQuoTranscripts === true,
    communicationDays: input.communicationDays,
    gmailLimit: input.gmailLimit,
    gmailThreadLimit: input.gmailThreadLimit,
    quoLimit: input.quoLimit
  });
  const evidence = compactClientCoordinatorEvidence(evidencePacket);
  if (!evidencePacket.complete) {
    return {
      mode: "blocked_evidence",
      approvalRequired: true,
      file,
      evidence,
      reason: "A requested communication source is unavailable. Review the source error or explicitly prepare again with that source disabled before calling."
    };
  }

  const reminderRules = clientCoordinatorReminderRules();
  let conversation;
  try {
    conversation = buildClientCoordinatorConversation({
      mode,
      firstName: String(file.name || "there").trim().split(/\s+/)[0] || "there",
      appointmentDate: appointment.date,
      appointmentWindow: appointment.window,
      interiorAccessRequired: input.interiorAccessRequired !== false,
      documentNeeded: input.documentNeeded,
      statusUpdate: input.statusUpdate,
      checkInReason: input.checkInReason,
      approvedContext: input.approvedContext,
      reminderTopics: input.reminderTopics,
      reminderRules
    });
  } catch (error) {
    badRequest(error.message);
  }

  for (const topic of conversation.reminderTopics) {
    if (!reminderRules[topic]) badRequest(`Verified Brain guidance is unavailable for reminder topic ${topic}.`);
  }

  const legacyAppointmentMode = conversation.mode === "appointment_confirmation";
  const evidenceFingerprint = clientCoordinatorEvidenceFingerprint(evidence);
  const dynamicVariables = {
    directionMode: legacyAppointmentMode ? "outbound_homeowner" : "outbound_client_coordinator",
    goal: legacyAppointmentMode ? "homeowner_appointment_confirmation" : "client_coordinator",
    objective: legacyAppointmentMode
      ? `Confirm ${file.name}'s availability and access for the scheduled carrier inspection.`
      : conversation.purpose,
    homeownerFirstName: String(file.name || "there").trim().split(/\s+/)[0] || "there",
    insuredName: file.name,
    homeownerPhone: file.phone,
    homeownerEmail: file.email || "Missing",
    propertyAddress: file.address,
    carrier: file.carrier || "the insurance carrier",
    claimNumber: file.claimNumber || "Missing",
    coordinatorMode: conversation.mode,
    coordinatorOpening: conversation.opening,
    coordinatorPurpose: conversation.purpose,
    coordinatorFallbackText: conversation.fallbackText,
    coordinatorApprovedContext: conversation.approvedContext,
    coordinatorReminderTopics: conversation.reminderTopics.join(", ") || "None",
    coordinatorReminderGuidance: conversation.reminderGuidance,
    appointmentDate: appointment.date || "Not applicable",
    appointmentWindow: appointment.window || "Not applicable",
    appointmentAccessRequirement: conversation.accessRequirement,
    homeownerOutreachOpening: conversation.opening,
    homeownerOutreachMessage: conversation.purpose,
    batchClaimCount: "0",
    batchClaims: "None"
  };
  const metadata = {
    source: "hcn-wave-jobnimbus-bridge",
    contactId: file.id,
    fileNumber: String(file.number || ""),
    ownerId: CHANCE_OWNER_ID,
    goal: legacyAppointmentMode ? "homeowner_appointment_confirmation" : "client_coordinator",
    coordinatorMode: conversation.mode,
    evidenceFingerprint
  };
  const planDigest = digest({
    version: 1,
    to,
    agentId: RETELL_CLIENT_COORDINATOR_AGENT_ID,
    metadata,
    dynamicVariables,
    evidenceFingerprint
  });
  metadata.planDigest = planDigest;
  const request = {
    from_number: RETELL_FROM_NUMBER,
    to_number: to,
    override_agent_id: RETELL_CLIENT_COORDINATOR_AGENT_ID,
    metadata,
    retell_llm_dynamic_variables: dynamicVariables
  };

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      automaticFallbackText: false,
      automaticJobNimbusWriteback: false,
      file,
      planDigest,
      appointment,
      conversation,
      evidence,
      request: previewRetellRequest(request),
      nextStep: "Show Chance the exact purpose, Brain reminders, context, and fallback text. Nothing is called or sent until the unchanged plan is approved."
    };
  }

  assertApprovalDigest(input.planDigest, planDigest);
  if (!ALLOW_RETELL_CALLS || !ALLOW_CLIENT_COORDINATOR_CALLS) {
    badRequest("Client Coordinator calls are disabled. ALLOW_RETELL_CALLS and ALLOW_CLIENT_COORDINATOR_CALLS must both be true.");
  }
  if (mode !== "appointment_confirmation" && !ALLOW_CLIENT_COORDINATOR_CALLS) {
    badRequest("Expanded Client Coordinator calls are disabled until the dedicated prompt is reviewed, published, and ALLOW_CLIENT_COORDINATOR_CALLS=true.");
  }
  if (!RETELL_API_KEY || !RETELL_CLIENT_COORDINATOR_AGENT_ID || !RETELL_FROM_NUMBER) {
    badRequest("The Retell Client Coordinator is not fully configured.");
  }
  const prior = await findRemoteClaimCallAttempt(planDigest, "");
  if (prior) {
    return {
      mode: "duplicate_prevented",
      file,
      planDigest,
      callId: prior.callId,
      callStatus: prior.callStatus,
      createdAt: prior.createdAt
    };
  }

  const result = await retellApi("POST", "/v2/create-phone-call", request);
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
    channel: "retell",
    action: "place_client_coordinator_call",
    status: result.call_status || "registered",
    subjectKey: file.id,
    fileLabel: `${file.number || ""} ${file.name || ""}`.trim(),
    summary: `Placed approved Retell Client Coordinator call for ${conversation.mode}.`,
    externalId: result.call_id,
    evidence: result.call_id ? [`retell:${result.call_id}`] : []
  });
  return {
    mode: "executed",
    file,
    coordinatorMode: conversation.mode,
    planDigest,
    callId: result.call_id,
    callStatus: result.call_status,
    nextStep: "Review the completed call before approving any fallback text, JobNimbus update, task, or human follow-up.",
    memoryCloseout
  };
}

async function retellHomeownerCallResult(input) {
  return retellClientCoordinatorCallResult(input);
}

async function retellClientCoordinatorCallResult(input = {}) {
  const callId = required(input.callId, "callId");
  const call = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);
  const validGoal = ["homeowner_appointment_confirmation", "client_coordinator"].includes(call.metadata?.goal);
  if (call.metadata?.source !== "hcn-wave-jobnimbus-bridge" || !validGoal) {
    badRequest("This is not a bridge Client Coordinator call.");
  }
  const result = extractClientCoordinatorResult(call);
  const fallbackText = String(call.retell_llm_dynamic_variables?.coordinatorFallbackText || "").trim();
  return {
    mode: "read_only",
    call: result,
    file: {
      id: call.metadata.contactId || "",
      number: call.metadata.fileNumber || ""
    },
    coordinatorMode: call.metadata.coordinatorMode || "appointment_confirmation",
    proposedFollowUps: clientCoordinatorProposedFollowUps(result, fallbackText),
    instruction: "These are review-only results. Do not send the fallback text or write JobNimbus until Chance approves the exact proposed action."
  };
}

async function retellCarrierFollowUpCall(input = {}) {
  const { contact } = await findChanceContact(required(input.query, "query"));
  const file = compactContact(contact);
  const requestedGoal = String(input.goal || "adjuster_assignment").trim().toLowerCase();
  const schedulingAuthorized = input.schedulingAuthority === true;
  if (requestedGoal === "appointment_scheduling" && !schedulingAuthorized) {
    badRequest("appointment_scheduling requires schedulingAuthority=true so the exact merged availability is reviewed before the call.");
  }
  const destinationType = String(input.destinationType || "carrier_general_line").trim().toLowerCase();
  const fallbackPhone = destinationType === "desk_adjuster" ? file.adjusterPhone : "";
  const to = normalizePhone(input.to || input.carrierPhone || fallbackPhone);
  if (!/^\+\d{10,15}$/.test(to)) {
    badRequest("A verified destination phone number is required. The bridge will not use a desk-adjuster number for a field inspector or guess a carrier number.");
  }
  const destinationExtension = normalizeCarrierExtension(input.extension);
  if (!file.claimNumber && !file.policyNumber) {
    badRequest("The current file has neither a claim number nor a policy number. Verify an identifier before preparing a carrier follow-up call.");
  }

  let schedulingAvailability = null;
  let approvedSchedulingOptions = input.approvedSchedulingOptions;
  if (schedulingAuthorized) {
    schedulingAvailability = await collectUnifiedSchedulingAvailability();
    if (schedulingAvailability.status !== "READY") {
      return {
        mode: "blocked_availability",
        approvalRequired: true,
        file,
        schedulingAvailability,
        reason: schedulingAvailability.reason,
        nextStep: "Do not place a scheduling call until both JobNimbus and Google Calendar availability are available."
      };
    }
    approvedSchedulingOptions = schedulingAvailability.availableWindows
      .slice(0, 8)
      .map((window) => window.label);
  }

  let conversation;
  try {
    conversation = buildCarrierFollowUpConversation({
      goal: requestedGoal,
      destinationType,
      contactName: input.contactName || (destinationType === "desk_adjuster" ? file.adjusterName : ""),
      approvedQuestions: input.approvedQuestions,
      schedulingAuthority: input.schedulingAuthority === true,
      approvedSchedulingOptions
    });
  } catch (error) {
    badRequest(error.message);
  }

  const evidencePacket = await buildChanceEvidencePacket(contact, {
    includeGmail: input.includeGmail !== false,
    includeQuo: input.includeQuo !== false,
    includeQuoTranscripts: input.includeQuoTranscripts === true,
    communicationDays: input.communicationDays,
    gmailLimit: input.gmailLimit,
    gmailThreadLimit: input.gmailThreadLimit,
    quoLimit: input.quoLimit
  });
  const evidence = compactClientCoordinatorEvidence(evidencePacket);
  if (!evidencePacket.complete) {
    return {
      mode: "blocked_evidence",
      approvalRequired: true,
      file,
      evidence,
      reason: "A requested evidence source is unavailable. Review the source error or explicitly prepare again with that source disabled before calling."
    };
  }

  const evidenceFingerprint = clientCoordinatorEvidenceFingerprint(evidence);
  const dynamicVariables = {
    directionMode: "outbound_carrier_follow_up",
    goal: "carrier_follow_up",
    callGoal: conversation.goal,
    destinationType: conversation.destinationType,
    destinationExtension: destinationExtension || "None",
    carrierFollowUpOpening: conversation.opening,
    carrier: file.carrier || "Unknown",
    insuredName: file.name || "Unknown",
    propertyAddress: file.address || "Unknown",
    policyNumber: file.policyNumber || "Missing",
    claimNumber: file.claimNumber || "Missing",
    dateOfLoss: file.dateOfLoss || "Missing",
    jobNumber: String(file.number || "Missing"),
    deskAdjuster: [file.adjusterName, file.adjusterPhone, file.adjusterEmail].filter(Boolean).join(" | ") || "Unknown",
    fieldInspector: String(input.fieldInspectorName || "Unknown").trim(),
    inspectorCompany: String(input.fieldInspectorCompany || "Unknown").trim(),
    appointmentDateTime: String(input.appointmentDateTime || "Not supplied").trim(),
    appointmentWindow: String(input.appointmentWindow || "Not supplied").trim(),
    interiorAccess: String(input.interiorAccess || "Unknown").trim(),
    documentsSent: String(input.documentsSent || "Unknown").trim(),
    documentDestination: String(input.documentDestination || "Unknown").trim(),
    approvedQuestions: conversation.approvedQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    schedulingAuthority: conversation.schedulingAuthority,
    approvedSchedulingOptions: conversation.approvedSchedulingOptions.join(" | ") || "None"
  };
  if (schedulingAvailability) {
    dynamicVariables.availabilityStatus = schedulingAvailability.status;
    dynamicVariables.availabilitySources = "JobNimbus calendar and Google Calendar";
    dynamicVariables.appointmentDurationMinutes = String(schedulingAvailability.settings.durationMinutes);
    dynamicVariables.availableAppointmentWindows = schedulingAvailability.voiceWindows;
    dynamicVariables.availabilityWindowsJson = JSON.stringify(schedulingAvailability.availableWindows || []);
  } else {
    dynamicVariables.availabilityStatus = "NOT_REQUESTED";
    dynamicVariables.availabilitySources = "Not checked for this call";
    dynamicVariables.appointmentDurationMinutes = String(SCHEDULING_APPOINTMENT_MINUTES);
    dynamicVariables.availableAppointmentWindows = "None. Do not schedule an appointment.";
    dynamicVariables.availabilityWindowsJson = "[]";
  }
  for (const [key, value] of Object.entries(dynamicVariables)) {
    dynamicVariables[key] = String(value ?? "");
  }
  const metadata = {
    source: "hcn-wave-jobnimbus-bridge",
    contactId: file.id,
    fileNumber: String(file.number || ""),
    ownerId: CHANCE_OWNER_ID,
    goal: "carrier_follow_up",
    carrierFollowUpGoal: conversation.goal,
    destinationType: conversation.destinationType,
    evidenceFingerprint
  };
  const planDigest = digest({
    version: 1,
    to,
    agentId: RETELL_CARRIER_FOLLOWUP_AGENT_ID,
    metadata,
    dynamicVariables,
    evidenceFingerprint
  });
  metadata.planDigest = planDigest;
  const request = {
    from_number: RETELL_FROM_NUMBER,
    to_number: to,
    override_agent_id: RETELL_CARRIER_FOLLOWUP_AGENT_ID,
    metadata,
    retell_llm_dynamic_variables: dynamicVariables
  };

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      automaticScheduling: false,
      automaticJobNimbusWriteback: false,
      file,
      destination: {
        type: conversation.destinationType,
        name: conversation.contactName,
        phone: to,
        extension: destinationExtension
      },
      conversation,
      evidence,
      schedulingAvailability,
      planDigest,
      request: previewRetellRequest(request),
      nextStep: "Show Chance the destination, exact questions, scheduling authority, fresh evidence, and digest. Nothing is called until the unchanged plan is approved."
    };
  }

  assertApprovalDigest(input.planDigest, planDigest);
  if (!ALLOW_RETELL_CALLS || !ALLOW_CARRIER_FOLLOWUP_CALLS) {
    badRequest("Carrier follow-up calls are disabled. ALLOW_RETELL_CALLS and ALLOW_CARRIER_FOLLOWUP_CALLS must both be true.");
  }
  if (!RETELL_API_KEY || !RETELL_CARRIER_FOLLOWUP_AGENT_ID || !RETELL_FROM_NUMBER) {
    badRequest("The Retell Carrier Follow-Up agent is not fully configured.");
  }
  const prior = await findRemoteClaimCallAttempt(planDigest, "");
  if (prior) {
    return {
      mode: "duplicate_prevented",
      file,
      planDigest,
      callId: prior.callId,
      callStatus: prior.callStatus,
      createdAt: prior.createdAt,
      note: "This exact approved carrier follow-up plan already created a Retell call. No second call was placed."
    };
  }

  const result = await retellApi("POST", "/v2/create-phone-call", request);
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
    channel: "retell",
    action: "place_carrier_follow_up_call",
    status: result.call_status || "registered",
    subjectKey: file.id,
    fileLabel: `${file.number || ""} ${file.name || ""}`.trim(),
    summary: `Placed approved Retell carrier follow-up call for ${conversation.goal}.`,
    externalId: result.call_id,
    evidence: result.call_id ? [`retell:${result.call_id}`] : []
  });
  return {
    mode: "executed",
    file,
    carrierFollowUpGoal: conversation.goal,
    planDigest,
    callId: result.call_id,
    callStatus: result.call_status,
    nextStep: "After the call ends, review its transcript and structured result before approving any JobNimbus field, task, note, calendar, text, or email action.",
    memoryCloseout
  };
}

async function retellCarrierFollowUpCallResult(input = {}) {
  const callId = required(input.callId, "callId");
  const call = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);
  if (call.metadata?.source !== "hcn-wave-jobnimbus-bridge" || call.metadata?.goal !== "carrier_follow_up") {
    badRequest("This is not a bridge Carrier Follow-Up call.");
  }
  const result = extractCarrierFollowUpResult(call);
  const data = result.structured || {};
  const proposedContactFields = cleanObject({
    claimNumber: data.claim_number,
    adjusterName: data.desk_adjuster_name,
    adjusterPhone: data.desk_adjuster_phone,
    adjusterEmail: data.desk_adjuster_email
  });
  const proposedInspectionTask = cleanObject({
    fieldInspectorName: data.field_inspector_name,
    fieldInspectorCompany: data.field_inspector_company,
    fieldInspectorPhone: data.field_inspector_phone,
    fieldInspectorEmail: data.field_inspector_email,
    carrierArrivalWindow: data.appointment_window,
    dayOfEta: data.estimated_arrival_time,
    accessRequirements: data.access_requirements
  });
  return {
    mode: "read_only",
    call: result,
    file: {
      id: call.metadata.contactId || "",
      number: call.metadata.fileNumber || ""
    },
    carrierFollowUpGoal: call.metadata.carrierFollowUpGoal || "",
    reviewOnlyProposals: {
      contactFields: proposedContactFields,
      inspectionTask: proposedInspectionTask,
      documents: cleanObject({
        received: data.documents_received,
        submissionDestination: data.document_submission,
        representationRecognized: data.representation_recognized === true
      }),
      followUp: cleanObject({
        carrierNextStep: data.carrier_next_step,
        timeframe: data.follow_up_timeframe,
        blocker: data.blocking_reason,
        proposedAppointmentChange: data.proposed_change
      })
    },
    instruction: "Review the transcript against every extracted value. Desk-adjuster fields and inspection-task fields are deliberately separate. Nothing was written, scheduled, sent, or changed; each exact action requires Chance's separate approval."
  };
}

function compactClientCoordinatorEvidence(packet = {}) {
  const gmailMessages = (Array.isArray(packet.gmail?.messages) ? packet.gmail.messages : [])
    .slice(0, 5)
    .map((message) => ({
      id: message.id || "",
      threadId: message.threadId || "",
      date: message.date || message.internalDate || "",
      from: message.from || "",
      to: message.to || "",
      subject: message.subject || "",
      snippet: String(message.snippet || message.text || "").slice(0, 800)
    }));
  const gmailThreads = (Array.isArray(packet.gmail?.threads) ? packet.gmail.threads : [])
    .slice(0, 3)
    .map((thread) => ({
      id: thread.id || "",
      messageCount: Number(thread.messageCount || 0),
      messages: (Array.isArray(thread.messages) ? thread.messages : []).slice(-3).map((message) => ({
        date: message.date || "",
        from: message.from || "",
        to: message.to || "",
        subject: message.subject || "",
        text: String(message.text || "").slice(0, 1200),
        attachments: Array.isArray(message.attachments) ? message.attachments.slice(0, 8) : []
      })),
      assistantRead: thread.assistantRead || null
    }));
  const quoTimeline = (Array.isArray(packet.quo?.timeline) ? packet.quo.timeline : [])
    .slice(0, 10)
    .map((item) => ({
      id: item.id || "",
      type: item.type || "",
      line: item.line || "",
      at: item.at || item.atUtc || "",
      direction: item.direction || "",
      status: item.status || "",
      text: String(item.text || "").slice(0, 1000),
      durationSec: Number(item.durationSec || 0),
      aiHandled: Boolean(item.aiHandled)
    }));
  const quoTranscripts = (Array.isArray(packet.quo?.transcripts) ? packet.quo.transcripts : [])
    .slice(0, 3)
    .map((transcript) => ({
      callId: transcript.callId || "",
      status: transcript.status || "",
      duration: Number(transcript.duration || 0),
      dialogue: (Array.isArray(transcript.dialogue) ? transcript.dialogue : []).slice(0, 80).map((segment) => ({
        who: segment.who || "",
        at: segment.at || 0,
        text: String(segment.text || "").slice(0, 800)
      }))
    }));

  return {
    generatedAt: new Date().toISOString(),
    complete: packet.complete === true,
    file: packet.file || {},
    sourceStatus: packet.sourceStatus || {},
    jobNimbus: {
      recentActivities: (packet.liveJobNimbus?.recentActivities || []).slice(0, 10),
      openTasks: (packet.liveJobNimbus?.openTasks || []).slice(0, 10),
      operationalDocuments: (packet.liveJobNimbus?.operationalDocuments || []).slice(0, 15),
      excludedPhotoLikeDocumentCount: Number(packet.liveJobNimbus?.excludedPhotoLikeDocumentCount || 0),
      assistantRead: packet.liveJobNimbus?.assistantRead || null
    },
    gmail: {
      status: packet.gmail?.status || "not_requested",
      error: packet.gmail?.error || "",
      query: packet.gmail?.query || "",
      messages: gmailMessages,
      threads: gmailThreads
    },
    quo: {
      status: packet.quo?.status || "not_requested",
      error: packet.quo?.error || "",
      phone: packet.quo?.phone || "",
      timeline: quoTimeline,
      transcripts: quoTranscripts,
      authority: "Company-wide Quo communication is read-only evidence. This call cannot send from any employee's line."
    },
    actionReceipts: (Array.isArray(packet.actionReceipts) ? packet.actionReceipts : []).slice(0, 8),
    factualSignals: packet.factualSignals || {},
    operational: packet.operational || null,
    operationalAdvisory: packet.operationalAdvisory || null
  };
}

function clientCoordinatorEvidenceFingerprint(evidence = {}) {
  const sourceStatus = Object.fromEntries(
    Object.entries(evidence.sourceStatus || {}).map(([source, value]) => [source, {
      status: value?.status || "",
      error: value?.error || ""
    }])
  );
  return digest({
    version: 1,
    complete: evidence.complete === true,
    file: evidence.file || {},
    sourceStatus,
    // Canonicalize unordered API arrays and volatile transport metadata while
    // preserving the actual evidence content protected by the digest.
    gmail: canonicalEvidenceValue(evidence.gmail || {}),
    quo: canonicalEvidenceValue(evidence.quo || {}),
    actionReceipts: canonicalEvidenceValue(evidence.actionReceipts || []),
    factualSignals: canonicalEvidenceValue(evidence.factualSignals || {}),
    jobNimbus: canonicalEvidenceValue(evidence.jobNimbus || {})
  });
}

function canonicalEvidenceValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalEvidenceValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["attachmentId", "generatedAt"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalEvidenceValue(entry)])
  );
}

function clientCoordinatorReminderRules() {
  const records = listMemory(MEMORY_CONFIG, {
    lane: "company",
    status: "verified",
    subjectKey: "client-communication-three-reminders"
  });
  const byDedupKey = new Map(records.map((record) => [record.dedupKey, record.content]));
  return {
    process_timing: byDedupKey.get("company:decision:three-client-reminders-process-time") || "",
    titan_role: byDedupKey.get("company:decision:three-client-reminders-titan-role") || "",
    part_b_scope: byDedupKey.get("company:decision:three-client-reminders-part-b") || ""
  };
}

function clientCoordinatorProposedFollowUps(result, fallbackText) {
  const structured = result.structured || {};
  const proposals = [];
  if (structured.optOutRequested) {
    proposals.push({
      type: "manual_contact_preference_review",
      approvalRequired: true,
      reason: "The client requested that automated calls stop. Do not call or send a fallback text until Chance reviews the contact preference."
    });
  } else if (["voicemail_or_automated", "no_answer", "disconnected"].includes(structured.contactOutcome) && fallbackText) {
    proposals.push({
      type: "quo_text",
      exactText: fallbackText,
      approvalRequired: true,
      reason: "The approved call purpose was not completed. This text is a proposal only and was not sent."
    });
  }
  if (structured.documentCommitment) {
    proposals.push({
      type: "verify_document_receipt",
      approvalRequired: false,
      detail: structured.documentCommitment,
      reason: "Confirm the promised document actually arrives before updating the file."
    });
  }
  if (structured.clientQuestions || structured.clientConcerns || structured.followUpNeeded || structured.writtenFollowUpRequested) {
    proposals.push({
      type: "human_follow_up_review",
      approvalRequired: true,
      preferredContactMethod: structured.preferredContactMethod || "unspecified",
      clientQuestions: structured.clientQuestions || "",
      clientConcerns: structured.clientConcerns || "",
      followUpNeeded: structured.followUpNeeded || "",
      writtenFollowUpRequested: structured.writtenFollowUpRequested === true,
      reason: "Chance or Andrea should review the exact question or concern before any response is drafted or sent."
    });
  }
  return proposals;
}

function homeownerAppointmentLabels(dateStart, dateEnd) {
  const start = new Date(dateStart);
  const end = new Date(dateEnd);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONS_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONS_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit"
  });
  return { date, window: `${timeFormatter.format(start)} and ${timeFormatter.format(end)}` };
}

async function findRemoteClaimCallAttempt(planDigest, retryOfCallId) {
  const rows = await listRemoteClaimCalls();
  const row = rows.find((call) =>
    call.direction === "outbound" &&
    call.metadata?.source === "hcn-wave-jobnimbus-bridge" &&
    String(call.metadata?.planDigest || "") === String(planDigest) &&
    String(call.metadata?.retryOfCallId || "") === String(retryOfCallId || "")
  );
  return row ? {
    planDigest,
    retryOfCallId,
    callId: row.call_id,
    callStatus: row.call_status,
    createdAt: row.start_timestamp ? new Date(row.start_timestamp).toISOString() : ""
  } : null;
}

async function listRemoteClaimCalls() {
  const response = await retellApi("POST", "/v3/list-calls", {
    filter_criteria: {},
    sort_order: "descending",
    limit: 100
  });
  return Array.isArray(response.items) ? response.items : [];
}

async function findRemoteOperatorClaimCallAttempt(plan, retryOfCallId, operatorPrincipalHash = "") {
  const rows = await listRemoteClaimCalls();
  return findRemoteOperatorClaimCallAttemptInRows(rows, plan, retryOfCallId, operatorPrincipalHash);
}

function findRemoteOperatorClaimCallAttemptInRows(rows, plan, retryOfCallId, operatorPrincipalHash = "") {
  const planDigest = String(plan?.planDigest || "");
  const row = (Array.isArray(rows) ? rows : []).find((call) =>
    call.direction === "outbound" &&
    String(call.agent_id || "") === String(plan?.callPlan?.agentId || "") &&
    call.metadata?.source === "hcn-wave-jobnimbus-bridge" &&
    String(call.metadata?.ownerId || "") === CHANCE_OWNER_ID &&
    String(call.metadata?.contactId || "") === String(plan?.file?.id || "") &&
    String(call.metadata?.fileNumber || "").replace(/^#/, "") === String(plan?.file?.number || "").replace(/^#/, "") &&
    String(call.metadata?.goal || "") === String(plan?.packet?.goal || "") &&
    String(call.metadata?.planDigest || "") === String(planDigest) &&
    String(call.metadata?.sourcePlanDigest || "") === String(plan?.sourcePlanDigest || "") &&
    Number(call.agent_version) === Number(plan?.agentVersion) &&
    Number(call.metadata?.agentVersion) === Number(plan?.agentVersion) &&
    String(call.metadata?.agentConfigDigest || "") === String(plan?.agentConfigDigest || "") &&
    String(call.metadata?.callbackPacketDigest || "") === String(plan?.callbackPacketDigest || "") &&
    callbackDynamicVariablesDigest(call.retell_llm_dynamic_variables || {}) === String(plan?.callbackPacketDigest || "") &&
    String(call.metadata?.retryOfCallId || "") === String(retryOfCallId || "") &&
    (
      !operatorPrincipalHash
      || (
        call.metadata?.operatorLane === "codex_mac_single_file_claim_filing"
        && String(call.metadata?.operatorPrincipalHash || "") === operatorPrincipalHash
      )
    )
  );
  return row ? {
    planDigest,
    retryOfCallId,
    callId: row.call_id,
    callStatus: row.call_status,
    createdAt: row.start_timestamp ? new Date(row.start_timestamp).toISOString() : ""
  } : null;
}

function claimLedgerReservationMatchesPlan(row, plan, retryOfCallId, operatorPrincipalHash = "") {
  return Boolean(
    String(row?.planDigest || "") === String(plan?.planDigest || "")
    && String(row?.sourcePlanDigest || "") === String(plan?.sourcePlanDigest || "")
    && String(row?.agentId || "") === String(plan?.callPlan?.agentId || "")
    && Number(row?.agentVersion) === Number(plan?.agentVersion)
    && String(row?.agentConfigDigest || "") === String(plan?.agentConfigDigest || "")
    && String(row?.callbackPacketDigest || "") === String(plan?.callbackPacketDigest || "")
    && String(row?.ownerId || "") === CHANCE_OWNER_ID
    && String(row?.contactId || "") === String(plan?.file?.id || "")
    && String(row?.fileNumber || "").replace(/^#/, "") === String(plan?.file?.number || "").replace(/^#/, "")
    && String(row?.goal || "") === String(plan?.packet?.goal || "")
    && String(row?.retryOfCallId || "") === String(retryOfCallId || "")
    && (
      !operatorPrincipalHash
      || (
        String(row?.operatorLane || "") === "codex_mac_single_file_claim_filing"
        && String(row?.principalHash || "") === operatorPrincipalHash
      )
    )
  );
}

async function buildClaimCallResourceSnapshot({ file, ledger, remoteCalls }) {
  const contactId = String(file?.id || "");
  const fileNumber = String(file?.number || "").replace(/^#/, "");
  const rows = (Array.isArray(ledger) ? ledger : []).filter((row) => (
    String(row.contactId || "") === contactId
    && String(row.fileNumber || "").replace(/^#/, "") === fileNumber
    && ["file_new_claim", "find_existing_claim"].includes(String(row.goal || ""))
  ));
  const inventory = Array.isArray(remoteCalls) ? remoteCalls : [];
  const outboundForContact = inventory.filter((call) => claimResourceRemoteCallMatchesFile(call, file));
  const outboundById = new Map(outboundForContact.map((call) => [String(call.call_id || ""), call]));
  const claimedRemoteIds = new Set();
  const unresolvedReservations = [];
  const attempts = [];
  let ledgerChanged = false;

  for (const row of rows) {
    let callId = String(row.callId || "");
    let raw = callId ? outboundById.get(callId) : null;

    if (!callId) {
      const candidates = outboundForContact.filter((call) => claimResourceRemoteCallMatchesLedger(call, row));
      if (candidates.length === 1) {
        raw = candidates[0];
        callId = String(raw.call_id || "");
        row.callId = callId;
        row.callStatus = String(raw.call_status || "");
        row.reconciledAt = new Date().toISOString();
        ledgerChanged = true;
      } else if (candidates.length > 1) {
        attempts.push({
          reconciliationRequired: true,
          reason: "More than one Retell call matches a single durable claim-call reservation for this JobNimbus file. Manual reconciliation is required."
        });
        continue;
      } else if (["provider_pending", "provider_outcome_unknown"].includes(String(row.callStatus || ""))) {
        unresolvedReservations.push(row);
        continue;
      }
    }

    if (!callId) continue;
    if (!raw) {
      try {
        raw = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);
      } catch {
        attempts.push({
          callId,
          reconciliationRequired: true,
          reason: `Durable Retell call ${callId} for this JobNimbus file could not be read from Retell. Manual reconciliation is required.`
        });
        continue;
      }
    }
    claimedRemoteIds.add(String(raw.call_id || ""));
    if (!claimResourceRemoteCallMatchesLedger(raw, row)) {
      attempts.push({
        callId,
        reconciliationRequired: true,
        reason: `Retell call ${callId} no longer matches its durable JobNimbus contact, goal, digest, or operator binding.`
      });
      continue;
    }

    if (String(row.callStatus || "") !== String(raw.call_status || "")) {
      row.callStatus = String(raw.call_status || "");
      row.providerStatusCheckedAt = new Date().toISOString();
      ledgerChanged = true;
    }
    attempts.push(claimResourceAttempt(raw, row, inventory));
  }

  for (const raw of outboundForContact) {
    if (claimedRemoteIds.has(String(raw.call_id || ""))) continue;
    attempts.push({
      callId: String(raw.call_id || ""),
      callStatus: String(raw.call_status || ""),
      createdAt: Number(raw.start_timestamp || 0),
      reconciliationRequired: true,
      reason: `Retell contains claim call ${String(raw.call_id || "(unknown)")} for this JobNimbus file without a matching durable approval reservation. Manual reconciliation is required.`
    });
  }

  return { attempts, unresolvedReservations, ledgerChanged };
}

function claimResourceAttempt(outbound, row, inventory) {
  const continuations = (Array.isArray(inventory) ? inventory : [])
    .filter((call) => claimResourceCallbackMatchesOutbound(call, outbound))
    .sort((left, right) => Number(right.start_timestamp || 0) - Number(left.start_timestamp || 0));
  const continuation = continuations[0] || null;
  const effective = continuation || outbound;
  const extracted = extractCallResults({
    callStatus: String(effective.call_status || ""),
    disconnectionReason: String(effective.disconnection_reason || ""),
    transcript: String(effective.transcript || ""),
    raw: effective
  });
  return {
    callId: String(outbound.call_id || row.callId || ""),
    callStatus: String(outbound.call_status || row.callStatus || ""),
    createdAt: Number(outbound.start_timestamp || Date.parse(row.createdAt || "") || 0),
    goal: String(outbound.metadata?.goal || row.goal || ""),
    outcome: String(extracted.outcome || ""),
    claimNumber: String(extracted.claimNumber || ""),
    callbackConfirmed: Boolean(callbackCandidateFromCall(outbound)?.callbackRequested),
    callbackStatus: continuation ? String(continuation.call_status || "") : ""
  };
}

function claimResourceRemoteCallMatchesFile(call, file) {
  const metadata = call?.metadata || {};
  return Boolean(
    call?.direction === "outbound"
    && String(call.agent_id || "") === RETELL_AGENT_ID
    && metadata.source === "hcn-wave-jobnimbus-bridge"
    && String(metadata.ownerId || "") === CHANCE_OWNER_ID
    && String(metadata.contactId || "") === String(file?.id || "")
    && String(metadata.fileNumber || "").replace(/^#/, "") === String(file?.number || "").replace(/^#/, "")
    && ["file_new_claim", "find_existing_claim"].includes(String(metadata.goal || ""))
  );
}

function claimResourceRemoteCallMatchesLedger(call, row) {
  const metadata = call?.metadata || {};
  return Boolean(
    call?.direction === "outbound"
    && String(call.agent_id || "") === RETELL_AGENT_ID
    && String(row.agentId || "") === RETELL_AGENT_ID
    && metadata.source === "hcn-wave-jobnimbus-bridge"
    && String(metadata.ownerId || "") === CHANCE_OWNER_ID
    && String(row.ownerId || "") === CHANCE_OWNER_ID
    && String(metadata.contactId || "") === String(row.contactId || "")
    && String(metadata.fileNumber || "").replace(/^#/, "") === String(row.fileNumber || "").replace(/^#/, "")
    && String(metadata.goal || "") === String(row.goal || "")
    && String(metadata.planDigest || "") === String(row.planDigest || "")
    && String(metadata.sourcePlanDigest || "") === String(row.sourcePlanDigest || "")
    && Number(call.agent_version) === Number(row.agentVersion)
    && Number(metadata.agentVersion) === Number(row.agentVersion)
    && String(metadata.agentConfigDigest || "") === String(row.agentConfigDigest || "")
    && String(metadata.callbackPacketDigest || "") === String(row.callbackPacketDigest || "")
    && callbackDynamicVariablesDigest(call.retell_llm_dynamic_variables || {}) === String(row.callbackPacketDigest || "")
    && String(metadata.retryOfCallId || "") === String(row.retryOfCallId || "")
    && String(metadata.operatorLane || "") === String(row.operatorLane || "")
    && String(metadata.operatorPrincipalHash || "") === String(row.principalHash || "")
  );
}

function claimResourceCallbackMatchesOutbound(call, outbound) {
  const metadata = call?.metadata || {};
  const original = outbound?.metadata || {};
  return Boolean(
    call?.direction === "inbound"
    && String(call.agent_id || "") === RETELL_AGENT_ID
    && metadata.source === "hcn-wave-jobnimbus-bridge"
    && String(metadata.originalCallId || "") === String(outbound?.call_id || "")
    && String(metadata.ownerId || "") === String(original.ownerId || "")
    && String(metadata.contactId || "") === String(original.contactId || "")
    && String(metadata.fileNumber || "").replace(/^#/, "") === String(original.fileNumber || "").replace(/^#/, "")
    && String(metadata.goal || "") === String(original.goal || "")
    && String(metadata.planDigest || "") === String(original.planDigest || "")
    && String(metadata.sourcePlanDigest || "") === String(original.sourcePlanDigest || "")
    && Number(call.agent_version) === Number(outbound.agent_version)
    && Number(metadata.agentVersion) === Number(original.agentVersion)
    && String(metadata.agentConfigDigest || "") === String(original.agentConfigDigest || "")
    && String(metadata.callbackPacketDigest || "") === String(original.callbackPacketDigest || "")
    && guardedCallPacketDigest(call, "carrier_callback") === String(original.callbackPacketDigest || "")
    && String(metadata.retryOfCallId || "") === String(original.retryOfCallId || "")
    && String(metadata.operatorLane || "") === String(original.operatorLane || "")
    && String(metadata.operatorPrincipalHash || "") === String(original.operatorPrincipalHash || "")
  );
}

async function attachSameCarrierBatch(primaryPlan, primaryContext, input) {
  if (input.includeCarrierBatch === false || primaryPlan.packet.goal !== "file_new_claim") return primaryPlan;
  const carrierKey = normalizeCompare(primaryContext.file.carrier);
  if (!carrierKey) return primaryPlan;

  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const candidates = contacts
    .filter((contact) => isInsuranceFile(contact) && assignedTo(contact, CHANCE_OWNER_ID) && isOpenActive(contact))
    .map((contact) => ({ contact, file: compactContact(contact) }))
    .filter(({ file }) => file.id !== primaryContext.file.id)
    .filter(({ file }) => normalizeCompare(file.carrier) === carrierKey)
    .filter(({ file }) => /(?:ready|waiting) for pa review/i.test(file.status))
    .filter(({ file }) => !String(file.claimNumber || "").trim())
    .sort((a, b) => Number(a.file.number || 0) - Number(b.file.number || 0))
    .slice(0, 6);

  const batchClaims = [];
  for (const { contact, file } of candidates) {
    const candidateInput = {
      file: {
        id: file.id,
        customer: file.name,
        address: file.address,
        carrier: file.carrier,
        policyNumber: file.policyNumber,
        claimNumber: file.claimNumber,
        dateOfLoss: file.dateOfLoss,
        typeOfLoss: file.typeOfLoss,
        status: file.status,
        mortgageCompany: fieldValue(contact, ["Mortgage Company", "mortgage_company", "cf_string_6"]),
        contact,
        adjuster: {}
      },
      evidence: { documents: [], notes: [], tasks: [] },
      captured: {},
      overrides: {}
    };
    const candidatePlan = await buildClaimPlanWithStormTime(input, candidateInput, file);
    if (!candidatePlan.readiness.ready) continue;
    batchClaims.push({
      fileNumber: file.number,
      contactId: file.id,
      insuredName: candidatePlan.packet.verifiedFileFacts.insuredName,
      propertyAddress: candidatePlan.packet.verifiedFileFacts.propertyAddress,
      homeownerPhone: candidatePlan.packet.verifiedFileFacts.homeownerPhone,
      homeownerEmail: candidatePlan.packet.verifiedFileFacts.homeownerEmail,
      policyNumber: candidatePlan.callPlan.dynamicVariables.policyNumberSpoken,
      dateOfLoss: candidatePlan.packet.verifiedFileFacts.dateOfLoss,
      causeOfLoss: candidatePlan.packet.verifiedFileFacts.causeOfLoss,
      injuries: candidatePlan.packet.verifiedFileFacts.injuries,
      homeLivable: candidatePlan.packet.verifiedFileFacts.homeLivable,
      temporaryRepairs: candidatePlan.packet.verifiedFileFacts.temporaryRepairs,
      contractorHired: candidatePlan.packet.verifiedFileFacts.contractorHired
    });
  }

  primaryPlan.callPlan.dynamicVariables.batchClaimCount = String(batchClaims.length);
  primaryPlan.callPlan.dynamicVariables.batchClaims = batchClaims.length ? JSON.stringify(batchClaims) : "None";
  primaryPlan.callPlan.metadata.batchContactIds = batchClaims.map((claim) => claim.contactId).join(",");
  primaryPlan.batchClaims = batchClaims;
  primaryPlan.planDigest = digest({ primaryPlanDigest: primaryPlan.planDigest, batchClaims });
  primaryPlan.callPlan.metadata.planDigest = primaryPlan.planDigest;
  return primaryPlan;
}

async function claimFilingResult(input) {
  const analysis = await loadClaimCallAnalysis(required(input.callId, "callId"));
  if (analysis.call.callStatus === "ongoing" || analysis.call.callStatus === "registered") {
    return {
      mode: "pending",
      file: analysis.file,
      callChain: analysis.callChain,
      call: {
        callId: analysis.call.callId,
        callStatus: analysis.call.callStatus
      },
      approvalRequired: false,
      nextStep: "The carrier call or callback is still active. Review the result again after it ends."
    };
  }
  const proposedCalendarEvent = buildInspectionCalendarProposal(analysis);
  const workflow = buildPostClaimWorkflow(analysis);
  return {
    mode: "read_only",
    file: analysis.file,
    callChain: analysis.callChain,
    call: {
      callId: analysis.call.callId,
      callStatus: analysis.call.callStatus,
      disconnectionReason: analysis.call.disconnectionReason,
      durationMs: analysis.call.durationMs,
      transcript: analysis.call.transcript,
      callSummary: analysis.call.callAnalysis?.call_summary || "",
      callSuccessful: analysis.call.callAnalysis?.call_successful ?? null
    },
    extracted: analysis.extracted,
    completionReview: analysis.completionReview,
    workflow,
    proposedCalendarEvent,
    proposedWriteback: analysis.writeback,
    fieldConfidence: analysis.proposal.fieldConfidence,
    unverified: analysis.proposal.unverified,
    writebackDigest: analysis.writebackDigest,
    approvalRequired: true,
    nextStep: isMacCodexOperatorRequest()
      ? "Review the transcript and extraction. Any JobNimbus field, stage, note, task, or calendar change must be freshly prepared through its separate approved Operator action path; direct claim writeback is unavailable."
      : proposedCalendarEvent?.ready
        ? "Review the result and exact appointment. JobNimbus writeback and calendar creation remain separate approval-gated actions."
        : workflow.applicable
          ? workflow.primaryAction
          : "Review the result and proposed update. Use processApprovedClaimFilingWriteback with this writebackDigest; execute=true writes only after approval."
  };
}

function buildInspectionCalendarProposal(analysis) {
  const extracted = analysis.extracted || {};
  if (extracted.goal !== "inspection_scheduling" || !extracted.inspectionScheduled) return null;
  if (!explicitOffsetDateTime(extracted.inspectionStart) || !explicitOffsetDateTime(extracted.inspectionEnd)) {
    return {
      ready: false,
      reason: "Retell did not return both inspection times as ISO timestamps with an explicit UTC offset. Confirm the transcript before creating a calendar item."
    };
  }

  const dynamicVariables = analysis.call.raw?.retell_llm_dynamic_variables || {};
  let availableWindows = [];
  try {
    const parsed = JSON.parse(String(dynamicVariables.availabilityWindowsJson || "[]"));
    if (Array.isArray(parsed)) availableWindows = parsed;
  } catch {
    availableWindows = [];
  }
  const availability = {
    status: dynamicVariables.availabilityStatus,
    availableWindows
  };
  if (!appointmentFitsAvailability(extracted.inspectionStart, extracted.inspectionEnd, availability)) {
    return {
      ready: false,
      reason: "The extracted appointment does not fit entirely inside the availability approved for this call. Do not create it without reviewing the transcript and calendars."
    };
  }

  return {
    ready: true,
    approvalRequired: true,
    action: "create JobNimbus calendar task",
    request: {
      query: analysis.file.number || analysis.file.id,
      title: `${analysis.file.carrier || "Carrier"} property inspection - ${analysis.file.name}`,
      dateStart: extracted.inspectionStart,
      dateEnd: extracted.inspectionEnd,
      description: extracted.inspectionAccessRequirements || "Carrier property inspection",
      execute: false
    },
    note: "Creating this JobNimbus calendar item requires separate approval."
  };
}

function explicitOffsetDateTime(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    && Number.isFinite(Date.parse(text));
}

async function claimFilingWriteback(input) {
  const analysis = await loadClaimCallAnalysis(required(input.callId, "callId"));
  if (analysis.call.callStatus !== "ended") badRequest("The carrier call is not complete. Review it again after the call ends.");
  assertApprovalDigest(input.writebackDigest, analysis.writebackDigest, "writebackDigest");
  const plan = await buildContactUpdatePlan(analysis.contact, analysis.writeback);

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      file: analysis.file,
      callId: analysis.call.callId,
      writebackDigest: analysis.writebackDigest,
      unverified: analysis.proposal.unverified,
      ...plan
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true only after approving the JobNimbus update.");

  const ledger = await readClaimCallLedger();
  const prior = ledger.find((row) => row.writebackDigest === analysis.writebackDigest && row.writebackAt);
  if (prior) {
    return {
      mode: "duplicate_prevented",
      file: analysis.file,
      callId: analysis.call.callId,
      writebackDigest: analysis.writebackDigest,
      writebackAt: prior.writebackAt,
      note: "This exact approved call result was already written to JobNimbus. No duplicate note or update was created."
    };
  }

  const results = await executeContactUpdatePlan(plan);
  const record = ledger.find((row) => row.callId === analysis.call.callId) || { callId: analysis.call.callId };
  record.writebackDigest = analysis.writebackDigest;
  record.writebackAt = new Date().toISOString();
  if (!ledger.includes(record)) ledger.push(record);
  await writeClaimCallLedger(ledger.slice(-500));
  const memoryCloseout = await closeoutJobNimbusAction(
    analysis.file,
    "claim_call_writeback",
    results.note || results.contact,
    "Applied the separately approved JobNimbus writeback from a completed carrier call."
  );
  return {
    mode: "executed",
    file: analysis.file,
    callId: analysis.call.callId,
    writebackDigest: analysis.writebackDigest,
    results,
    memoryCloseout
  };
}

async function ensureRetellDraftAgentVersion(agentId, agent) {
  const baseVersion = Number(agent?.version);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    badRequest("Retell did not return a usable base agent version.");
  }
  if (agent.is_published !== true) return agent;

  const draft = await retellApi("POST", `/create-agent-version/${encodeURIComponent(agentId)}`, {
    base_version: baseVersion
  });
  const draftVersion = Number(draft?.version);
  if (!Number.isInteger(draftVersion) || draftVersion < 0 || draft.is_published === true) {
    badRequest("Retell did not create an editable draft agent version.");
  }
  return draft;
}

function versionedRetellEndpoint(endpoint, version) {
  const parsed = Number(version);
  if (!Number.isInteger(parsed) || parsed < 0) badRequest("A valid Retell draft version is required.");
  return `${endpoint}?version=${encodeURIComponent(String(parsed))}`;
}

async function configureRetellAgent(input = {}) {
  if (
    !RETELL_API_KEY
    || !RETELL_AGENT_ID
    || !RETELL_FROM_NUMBER
    || !RETELL_GUARDED_END_CALL_TOKEN
    || !RETELL_INBOUND_WEBHOOK_TOKEN
  ) {
    badRequest("Retell claim-agent configuration requires the API key, agent, from number, guarded-end credential, and inbound-webhook credential.");
  }
  const agent = await retellApi("GET", `/get-agent/${encodeURIComponent(RETELL_AGENT_ID)}`);
  const llmId = String(agent?.response_engine?.llm_id || "").trim();
  if (agent?.response_engine?.type !== "retell-llm" || !llmId) {
    badRequest("The configured Retell agent does not use a Retell LLM response engine.");
  }

  const llmConfig = buildRetellLlmFromPacket(retellConfigurationPacket(), {
    guardedEndCallUrl: `${PUBLIC_BASE_URL}/retell/guarded-end-call`,
    guardedEndCallAuthorization: RETELL_GUARDED_END_CALL_TOKEN
      ? `Bearer ${RETELL_GUARDED_END_CALL_TOKEN}`
      : ""
  }).toLlmRequestBody();
  const analysisSchema = postCallAnalysisSchema();
  const phoneConfig = expectedRetellClaimPhoneConfiguration();
  const configDigest = digest({
    agentId: RETELL_AGENT_ID,
    llmId,
    generalPrompt: llmConfig.general_prompt,
    generalTools: llmConfig.general_tools,
    postCallAnalysisData: analysisSchema,
    timeZone: OPERATIONS_TIME_ZONE,
    phoneNumber: phoneConfig.phoneNumber,
    inboundAgents: phoneConfig.inboundAgents,
    inboundWebhookUrl: phoneConfig.inboundWebhookUrl
  });
  const preview = {
    agentId: RETELL_AGENT_ID,
    llmId,
    currentAgentVersion: agent.version,
    currentPublished: Boolean(agent.is_published),
    configDigest,
    promptCharacters: llmConfig.general_prompt.length,
    toolNames: llmConfig.general_tools.map((tool) => tool.name),
    analysisFields: analysisSchema.map((field) => field.name),
    phoneConfigurationDigest: digest(phoneConfig),
    inboundAgentRouting: "unset_fail_closed_webhook_override_only",
    inboundWebhookAuthentication: "dedicated_url_token_plus_retell_hmac_sha256_raw_body_timestamp"
  };

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      publishRequired: true,
      ...preview,
      nextStep: "Review this exact configuration. execute=true updates the latest draft; publish=true also publishes that returned draft version."
    };
  }
  if (input.publish !== true) {
    badRequest("publish=true is required with execute=true so the bridge and live Retell agent cannot be left on different prompt versions.");
  }
  assertApprovalDigest(input.configDigest, configDigest, "configDigest");

  const draftAgent = await ensureRetellDraftAgentVersion(RETELL_AGENT_ID, agent);
  const draftLlmId = String(draftAgent?.response_engine?.llm_id || "").trim();
  const draftLlmVersion = Number(draftAgent?.response_engine?.version);
  if (draftAgent?.response_engine?.type !== "retell-llm" || !draftLlmId || !Number.isInteger(draftLlmVersion)) {
    badRequest("Retell created a carrier-agent draft without a usable Retell LLM draft.");
  }
  const llm = await retellApi("PATCH", versionedRetellEndpoint(`/update-retell-llm/${encodeURIComponent(draftLlmId)}`, draftLlmVersion), {
    general_prompt: llmConfig.general_prompt,
    general_tools: llmConfig.general_tools,
    begin_message: ""
  });
  const llmVersion = Number(llm.version);
  if (!Number.isInteger(llmVersion) || llmVersion < 0) badRequest("Retell updated the LLM but did not return a usable version.");
  const updatedAgent = await retellApi("PATCH", versionedRetellEndpoint(`/update-agent/${encodeURIComponent(RETELL_AGENT_ID)}`, draftAgent.version), {
    response_engine: { type: "retell-llm", llm_id: draftLlmId, version: llmVersion },
    post_call_analysis_data: analysisSchema,
    post_call_analysis_model: "gpt-4.1-mini",
    timezone: OPERATIONS_TIME_ZONE
  });
  const version = Number(updatedAgent.version);
  if (!Number.isInteger(version) || version < 0) badRequest("Retell updated the draft but did not return a publishable agent version.");
  await retellApi("POST", `/publish-agent-version/${encodeURIComponent(RETELL_AGENT_ID)}`, {
    version,
    version_title: "Carrier filing safeguards and verified property facts",
    version_description: "Chance-scoped JobNimbus and Google Calendar scheduling authority with approval-gated calendar writeback."
  });
  await retellApi("PATCH", `/update-phone-number/${encodeURIComponent(RETELL_FROM_NUMBER)}`, {
    inbound_agents: phoneConfig.inboundAgents,
    inbound_webhook_url: phoneConfig.inboundWebhookUrl
  });

  return {
    mode: "executed",
    published: true,
    phoneNumberConfigured: true,
    inboundWebhookConfigured: true,
    ...preview,
    draftAgentVersion: Number(draftAgent.version),
    publishedAgentVersion: version,
    retellLlmVersion: llmVersion,
    nextStep: "Verify the live claim-agent, phone routing, and callback webhook attestation. Do not place a call without Chance's separate approval of one fresh exact-file plan."
  };
}

async function guardedRetellEndCall(input = {}) {
  const suppliedCall = input.call && typeof input.call === "object" ? input.call : {};
  const args = input.args && typeof input.args === "object" ? input.args : input;
  const callId = required(suppliedCall.call_id || input.call_id || args.call_id, "call.call_id");
  const liveCall = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);

  await assertGuardedRetellCallOwnership(liveCall);

  if (String(liveCall.call_status || "") !== "ongoing") {
    return {
      allowed: false,
      code: "call_not_ongoing",
      message: `The call is already ${liveCall.call_status || "not ongoing"}; no stop request was sent.`
    };
  }
  if (RETELL_AGENT_ID && String(liveCall.agent_id || suppliedCall.agent_id || "") !== RETELL_AGENT_ID) {
    return {
      allowed: false,
      code: "wrong_agent",
      message: "This call does not belong to the approved carrier claim-filing agent."
    };
  }

  const reviewCall = {
    ...liveCall,
    metadata: { ...(liveCall.metadata || {}) },
    retell_llm_dynamic_variables: {
      ...(liveCall.retell_llm_dynamic_variables || {})
    },
    transcript_object: Array.isArray(liveCall.transcript_object)
      ? liveCall.transcript_object
      : [],
    transcript: String(liveCall.transcript || "")
  };
  const decision = evaluateGuardedEndCall({ call: reviewCall, args });
  if (!decision.allowed) {
    return {
      ...decision,
      callId,
      instruction: "Do not say a closing line. Remain connected and continue the call according to this reason."
    };
  }

  await retellApi("POST", `/v2/stop-call/${encodeURIComponent(callId)}`);
  return {
    ...decision,
    callId,
    stopped: true,
    message: "The bridge verified completion and ended the call. Do not speak again."
  };
}

async function assertGuardedRetellCallOwnership(liveCall = {}) {
  const metadata = liveCall.metadata || {};
  const principalHash = String(metadata.operatorPrincipalHash || "");
  const contactId = String(metadata.contactId || "");
  const fileNumber = String(metadata.fileNumber || "").replace(/^#/, "");
  const planDigest = String(metadata.planDigest || "");
  const goal = String(metadata.goal || "");
  const retryOfCallId = String(metadata.retryOfCallId || "");
  const sourcePlanDigest = String(metadata.sourcePlanDigest || "");
  const agentVersion = Number(metadata.agentVersion);
  const agentConfigDigest = String(metadata.agentConfigDigest || "");
  const callbackPacketDigest = String(metadata.callbackPacketDigest || "");
  const callLeg = String(metadata.callLeg || "outbound");
  const ledgerCallId = callLeg === "carrier_callback"
    ? String(metadata.originalCallId || "")
    : String(liveCall.call_id || "");
  const ledger = await readClaimCallLedger();
  const row = ledger.find((item) => (
    String(item.callId || "") === ledgerCallId
    && String(item.principalHash || "") === principalHash
    && String(item.operatorLane || "") === "codex_mac_single_file_claim_filing"
  ));
  const owned = Boolean(
    row
    && String(liveCall.agent_id || "") === RETELL_AGENT_ID
    && String(row.agentId || "") === RETELL_AGENT_ID
    && Number(liveCall.agent_version) === Number(row.agentVersion)
    && agentVersion === Number(row.agentVersion)
    && metadata.source === "hcn-wave-jobnimbus-bridge"
    && String(metadata.ownerId || "") === CHANCE_OWNER_ID
    && String(row.ownerId || "") === CHANCE_OWNER_ID
    && metadata.operatorLane === "codex_mac_single_file_claim_filing"
    && validActionBatchPrincipalHash(principalHash)
    && ['file_new_claim', 'find_existing_claim'].includes(goal)
    && String(row.contactId || "") === contactId
    && String(row.fileNumber || "").replace(/^#/, "") === fileNumber
    && String(row.planDigest || "") === planDigest
    && String(row.sourcePlanDigest || "") === sourcePlanDigest
    && String(row.agentConfigDigest || "") === agentConfigDigest
    && String(row.callbackPacketDigest || "") === callbackPacketDigest
    && guardedCallPacketDigest(liveCall, callLeg) === callbackPacketDigest
    && String(row.goal || "") === goal
    && String(row.retryOfCallId || "") === retryOfCallId
    && CHANCE_OPERATOR_RUN_MANIFEST
    && chanceManifestFileBinding(
      CHANCE_OPERATOR_RUN_MANIFEST,
      fileNumber,
      contactId
    )
  );
  if (!owned) {
    const error = new Error("This call is not bound to an approved Mac Operator claim-filing reservation and pinned Chance file.");
    error.statusCode = 403;
    throw error;
  }
}

function guardedCallPacketDigest(liveCall, callLeg) {
  const variables = { ...(liveCall?.retell_llm_dynamic_variables || {}) };
  if (callLeg === "carrier_callback") {
    for (const key of [
      "directionMode",
      "callbackMatch",
      "callbackCarrier",
      "callbackInsuredName",
      "callbackPropertyAddress",
      "callbackPolicyNumber",
      "callbackClaimNumber",
      "pendingCallbackCases",
      "callbackPacketStatus"
    ]) delete variables[key];
  }
  return callbackDynamicVariablesDigest(variables);
}

async function configureClientCoordinatorAgent(input = {}) {
  if (!RETELL_API_KEY || !RETELL_CLIENT_COORDINATOR_AGENT_ID) {
    badRequest("RETELL_API_KEY and RETELL_CLIENT_COORDINATOR_AGENT_ID are required.");
  }
  const agent = await retellApi("GET", `/get-agent/${encodeURIComponent(RETELL_CLIENT_COORDINATOR_AGENT_ID)}`);
  const llmId = String(agent?.response_engine?.llm_id || "").trim();
  if (agent?.response_engine?.type !== "retell-llm" || !llmId) {
    badRequest("The configured Retell Client Coordinator does not use a Retell LLM response engine.");
  }

  const llmConfig = buildClientCoordinatorLlmConfig();
  const agentSettings = buildClientCoordinatorAgentSettings();
  const analysisSchema = clientCoordinatorAnalysisSchema();
  const configDigest = digest({
    agentId: RETELL_CLIENT_COORDINATOR_AGENT_ID,
    llmId,
    generalPrompt: llmConfig.general_prompt,
    generalTools: llmConfig.general_tools,
    beginMessage: llmConfig.begin_message,
    startSpeaker: llmConfig.start_speaker,
    agentSettings,
    postCallAnalysisData: analysisSchema,
    timeZone: OPERATIONS_TIME_ZONE
  });
  const preview = {
    agentId: RETELL_CLIENT_COORDINATOR_AGENT_ID,
    llmId,
    currentAgentVersion: agent.version,
    currentPublished: Boolean(agent.is_published),
    supportedModes: ["appointment_confirmation", "missing_document_request", "status_update", "client_check_in"],
    configDigest,
    promptCharacters: llmConfig.general_prompt.length,
    toolNames: llmConfig.general_tools.map((tool) => tool.name),
    analysisFields: analysisSchema.map((field) => field.name),
    exactConfiguration: {
      generalPrompt: llmConfig.general_prompt,
      generalTools: llmConfig.general_tools,
      beginMessage: llmConfig.begin_message,
      startSpeaker: llmConfig.start_speaker,
      agentSettings,
      postCallAnalysisData: analysisSchema,
      timeZone: OPERATIONS_TIME_ZONE
    }
  };

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      publishRequired: true,
      ...preview,
      nextStep: "Review the exact prompt, tools, extraction fields, and digest with Chance. Nothing is changed in Retell until the unchanged configuration is approved."
    };
  }
  if (input.publish !== true) {
    badRequest("publish=true is required with execute=true so the live Client Coordinator cannot drift from the reviewed prompt.");
  }
  assertApprovalDigest(input.configDigest, configDigest, "configDigest");

  const draftAgent = await ensureRetellDraftAgentVersion(RETELL_CLIENT_COORDINATOR_AGENT_ID, agent);
  const draftLlmId = String(draftAgent?.response_engine?.llm_id || "").trim();
  const draftLlmVersion = Number(draftAgent?.response_engine?.version);
  if (draftAgent?.response_engine?.type !== "retell-llm" || !draftLlmId || !Number.isInteger(draftLlmVersion)) {
    badRequest("Retell created a Client Coordinator draft without a usable Retell LLM draft.");
  }
  const llm = await retellApi("PATCH", versionedRetellEndpoint(`/update-retell-llm/${encodeURIComponent(draftLlmId)}`, draftLlmVersion), {
    general_prompt: llmConfig.general_prompt,
    general_tools: llmConfig.general_tools,
    begin_message: llmConfig.begin_message,
    start_speaker: llmConfig.start_speaker
  });
  const llmVersion = Number(llm.version);
  if (!Number.isInteger(llmVersion) || llmVersion < 0) {
    badRequest("Retell updated the Client Coordinator LLM but did not return a usable version.");
  }
  const updatedAgent = await retellApi("PATCH", versionedRetellEndpoint(`/update-agent/${encodeURIComponent(RETELL_CLIENT_COORDINATOR_AGENT_ID)}`, draftAgent.version), {
    response_engine: { type: "retell-llm", llm_id: draftLlmId, version: llmVersion },
    ...agentSettings,
    post_call_analysis_data: analysisSchema,
    post_call_analysis_model: "gpt-4.1-mini",
    timezone: OPERATIONS_TIME_ZONE
  });
  const version = Number(updatedAgent.version);
  if (!Number.isInteger(version) || version < 0) {
    badRequest("Retell updated the Client Coordinator draft but did not return a publishable version.");
  }
  await retellApi("POST", `/publish-agent-version/${encodeURIComponent(RETELL_CLIENT_COORDINATOR_AGENT_ID)}`, {
    version,
    version_title: "HCN Wave Client Coordinator",
    version_description: "Approval-gated client coordination using fresh Chance evidence, verified Brain reminders, and review-only post-call follow-ups."
  });

  return {
    mode: "executed",
    published: true,
    ...preview,
    draftAgentVersion: Number(draftAgent.version),
    publishedAgentVersion: version,
    retellLlmVersion: llmVersion,
    nextStep: "Keep expanded modes disabled until Chance reviews one dry-run call plan. No call was placed by this configuration action."
  };
}

async function configureCarrierFollowUpAgent(input = {}) {
  if (!RETELL_API_KEY || !RETELL_CARRIER_FOLLOWUP_AGENT_ID) {
    badRequest("RETELL_API_KEY and RETELL_CARRIER_FOLLOWUP_AGENT_ID are required.");
  }
  const agent = await retellApi("GET", `/get-agent/${encodeURIComponent(RETELL_CARRIER_FOLLOWUP_AGENT_ID)}`);
  const llmId = String(agent?.response_engine?.llm_id || "").trim();
  if (agent?.response_engine?.type !== "retell-llm" || !llmId) {
    badRequest("The configured Retell Carrier Follow-Up agent does not use a Retell LLM response engine.");
  }

  const llmConfig = buildCarrierFollowUpLlmConfig();
  const agentSettings = buildCarrierFollowUpAgentSettings();
  const analysisSchema = carrierFollowUpAnalysisSchema();
  const configDigest = digest({
    agentId: RETELL_CARRIER_FOLLOWUP_AGENT_ID,
    llmId,
    generalPrompt: llmConfig.general_prompt,
    generalTools: llmConfig.general_tools,
    beginMessage: llmConfig.begin_message,
    startSpeaker: llmConfig.start_speaker,
    agentSettings,
    postCallAnalysisData: analysisSchema,
    timeZone: OPERATIONS_TIME_ZONE
  });
  const preview = {
    agentId: RETELL_CARRIER_FOLLOWUP_AGENT_ID,
    llmId,
    currentAgentVersion: agent.version,
    currentPublished: Boolean(agent.is_published),
    supportedGoals: CARRIER_FOLLOW_UP_GOALS,
    supportedDestinations: CARRIER_DESTINATION_TYPES,
    configDigest,
    promptCharacters: llmConfig.general_prompt.length,
    toolNames: llmConfig.general_tools.map((tool) => tool.name),
    analysisFields: analysisSchema.map((field) => field.name),
    exactConfiguration: {
      generalPrompt: llmConfig.general_prompt,
      generalTools: llmConfig.general_tools,
      beginMessage: llmConfig.begin_message,
      startSpeaker: llmConfig.start_speaker,
      agentSettings,
      postCallAnalysisData: analysisSchema,
      timeZone: OPERATIONS_TIME_ZONE
    }
  };

  if (input.execute !== true) {
    return {
      mode: "dry_run",
      approvalRequired: true,
      publishRequired: true,
      ...preview,
      nextStep: "Review the exact prompt, tools, extraction fields, and digest. Nothing is changed in Retell and no call is placed."
    };
  }
  if (input.publish !== true) {
    badRequest("publish=true is required with execute=true so the live Carrier Follow-Up agent cannot drift from the reviewed prompt.");
  }
  assertApprovalDigest(input.configDigest, configDigest, "configDigest");

  const draftAgent = await ensureRetellDraftAgentVersion(RETELL_CARRIER_FOLLOWUP_AGENT_ID, agent);
  const draftLlmId = String(draftAgent?.response_engine?.llm_id || "").trim();
  const draftLlmVersion = Number(draftAgent?.response_engine?.version);
  if (draftAgent?.response_engine?.type !== "retell-llm" || !draftLlmId || !Number.isInteger(draftLlmVersion)) {
    badRequest("Retell created a Carrier Follow-Up draft without a usable Retell LLM draft.");
  }
  const llm = await retellApi("PATCH", versionedRetellEndpoint(`/update-retell-llm/${encodeURIComponent(draftLlmId)}`, draftLlmVersion), {
    general_prompt: llmConfig.general_prompt,
    general_tools: llmConfig.general_tools,
    begin_message: llmConfig.begin_message,
    start_speaker: llmConfig.start_speaker
  });
  const llmVersion = Number(llm.version);
  if (!Number.isInteger(llmVersion) || llmVersion < 0) {
    badRequest("Retell updated the Carrier Follow-Up LLM but did not return a usable version.");
  }
  const updatedAgent = await retellApi("PATCH", versionedRetellEndpoint(`/update-agent/${encodeURIComponent(RETELL_CARRIER_FOLLOWUP_AGENT_ID)}`, draftAgent.version), {
    response_engine: { type: "retell-llm", llm_id: draftLlmId, version: llmVersion },
    ...agentSettings,
    post_call_analysis_data: analysisSchema,
    post_call_analysis_model: "gpt-4.1-mini",
    timezone: OPERATIONS_TIME_ZONE
  });
  const version = Number(updatedAgent.version);
  if (!Number.isInteger(version) || version < 0) {
    badRequest("Retell updated the Carrier Follow-Up draft but did not return a publishable version.");
  }
  await retellApi("POST", `/publish-agent-version/${encodeURIComponent(RETELL_CARRIER_FOLLOWUP_AGENT_ID)}`, {
    version,
    version_title: "HCN Wave Carrier Follow-Up",
    version_description: "Approval-gated carrier, adjuster, inspector, appointment, and document follow-up with review-only results."
  });

  return {
    mode: "executed",
    published: true,
    ...preview,
    draftAgentVersion: Number(draftAgent.version),
    publishedAgentVersion: version,
    retellLlmVersion: llmVersion,
    nextStep: "Prepare a dry-run carrier follow-up plan for one Chance file. No call was placed by this configuration action."
  };
}

function retellConfigurationPacket() {
  return {
    informationToCapture: [
      "claim or reference number",
      "representative and adjuster contact information",
      "document-submission destination and subject rule",
      "confirmed inspection date, arrival window, timezone, and access requirements",
      "carrier next step and expected timeframe"
    ],
    stopRules: [
      "Never guess a client, claim, policy, date, damage fact, or appointment time.",
      "Never schedule outside the merged availability supplied for the call.",
      "Never provide sensitive identity, banking, card, PIN, or password information.",
      "Never update JobNimbus or send a carrier email from the phone call."
    ],
    resultFormat: {
      objectiveCompleted: "yes/no/partial",
      claimNumber: "",
      adjuster: {},
      inspection: { scheduled: false, start: "", end: "", timezone: "", accessRequirements: "" },
      documentSubmission: "",
      nextStep: "",
      blocker: ""
    }
  };
}

async function retellInbound(input) {
  const event = input?.event;
  const inbound = input?.call_inbound;
  if (event !== "call_inbound" || !inbound?.from_number || !inbound?.to_number) {
    badRequest("Expected a Retell call_inbound webhook payload.");
  }
  if (String(inbound.to_number) !== RETELL_FROM_NUMBER) {
    return rejectedRetellInbound();
  }

  const retellConfiguration = await claimFilingConfiguration();
  if (retellConfiguration.ready !== true) return rejectedRetellInbound();
  const discoveredCandidates = await recentCallbackCandidates(inbound.from_number);
  const candidates = await durableApprovedCallbackCandidates(
    discoveredCandidates,
    retellConfiguration
  );
  const { selected, match } = selectCallbackCandidate(candidates, inbound.from_number);
  if (!selected || match !== "matched") return rejectedRetellInbound();
  const dynamicVariables = buildCallbackDynamicVariables(selected, match);
  if (dynamicVariables.callbackPacketStatus !== "READY") return rejectedRetellInbound();

  if (String(dynamicVariables.goal || "") === "inspection_scheduling") {
    const availability = await collectUnifiedSchedulingAvailability();
    applyAvailabilityDynamicVariables(dynamicVariables, availability);
  }

  const metadata = buildCallbackMetadata(selected, match);

  return {
    call_inbound: {
      override_agent_id: RETELL_AGENT_ID,
      override_agent_version: selected.agentVersion,
      dynamic_variables: dynamicVariables,
      metadata
    }
  };
}

function rejectedRetellInbound() {
  return { call_inbound: { reject: true } };
}

async function durableApprovedCallbackCandidates(candidates, retellConfiguration) {
  const [ledger, approvals] = await Promise.all([
    readClaimCallLedger(),
    readSecurityLedger(ACTION_APPROVAL_STORE_PATH, "Action approval ledger")
  ]);
  if (!ledger.length || !approvals.length) return [];
  const liveAgentVersion = Number(retellConfiguration?.agentVersion);
  const liveAgentConfigDigest = String(retellConfiguration?.agentConfigDigest || "");
  const cutoff = Date.now() - (RETELL_CALLBACK_TTL_HOURS * 60 * 60 * 1000);
  if (!Number.isInteger(liveAgentVersion) || !liveAgentConfigDigest) return [];

  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const row = ledger.find((item) => String(item.callId || "") === String(candidate.callId || ""));
    if (!row) return false;
    const approval = approvals.find((item) => String(item.id || "") === String(row.approvalId || ""));
    const principalHash = String(row.principalHash || "");
    const actualPacketDigest = callbackDynamicVariablesDigest(candidate.dynamicVariables || {});
    const callbackVariables = buildCallbackDynamicVariables(candidate, "matched");
    const fileNumber = String(candidate.fileNumber || "").replace(/^#/, "");
    const contactId = String(candidate.contactId || "");
    const reconstructedPlanDigest = digest({
      mode: "retell_claim_call_v1",
      sourcePlanDigest: String(candidate.sourcePlanDigest || ""),
      retryOfCallId: String(candidate.retryOfCallId || ""),
      agentId: String(candidate.agentId || ""),
      agentVersion: candidate.agentVersion,
      agentConfigDigest: String(candidate.agentConfigDigest || ""),
      callbackPacketDigest: String(candidate.callbackPacketDigest || "")
    });
    return Boolean(
      approval
      && approval.status === "consumed"
      && approval.approvalKind === "claim_filing_call"
      && approval.approvalDigest === row.planDigest
      && approval.identityHash === principalHash
      && Number(approval.operationCount) === 1
      && validActionBatchPrincipalHash(principalHash)
      && row.operatorLane === "codex_mac_single_file_claim_filing"
      && candidate.operatorLane === "codex_mac_single_file_claim_filing"
      && candidate.operatorPrincipalHash === principalHash
      && candidate.agentId === RETELL_AGENT_ID
      && String(row.agentId || "") === RETELL_AGENT_ID
      && candidate.agentVersion === liveAgentVersion
      && candidate.reportedAgentVersion === liveAgentVersion
      && Number(row.agentVersion) === liveAgentVersion
      && candidate.agentConfigDigest === liveAgentConfigDigest
      && String(row.agentConfigDigest || "") === liveAgentConfigDigest
      && candidate.ownerId === CHANCE_OWNER_ID
      && String(row.ownerId || "") === CHANCE_OWNER_ID
      && candidate.callStatus === "ended"
      && Number.isFinite(Number(candidate.createdAt))
      && Number(candidate.createdAt) >= cutoff
      && Number.isFinite(Date.parse(String(row.createdAt || "")))
      && Date.parse(String(row.createdAt || "")) >= cutoff
      && ['file_new_claim', 'find_existing_claim'].includes(String(candidate.goal || ""))
      && String(row.contactId || "") === contactId
      && String(row.fileNumber || "").replace(/^#/, "") === fileNumber
      && String(row.planDigest || "") === String(candidate.planDigest || "")
      && reconstructedPlanDigest === String(candidate.planDigest || "")
      && String(row.sourcePlanDigest || "") === String(candidate.sourcePlanDigest || "")
      && String(row.goal || "") === String(candidate.goal || "")
      && String(row.retryOfCallId || "") === String(candidate.retryOfCallId || "")
      && String(row.callbackPacketDigest || "") === String(candidate.callbackPacketDigest || "")
      && candidate.callbackPacketDigest === actualPacketDigest
      && callbackVariables.callbackPacketStatus === "READY"
      && CHANCE_OPERATOR_RUN_MANIFEST
      && chanceManifestFileBinding(CHANCE_OPERATOR_RUN_MANIFEST, fileNumber, contactId)
    );
  });
}

async function recentCallbackCandidates(fromNumber) {
  if (!RETELL_API_KEY) return [];
  const response = await retellApi("POST", "/v3/list-calls", {
    filter_criteria: {},
    sort_order: "descending",
    limit: 100
  });
  const cutoff = Date.now() - (RETELL_CALLBACK_TTL_HOURS * 60 * 60 * 1000);
  const rows = response.items || [];
  const continuedCallIds = new Set(rows
    .filter((call) => call.direction === "inbound" && call.metadata?.originalCallId)
    .map((call) => String(call.metadata.originalCallId)));
  const candidates = rows
    .filter((call) => call.direction === "outbound")
    .filter((call) => String(call.agent_id || "") === RETELL_AGENT_ID)
    .filter((call) => ['file_new_claim', 'find_existing_claim'].includes(String(call.metadata?.goal || "")))
    .map(callbackCandidateFromCall)
    .filter(Boolean)
    .filter((candidate) => candidate.callbackRequested)
    .filter((candidate) => !continuedCallIds.has(candidate.callId))
    .filter((candidate) => !candidate.createdAt || candidate.createdAt >= cutoff)
    .sort((a, b) => {
      const aExact = samePhone(a.carrierPhone, fromNumber) ? 1 : 0;
      const bExact = samePhone(b.carrierPhone, fromNumber) ? 1 : 0;
      return bExact - aExact || b.createdAt - a.createdAt;
    });
  const seenContacts = new Set();
  return candidates.filter((candidate) => {
    if (seenContacts.has(candidate.contactId)) return false;
    seenContacts.add(candidate.contactId);
    return true;
  });
}

function callbackCaseLabel(candidate) {
  const policySuffix = String(candidate.policyNumberSpoken || candidate.policyNumber || "").replace(/\W/g, "").slice(-4);
  return [candidate.carrier, candidate.insuredName, candidate.propertyAddress, policySuffix ? `policy ending ${policySuffix}` : ""]
    .filter(Boolean)
    .join("; ");
}

async function pendingClaimCallbacks() {
  let candidates = await recentCallbackCandidates("");
  if (isMacCodexOperatorRequest()) {
    const principalHash = actionApprovalIdentityHash();
    const ledger = await readClaimCallLedger();
    candidates = candidates.filter((candidate) => {
      const row = ledger.find((item) => (
        String(item.callId || "") === String(candidate.callId || "")
        && String(item.principalHash || "") === principalHash
        && String(item.operatorLane || "") === "codex_mac_single_file_claim_filing"
      ));
      if (!row) return false;
      if (candidate.agentId !== RETELL_AGENT_ID) return false;
      if (candidate.ownerId !== CHANCE_OWNER_ID) return false;
      if (candidate.operatorLane !== "codex_mac_single_file_claim_filing") return false;
      if (candidate.operatorPrincipalHash !== principalHash) return false;
      if (!['file_new_claim', 'find_existing_claim'].includes(String(candidate.goal || ""))) return false;
      if (String(row.contactId || "") !== String(candidate.contactId || "")) return false;
      if (String(row.fileNumber || "").replace(/^#/, "") !== String(candidate.fileNumber || "").replace(/^#/, "")) return false;
      if (String(row.planDigest || "") !== String(candidate.planDigest || "")) return false;
      if (String(row.goal || "") !== String(candidate.goal || "")) return false;
      if (String(row.retryOfCallId || "") !== String(candidate.retryOfCallId || "")) return false;
      return Boolean(
        CHANCE_OPERATOR_RUN_MANIFEST
        && chanceManifestFileBinding(
          CHANCE_OPERATOR_RUN_MANIFEST,
          String(candidate.fileNumber || "").replace(/^#/, ""),
          String(candidate.contactId || "")
        )
      );
    });
  }
  return {
    mode: "read_only",
    callbackTtlHours: RETELL_CALLBACK_TTL_HOURS,
    count: candidates.length,
    callbacks: candidates.map((candidate) => ({
      originalCallId: candidate.callId,
      fileNumber: candidate.fileNumber,
      contactId: candidate.contactId,
      carrier: candidate.carrier,
      insuredName: candidate.insuredName,
      propertyAddress: candidate.propertyAddress,
      policyNumberSpoken: candidate.policyNumberSpoken,
      dateOfLoss: candidate.dynamicVariables?.dateOfLoss || "Missing",
      causeOfLoss: candidate.dynamicVariables?.causeOfLoss || "Missing",
      callbackPacketStatus: buildCallbackDynamicVariables(candidate, "matched").callbackPacketStatus,
      requestedAt: candidate.createdAt ? new Date(candidate.createdAt).toISOString() : ""
    }))
  };
}

function samePhone(a, b) {
  const left = String(a || "").replace(/\D/g, "").slice(-10);
  const right = String(b || "").replace(/\D/g, "").slice(-10);
  return Boolean(left && right && left === right);
}

function retellInboundAuthorized(url) {
  if (!RETELL_INBOUND_WEBHOOK_TOKEN) return false;
  return secureEqual(String(url.searchParams.get("token") || ""), RETELL_INBOUND_WEBHOOK_TOKEN);
}

function retellInboundSignatureAuthorized(req, rawBody) {
  if (!RETELL_API_KEY || !Buffer.isBuffer(rawBody)) return false;
  const header = String(req.headers["x-retell-signature"] || "").trim();
  const fields = Object.fromEntries(header.split(",").map((part) => {
    const separator = part.indexOf("=");
    return separator > 0
      ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
      : ["", ""];
  }));
  const timestamp = String(fields.v || "");
  const suppliedDigest = String(fields.d || "").toLowerCase();
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(suppliedDigest)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
  const expectedDigest = createHmac("sha256", RETELL_API_KEY)
    .update(rawBody)
    .update(timestamp, "utf8")
    .digest("hex");
  return secureEqual(suppliedDigest, expectedDigest);
}

async function buildLiveClaimContext(query) {
  const { contact, alternatives } = await findChanceContact(query);
  const [activities, tasks, documents] = await Promise.all([
    listRelated("/activities", contact.jnid, 100),
    listRelated("/tasks", contact.jnid, 100),
    listRelated("/files", contact.jnid, 1000)
  ]);
  const claimDocuments = documents.filter(isClaimEvidenceDocument);
  const claimScopeText = await extractClaimScopeEvidence(claimDocuments);
  const file = compactContact(contact);
  return {
    contact,
    file,
    canonicalInput: {
      file: {
        id: file.id,
        customer: file.name,
        address: file.address,
        carrier: file.carrier,
        policyNumber: file.policyNumber,
        claimNumber: file.claimNumber,
        dateOfLoss: file.dateOfLoss,
        typeOfLoss: file.typeOfLoss,
        status: file.status,
        mortgageCompany: fieldValue(contact, ["Mortgage Company", "mortgage_company", "cf_string_6"]),
        contact,
        adjuster: {
          name: file.adjusterName,
          phone: file.adjusterPhone,
          email: file.adjusterEmail
        }
      },
      evidence: {
        documents: claimDocuments.map((document) => ({ name: compactDocument(document).name })),
        notes: [
          ...activities.map((activity) => ({ body: activity.note || activity.description || "" })),
          ...(claimScopeText ? [{ body: claimScopeText }] : [])
        ],
        tasks: tasks.map((task) => ({ title: task.title || task.subject || "" }))
      },
      captured: {},
      overrides: {}
    },
    evidenceSummary: {
      activitiesReviewed: activities.length,
      tasksReviewed: tasks.length,
      documentsReviewed: claimDocuments.length,
      scopeDocumentRead: Boolean(claimScopeText),
      photoFilesExcluded: documents.length - claimDocuments.length,
      alternatives: alternatives.map(compactContact)
    }
  };
}

async function extractClaimScopeEvidence(documents) {
  const document = documents.find((item) => /(?:estimate|final\s*draft|scope)/i.test(compactDocument(item).name));
  if (!document) return "";
  const id = String(document.jnid || document.id || compactDocument(document).name || "");
  if (claimScopeTextCache.has(id)) return claimScopeTextCache.get(id);
  try {
    const downloaded = await downloadJobNimbusFile(document);
    const extracted = await extractDocumentText(downloaded, document, 30000, { forceOcr: false, maxOcrPages: 1 });
    const text = extracted.text || "";
    claimScopeTextCache.set(id, text);
    if (claimScopeTextCache.size > 100) claimScopeTextCache.delete(claimScopeTextCache.keys().next().value);
    return text;
  } catch {
    claimScopeTextCache.set(id, "");
    return "";
  }
}

function isClaimEvidenceDocument(document) {
  const name = compactDocument(document).name;
  const contentType = String(document.content_type || document.mime_type || document.type || "").toLowerCase();
  if (contentType.startsWith("image/")) return false;
  if (/\.(?:png|jpe?g|gif|heic|webp|tiff?|bmp)$/i.test(name)) return false;
  if (/\b(?:photo report|photo file|job photos|inspection photos|companycam)\b/i.test(name)) return false;
  return Boolean(name);
}

function claimPlanOptions(input, file) {
  return {
    ownerId: CHANCE_OWNER_ID,
    fileNumber: file.number,
    agentId: RETELL_AGENT_ID,
    from: RETELL_FROM_NUMBER,
    to: input.to,
    goal: input.goal,
    carrierPhone: input.carrierPhone,
    stormTime: input.stormTime,
    occupancy: input.occupancy,
    damageDiscovered: input.damageDiscovered,
    propertyStories: input.propertyStories,
    roofAccessibility: input.roofAccessibility,
    damagedRooms: input.damagedRooms,
    damagedRoomCount: input.damagedRoomCount,
    contractorPhone: input.contractorPhone,
    injuries: input.injuries,
    homeLivable: input.homeLivable,
    temporaryRepairs: input.temporaryRepairs,
    contractorHired: input.contractorHired,
    overrides: input.overrides && typeof input.overrides === "object" ? input.overrides : {}
  };
}

async function buildClaimPlanWithStormTime(input, canonicalInput, file) {
  const timing = await resolveClaimStormTime(input, canonicalInput, file);
  const options = claimPlanOptions(input, file);
  if (timing.stormTime) options.stormTime = timing.stormTime;
  const plan = buildClaimFilingPlan(canonicalInput, options);
  plan.stormTimeEvidence = timing.evidence;
  if (timing.warning && !plan.readiness.warnings.includes(timing.warning)) {
    plan.readiness.warnings.push(timing.warning);
  }
  return plan;
}

async function resolveClaimStormTime(input, canonicalInput, file) {
  const supplied = String(input.stormTime || input.overrides?.stormTime || "").trim();
  if (hasClockTime(supplied)) {
    return {
      stormTime: supplied,
      evidence: { source: "chance_approved_or_file_specific_time", value: supplied, verifiedWeatherMatch: false }
    };
  }

  const dol = isoDateFromClaimValue(file.dateOfLoss || canonicalInput.file?.dateOfLoss);
  const cause = String(file.typeOfLoss || canonicalInput.file?.typeOfLoss || "");
  const address = String(file.address || canonicalInput.file?.address || "").trim();
  if (dol && address && /hail/i.test(cause)) {
    try {
      const research = await researchPropertyHailDates({
        address,
        state: addressState(address),
        startDate: shiftIsoDate(dol, -1),
        endDate: shiftIsoDate(dol, 1),
        radiusMiles: 35,
        minimumHailInches: 1,
        limit: 10
      }, {
        geocoderUrl: CENSUS_GEOCODER_URL,
        reportsUrl: HAIL_REPORTS_URL
      });
      const candidate = research.candidates.find((row) => row.date === dol);
      const report = candidate?.nearestReport;
      if (candidate && report?.localTime) {
        const value = `Approximately ${report.localTime} based on a nearby reported hail event`;
        return {
          stormTime: value,
          evidence: {
            source: "NWS Local Storm Report via Iowa Environmental Mesonet",
            dateMatchedToJobNimbusDol: dol,
            value,
            confidence: candidate.confidence,
            hailInches: report.hailInches,
            distanceMiles: report.distanceMiles,
            reportedLocation: report.location,
            reportedAtUtc: report.reportedAtUtc,
            localDateTime: report.localDateTime,
            verifiedWeatherMatch: true,
            caution: "This is the time of a nearby reported hail observation, not a property-specific eyewitness time."
          }
        };
      }
    } catch (error) {
      return {
        stormTime: supplied,
        evidence: supplied
          ? { source: "chance_approved_approximation", value: supplied, verifiedWeatherMatch: false }
          : { source: "weather_research_unavailable", verifiedWeatherMatch: false },
        warning: `Storm-time weather research was unavailable: ${String(error.message || error).slice(0, 180)}`
      };
    }
  }

  if (supplied) {
    return {
      stormTime: supplied,
      evidence: { source: "chance_approved_approximation", value: supplied, verifiedWeatherMatch: false },
      warning: "Storm time is an approved approximation, not a verified property-specific time."
    };
  }
  return {
    stormTime: "",
    evidence: { source: "not_found", verifiedWeatherMatch: false },
    warning: "No verified or nearby reported storm time was found; Retell must say the exact time is unknown if asked."
  };
}

function hasClockTime(value) {
  return /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|0?[1-9])\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(String(value || ""));
}

function isoDateFromClaimValue(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  if (/^\d{10,13}$/.test(text)) {
    const millis = text.length === 10 ? Number(text) * 1000 : Number(text);
    // JobNimbus DOL is a date-only custom field encoded at UTC midnight.
    return new Date(millis).toISOString().slice(0, 10);
  }
  return "";
}

function addressState(address) {
  return String(address).match(/,\s*([A-Z]{2})(?:\s+\d{5})?(?:-|,|$)/i)?.[1]?.toUpperCase() || "";
}

async function loadClaimCallAnalysis(callId) {
  if (!RETELL_API_KEY) badRequest("RETELL_API_KEY is not configured.");
  const requestedRaw = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);
  const continuation = await latestCallbackContinuation(requestedRaw.call_id);
  const raw = continuation || requestedRaw;
  const call = {
    callId: raw.call_id,
    callStatus: raw.call_status,
    disconnectionReason: raw.disconnection_reason,
    durationMs: raw.duration_ms,
    transcript: raw.transcript || "",
    callAnalysis: raw.call_analysis || {},
    raw
  };
  const metadata = validateRetellCallChainOwnership(
    { raw: requestedRaw, callId: requestedRaw.call_id },
    continuation ? { raw: continuation, callId: continuation.call_id } : null,
    CHANCE_OWNER_ID
  );
  if (isMacCodexOperatorRequest()) {
    const principalHash = actionApprovalIdentityHash();
    const ledger = await readClaimCallLedger();
    const row = ledger.find((item) => (
      String(item.callId || "") === String(requestedRaw.call_id || "")
      && String(item.principalHash || "") === principalHash
      && String(item.operatorLane || "") === "codex_mac_single_file_claim_filing"
    ));
    const metadataFileNumber = String(requestedRaw.metadata?.fileNumber || "").replace(/^#/, "");
    const metadataContactId = String(requestedRaw.metadata?.contactId || "");
    const continuationMetadata = continuation?.metadata || {};
    const continuationMatches = !continuation || Boolean(
      String(continuation.agent_id || "") === RETELL_AGENT_ID
      && String(continuationMetadata.source || "") === "hcn-wave-jobnimbus-bridge"
      && String(continuationMetadata.ownerId || "") === CHANCE_OWNER_ID
      && String(continuationMetadata.contactId || "") === metadataContactId
      && String(continuationMetadata.fileNumber || "").replace(/^#/, "") === metadataFileNumber
      && String(continuationMetadata.goal || "") === String(requestedRaw.metadata?.goal || "")
      && String(continuationMetadata.planDigest || "") === String(requestedRaw.metadata?.planDigest || "")
      && String(continuationMetadata.operatorLane || "") === "codex_mac_single_file_claim_filing"
      && String(continuationMetadata.operatorPrincipalHash || "") === principalHash
      && String(continuationMetadata.originalCallId || "") === String(requestedRaw.call_id || "")
    );
    const operatorOwned = Boolean(
      row
      && String(requestedRaw.agent_id || "") === RETELL_AGENT_ID
      && String(requestedRaw.metadata?.operatorLane || "") === "codex_mac_single_file_claim_filing"
      && String(requestedRaw.metadata?.operatorPrincipalHash || "") === principalHash
      && ['file_new_claim', 'find_existing_claim'].includes(String(requestedRaw.metadata?.goal || ""))
      && String(row.contactId || "") === metadataContactId
      && String(row.fileNumber || "").replace(/^#/, "") === metadataFileNumber
      && String(row.planDigest || "") === String(requestedRaw.metadata?.planDigest || "")
      && String(row.goal || "") === String(requestedRaw.metadata?.goal || "")
      && String(row.retryOfCallId || "") === String(requestedRaw.metadata?.retryOfCallId || "")
      && continuationMatches
      && CHANCE_OPERATOR_RUN_MANIFEST
      && chanceManifestFileBinding(
        CHANCE_OPERATOR_RUN_MANIFEST,
        metadataFileNumber,
        metadataContactId
      )
    );
    if (!operatorOwned) {
      const error = new Error("This Retell result is not bound to the current Mac operator principal and pinned Chance file manifest.");
      error.statusCode = 403;
      throw error;
    }
  }
  const { contact } = await findChanceContact(metadata.contactId);
  const file = compactContact(contact);
  const result = analyzeClaimCall(call, {
    id: file.id,
    customer: file.name,
    status: file.status,
    carrier: file.carrier
  });
  const callChain = [requestedRaw, ...(continuation ? [continuation] : [])].map((item) => ({
    callId: item.call_id,
    direction: item.direction || "",
    callLeg: item.metadata?.callLeg || (item.call_id === requestedRaw.call_id ? "outbound" : "carrier_callback"),
    callStatus: item.call_status,
    originalCallId: item.metadata?.originalCallId || ""
  }));
  return { call, callChain, metadata, contact, file, ...result };
}

async function latestCallbackContinuation(originalCallId) {
  if (!originalCallId) return null;
  const response = await retellApi("POST", "/v3/list-calls", {
    filter_criteria: {},
    sort_order: "descending",
    limit: 100
  });
  const match = (response.items || []).find((item) =>
    item.direction === "inbound" && String(item.metadata?.originalCallId || "") === String(originalCallId)
  );
  return match?.call_id ? retellApi("GET", `/v2/get-call/${encodeURIComponent(match.call_id)}`) : null;
}

async function retellApi(method, endpoint, body) {
  if (!RETELL_API_KEY) badRequest("RETELL_API_KEY is not configured.");
  const response = await fetch(`${RETELL_API_BASE_URL}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${RETELL_API_KEY}`,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(`Retell API ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

async function buildContactUpdatePlan(contact, update) {
  const contactBody = normalizeContactFields({ ...(update.fields || {}), ...(update.status ? { status_name: update.status } : {}) });
  const noteBody = update.note ? {
    note: update.note,
    date_created: Math.floor(Date.now() / 1000),
    record_type_name: "Note",
    primary: { id: contact.jnid }
  } : null;
  return {
    updates: cleanObject({
      contact: Object.keys(contactBody).length ? { endpoint: `/contacts/${contact.jnid}`, body: contactBody } : null,
      note: noteBody ? { endpoint: "/activities", body: noteBody } : null
    })
  };
}

async function executeContactUpdatePlan(plan) {
  const results = {};
  if (plan.updates.contact) {
    results.contact = await jobNimbus(plan.updates.contact.endpoint, { method: "PUT", body: plan.updates.contact.body });
  }
  if (plan.updates.note) {
    results.note = await jobNimbus(plan.updates.note.endpoint, { method: "POST", body: plan.updates.note.body });
  }
  return results;
}

async function readClaimCallLedger() {
  return readSecurityLedger(CLAIM_CALL_STORE_PATH, "Claim call ledger");
}

async function writeClaimCallLedger(rows) {
  await writeSecurityLedger(CLAIM_CALL_STORE_PATH, rows);
}

function previewRetellRequest(request) {
  return {
    ...request,
    retell_llm_dynamic_variables: request.retell_llm_dynamic_variables,
    metadata: request.metadata
  };
}

async function updateContact(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute updates.");
  }
  const query = required(input.query, "query");
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) badRequest("fields object is required");
  const { contact } = await findChanceContact(query, {
    expectedFileId: input.expectedFileId
  });
  const normalizedFields = normalizeContactFields(fields);
  assertCodexOperatorFields(
    normalizedFields,
    CODEX_OPERATOR_CONTACT_FIELDS,
    "contact",
    { allowContactCustomFields: true }
  );
  const before = Object.fromEntries(
    Object.keys(normalizedFields).map((key) => [
      key,
      Object.prototype.hasOwnProperty.call(contact, key) ? contact[key] : null
    ])
  );
  if (
    Object.prototype.hasOwnProperty.call(input, "expectedBeforeFields")
    && !recordMatchesFields(contact, input.expectedBeforeFields || {})
  ) {
    conflictError("One or more JobNimbus fields changed after approval. Nothing was written; prepare and approve a fresh plan.");
  }
  const plan = {
    endpoint: `/contacts/${contact.jnid}`,
    before,
    fields: normalizedFields
  };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  if (recordMatchesFields(contact, normalizedFields)) {
    return {
      mode: "verified_noop",
      verifiedByReadback: true,
      file: compactContact(contact),
      plan
    };
  }
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body: normalizedFields });
  const refreshedContact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`);
  assertOperatorContactScope(refreshedContact);
  if (!recordMatchesFields(refreshedContact, normalizedFields)) {
    conflictError("JobNimbus accepted the update request, but a fresh read did not confirm the requested fields. The bridge will not report this update as complete.");
  }
  const file = compactContact(refreshedContact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "update_contact", result, `Updated approved JobNimbus fields: ${Object.keys(normalizedFields).join(", ")}.`);
  return { mode: "executed", verifiedByReadback: true, file, result, memoryCloseout };
}

async function updateStatus(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute status updates.");
  }
  const query = required(input.query, "query");
  const requestedStatus = required(input.status || input.statusName || input.workflowStatus, "status");
  const { contact, knownStatusNames } = await findChanceContact(query, {
    expectedFileId: input.expectedFileId
  });
  const status = resolveWorkflowStatusName(requestedStatus, knownStatusNames);
  const currentStatus = String(contact.status_name || "").trim();
  const hasExpectedBeforeStatus = Object.prototype.hasOwnProperty.call(input, "expectedBeforeStatus");
  const expectedBeforeStatus = String(input.expectedBeforeStatus ?? "").trim();
  if (hasExpectedBeforeStatus && currentStatus !== expectedBeforeStatus) {
    conflictError(
      `The JobNimbus stage changed after approval. Expected ${expectedBeforeStatus || "(blank)"}; found ${currentStatus || "(blank)"}. Nothing was written.`
    );
  }
  const verifiedTransitionEvidence = input.enforceThresher === true
    ? await verifyThresherTransitionEvidence(contact, input.transitionEvidence)
    : null;
  const thresherTransition = input.enforceThresher === true
      ? validateThresherTransition({
          currentStatus,
          targetStatus: status,
          evidence: verifiedTransitionEvidence,
          fileId: contact.jnid
        })
      : null;
  if (
    input.execute === true
    && input.enforceThresher === true
    && Object.prototype.hasOwnProperty.call(input, "expectedThresherTransition")
    && digest({ version: 1, transition: thresherTransition }) !== digest({
      version: 1,
      transition: input.expectedThresherTransition
    })
  ) {
    conflictError("The provider evidence supporting this Thresher stage move changed after approval. Nothing was written; prepare and approve a fresh plan.");
  }
  const body = { status_name: status };
  const plan = {
    endpoint: `/contacts/${contact.jnid}`,
    before: { status_name: currentStatus || null },
    body,
    requestedStatus,
    resolvedStatus: status,
    ...(thresherTransition ? { thresherTransition } : {})
  };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  if (currentStatus === status) {
    return {
      mode: "verified_noop",
      verifiedByReadback: true,
      file: compactContact(contact),
      plan
    };
  }
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body });
  const refreshedContact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`);
  assertOperatorContactScope(refreshedContact);
  if (!recordMatchesFields(refreshedContact, body)) {
    conflictError("JobNimbus accepted the status update request, but a fresh read did not confirm the requested status. The bridge will not report this update as complete.");
  }
  const file = compactContact(refreshedContact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "update_status", result, `Moved JobNimbus file to ${status}.`);
  return { mode: "executed", verifiedByReadback: true, file, result, memoryCloseout };
}

async function verifyThresherTransitionEvidence(contact, evidence = {}) {
  const references = Array.isArray(evidence?.references) ? evidence.references : [];
  if (!references.length) return { ...evidence, references: [] };
  const file = compactContact(contact);
  let scopedCommunicationFile = null;
  let quoTimeline = null;
  const verified = [];
  for (const reference of references) {
    const source = String(reference?.source || "").trim();
    const id = String(reference?.id || "").trim();
    const gate = String(reference?.gate || "").trim();
    if (!id || !gate) continue;
    let providerRecord;
    if (source === "jobnimbus_activity") {
      providerRecord = await jobNimbus(`/activities/${encodeURIComponent(id)}`);
      if (!referencesContact(providerRecord, contact.jnid)) {
        badRequest("A Thresher JobNimbus activity reference does not belong to this exact file.");
      }
      if (String(providerRecord?.record_type_name || "").trim().toLowerCase() !== "note") {
        badRequest("A Thresher JobNimbus activity reference must be an exact file-related Note; events and appointments cannot prove a completed stage gate.");
      }
      const noteInactive = ["is_active", "isActive", "active"].some((key) => (
        Object.prototype.hasOwnProperty.call(providerRecord, key)
        && providerFlagFalse(providerRecord[key])
      ));
      const noteRemoved = [
        "is_deleted",
        "isDeleted",
        "deleted",
        "is_archived",
        "isArchived",
        "archived"
      ].some((key) => providerFlagTrue(providerRecord[key]));
      if (noteInactive || noteRemoved) {
        badRequest("A deleted, archived, or explicitly inactive JobNimbus Note cannot prove a completed Thresher stage gate.");
      }
    } else if (source === "gmail_message") {
      scopedCommunicationFile ||= await operatorCommunicationFile({ fileQuery: String(file.number) }, "Thresher Gmail evidence");
      providerRecord = compactGmailFullMessage(await gmailApi(
        `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(id)}?format=full`
      ));
      const blockedLabels = new Set(["DRAFT", "TRASH", "SPAM"]);
      if (providerRecord.labelIds.some((label) => blockedLabels.has(String(label || "").toUpperCase()))) {
        badRequest("A Thresher Gmail reference must be an actual sent or inbound message; drafts, trash, and spam cannot prove a completed stage gate.");
      }
      if (!gmailMessageMatchesFile(providerRecord, scopedCommunicationFile)) {
        badRequest("A Thresher Gmail reference is not strongly correlated to this exact file.");
      }
    } else if (source === "quo_message") {
      if (!quoTimeline) {
        await assertUniqueChanceFilePhone(file, "Thresher Quo evidence");
        const history = await readQuoHistoryStrict(quoConfig(), {
          phone: file.phone,
          maxResults: 100,
          maxPages: 10
        });
        if (history?.completeness?.complete !== true) {
          const error = new Error("Quo evidence pagination is incomplete, so the Thresher stage move is blocked.");
          error.statusCode = 503;
          throw error;
        }
        quoTimeline = Array.isArray(history.timeline) ? history.timeline : [];
      }
      providerRecord = quoTimeline.find((item) => (
        String(item.id || "") === id
        && String(item.type || "") === "text"
      ));
      if (!providerRecord) {
        badRequest("A Thresher Quo reference is not present in the complete current history for this exact file.");
      }
      const quoDirection = String(providerRecord.direction || "").trim().toLowerCase();
      const quoStatus = String(providerRecord.status || "").trim().toLowerCase();
      const inboundCompleted = new Set(["incoming", "inbound", "received"]).has(quoDirection)
        && new Set(["received", "delivered"]).has(quoStatus);
      const outboundCompleted = new Set(["outgoing", "outbound", "sent"]).has(quoDirection)
        && new Set(["sent", "delivered", "completed"]).has(quoStatus);
      if (!inboundCompleted && !outboundCompleted) {
        badRequest("A Thresher Quo message must be an inbound/received or outbound sent/delivered communication; queued, failed, canceled, and unknown messages cannot prove a completed stage gate.");
      }
    } else {
      badRequest(`Unsupported Thresher evidence source: ${source || "(blank)"}.`);
    }
    verified.push({
      source,
      id,
      gate,
      fileId: contact.jnid,
      fact: thresherProviderEvidenceFact(source, providerRecord),
      providerDigest: digest({ source, id, providerRecord })
    });
  }
  return { ...evidence, references: verified, gates: undefined };
}

function thresherProviderEvidenceFact(source, record = {}) {
  const candidateValues = source === "gmail_message"
    ? [
        record?.headers?.subject,
        record?.subject,
        record?.snippet,
        record?.plainText,
        record?.headers?.from,
        record?.from,
        record?.headers?.date,
        record?.date
      ]
    : source === "quo_message"
      ? [
          record?.summary,
          record?.text,
          record?.body,
          record?.snippet,
          record?.status,
          record?.direction,
          record?.createdAt,
          record?.date
        ]
      : [
          record?.title,
          record?.subject,
          record?.description,
          record?.note,
          record?.filename,
          record?.name,
          record?.record_type_name,
          record?.date_created,
          record?.date_updated
        ];
  const summary = candidateValues
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "")
    .filter(Boolean)
    .join(" | ")
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
  if (!summary) {
    badRequest(`The ${source} record does not contain enough provider text to support a Thresher gate.`);
  }
  return summary;
}

async function processUpdate(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute bundled JobNimbus updates.");
  }
  const query = required(input.query || input.job || input.client, "query");
  const fields = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? input.fields : {};
  const requestedStatus = String(input.status || input.statusName || input.workflowStatus || "").trim();
  const note = String(input.note || input.internalNote || "").trim();
  if (!Object.keys(fields).length && !requestedStatus && !note) {
    badRequest("At least one of fields, status, or note is required.");
  }
  const { contact, knownStatusNames } = await findChanceContact(query);
  const status = requestedStatus ? resolveWorkflowStatusName(requestedStatus, knownStatusNames) : "";
  const file = compactContact(contact);
  const normalizedInputFields = normalizeContactFields(fields);
  assertCodexOperatorFields(
    normalizedInputFields,
    CODEX_OPERATOR_CONTACT_FIELDS,
    "contact",
    { allowContactCustomFields: true }
  );
  const contactBody = { ...normalizedInputFields, ...(status ? { status_name: status } : {}) };
  assertCodexOperatorFields(
    contactBody,
    CODEX_OPERATOR_CONTACT_FIELDS,
    "contact",
    { allowContactCustomFields: true, allowResolvedStatus: true }
  );
  const noteBody = note ? {
    note,
    date_created: Math.floor(Date.now() / 1000),
    record_type_name: "Note",
    primary: { id: contact.jnid }
  } : null;
  const plan = {
    file,
    requestedStatus,
    resolvedStatus: status,
    updates: cleanObject({
      contact: Object.keys(contactBody).length ? { endpoint: `/contacts/${contact.jnid}`, body: contactBody } : null,
      note: noteBody ? { endpoint: "/activities", body: noteBody } : null
    })
  };
  if (input.execute !== true) return { mode: "dry_run", ...plan };

  const results = {};
  if (Object.keys(contactBody).length) {
    results.contact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body: contactBody });
    const refreshedContact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`);
    assertOperatorContactScope(refreshedContact);
    if (!recordMatchesFields(refreshedContact, contactBody)) {
      conflictError("JobNimbus accepted the bundled update request, but a fresh read did not confirm the requested contact fields. The bridge will not report this update as complete.");
    }
    results.verifiedContact = compactContact(refreshedContact);
  }
  if (noteBody) {
    results.note = await jobNimbus("/activities", { method: "POST", body: noteBody });
  }
  const parts = [];
  if (Object.keys(contactBody).length) parts.push(`fields ${Object.keys(contactBody).join(", ")}`);
  if (noteBody) parts.push("internal note");
  const memoryCloseout = await closeoutJobNimbusAction(results.verifiedContact || file, "process_update", results.note || results.contact, `Applied approved JobNimbus update: ${parts.join(" and ")}.`);
  return { mode: "executed", verifiedByReadback: Boolean(results.verifiedContact), file: results.verifiedContact || file, results, memoryCloseout };
}

async function documentText(input) {
  const query = required(input.query, "query");
  const documentQuery = String(input.documentQuery || input.documentId || "").trim();
  const maxChars = clamp(Number(input.maxChars || 12000), 1000, 50000);
  const maxOcrPages = clamp(Number(input.maxOcrPages || 5), 1, 20);
  const { contact, readScope } = await findDocumentReadContact(query, { documentQuery });
  const documents = await listRelated("/files", contact.jnid, 1000);
  const document = isCodexOperatorRequest()
    ? selectDocumentForChat(documents, documentQuery)
    : selectDocument(documents, documentQuery);
  if (!document) {
    return {
      file: compactContact(contact),
      error: documentQuery ? `No matching document found for: ${documentQuery}` : "No documents found on this file.",
      availableDocuments: documents.map(compactDocument).slice(0, 50)
    };
  }
  const downloaded = await downloadJobNimbusFile(document);
  const extracted = await extractDocumentText(downloaded, document, maxChars, {
    forceOcr: input.forceOcr === true,
    maxOcrPages
  });
  return {
    file: compactContact(contact),
    readScope,
    document: compactDocument(document),
    contentType: downloaded.contentType,
    bytes: downloaded.bytes.length,
    ...extracted
  };
}

async function documentReview(input) {
  const query = required(input.query, "query");
  const documentQuery = String(input.documentQuery || input.documentId || "").trim();
  const documentPurpose = normalizeDocumentPurpose(input.documentPurpose);
  if (!documentQuery && !documentPurpose) {
    badRequest("documentQuery or documentPurpose is required so the bridge never reviews an arbitrary file.");
  }
  const maxChars = clamp(Number(input.maxChars || 20000), 1000, 50000);
  const maxOcrPages = clamp(Number(input.maxOcrPages || 5), 1, 20);
  const { contact, readScope } = await findDocumentReadContact(query, { documentQuery });
  const documents = await listRelated("/files", contact.jnid, 1000);
  const document = documentQuery
    ? isCodexOperatorRequest()
      ? selectDocumentForChat(documents, documentQuery)
      : selectDocument(documents, documentQuery)
    : selectDocumentByPurpose(documents, documentPurpose);
  if (!document) {
    return {
      file: compactContact(contact),
      error: documentQuery
        ? `No matching document found for: ${documentQuery}`
        : `No unique ${documentPurpose} document found on this file.`,
      availableDocuments: documents.map(compactDocument).slice(0, 50)
    };
  }
  const downloaded = await downloadJobNimbusFile(document);
  const extracted = await extractDocumentText(downloaded, document, maxChars, {
    forceOcr: input.forceOcr === true,
    maxOcrPages
  });
  const review = reviewExtractedDocument(extracted.text || "", document, compactContact(contact));
  const nativeReviewRequired = shouldAttachForNativeReview(extracted, review);
  const nativeAttachment = nativeReviewRequired
    ? prepareChatgptDocumentAttachment(downloaded, document)
    : null;
  return {
    file: compactContact(contact),
    readScope,
    document: compactDocument(document),
    contentType: downloaded.contentType,
    bytes: downloaded.bytes.length,
    extraction: extracted.extraction,
    pageCount: extracted.pageCount || null,
    truncated: Boolean(extracted.truncated),
    extractionError: extracted.error || "",
    textPreview: (extracted.text || "").slice(0, clamp(Number(input.previewChars || 4000), 500, 12000)),
    review,
    nativeReviewRequired,
    ...(nativeAttachment ? {
      reviewInstruction: "The exact original JobNimbus document is attached to this response because bridge extraction was incomplete or unreliable. Inspect every relevant page with ChatGPT's native file/PDF analysis before reporting facts. Do not infer contents from the filename.",
      openaiFileResponse: nativeAttachment.openaiFileResponse
    } : {})
  };
}

async function documentFileForChat(input) {
  const query = required(input.query, "query");
  const documentQuery = required(input.documentQuery || input.documentId, "documentQuery");
  const { contact, readScope } = await findDocumentReadContact(query, { documentQuery });
  const documents = await listRelated("/files", contact.jnid, 1000);
  const document = selectDocumentForChat(documents, documentQuery);
  const downloaded = await downloadJobNimbusFile(document);
  const prepared = prepareChatgptDocumentAttachment(downloaded, document);

  return {
    file: compactContact(contact),
    readScope,
    document: compactDocument(document),
    bytes: prepared.bytes,
    contentType: prepared.contentType,
    reviewInstruction: "The original JobNimbus document is now attached to this conversation. Inspect the actual file and every relevant page with ChatGPT's native file/PDF analysis. Do not infer its contents from the filename or from a failed bridge extraction.",
    openaiFileResponse: prepared.openaiFileResponse
  };
}

async function photoReview(input) {
  const query = required(input.query, "query");
  const mode = String(input.mode || "catalog").trim().toLowerCase();
  if (!new Set(["catalog", "attach_batch"]).has(mode)) {
    badRequest("mode must be catalog or attach_batch");
  }

  const { contact, readScope } = await findDocumentReadContact(query);
  const documents = await listRelated("/files", contact.jnid, 1000);
  const catalog = buildPhotoCandidateCatalog(documents, { limit: input.catalogLimit });
  const file = compactContact(contact);
  if (mode === "catalog") {
    return { mode, file, readScope, ...catalog };
  }

  const photos = documents.filter(isPhotoMetadata);
  const requestedIds = Array.isArray(input.photoIds)
    ? [...new Set(input.photoIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  const batchKey = String(input.batchKey || "").trim();
  if (!requestedIds.length && !batchKey) {
    badRequest("attach_batch requires one exact batchKey from catalog mode or one to six exact photoIds");
  }

  let selected = requestedIds.length
    ? requestedIds.map((id) => photos.find((photo) => String(photo.jnid || photo.id || "") === id)).filter(Boolean)
    : photos
      .filter((photo) => String(photo.name || photo.filename || photo.file_name || "") === batchKey)
      .sort((a, b) => String(a.jnid || a.id || "").localeCompare(String(b.jnid || b.id || "")));
  if (requestedIds.length && selected.length !== requestedIds.length) {
    badRequest("One or more requested photoIds do not belong to this exact JobNimbus file.");
  }
  if (!selected.length) badRequest("No JobNimbus photos matched the requested batch or ids.");

  const offset = Math.max(0, Number(input.offset) || 0);
  const limit = clamp(Number(input.limit || 6), 1, 6);
  const page = selected.slice(offset, offset + limit);
  if (!page.length) badRequest(`No photos remain at offset ${offset}. The selected batch contains ${selected.length}.`);

  const downloaded = [];
  const unsupportedPhotoIds = [];
  for (const photo of page) {
    const item = await downloadJobNimbusFile(photo);
    const filename = item.filename || compactDocument(photo).name;
    const contentType = String(item.contentType || "").toLowerCase();
    if (!contentType.includes("jpeg") && !contentType.includes("jpg") && !contentType.includes("png") && !/\.(?:jpe?g|png)$/i.test(filename)) {
      unsupportedPhotoIds.push(String(photo.jnid || photo.id || ""));
      continue;
    }
    downloaded.push({
      bytes: item.bytes,
      label: `${String(photo.jnid || photo.id || "")}: ${filename}`
    });
  }

  const rendered = await createPhotoReviewPdf(downloaded, {
    title: `${file.number || file.name} JobNimbus photo review`
  });
  if (rendered.bytes.length > MAX_CHATGPT_FILE_BYTES) {
    badRequest(
      `The selected photo PDF is ${rendered.bytes.length} bytes, above the ${MAX_CHATGPT_FILE_BYTES}-byte ChatGPT limit. Retry with fewer exact photoIds or a smaller limit.`
    );
  }

  const safeNumber = String(file.number || file.id || "file").replace(/[^a-z0-9_-]+/gi, "-");
  const filename = `jobnimbus-${safeNumber}-photos-${offset + 1}-${offset + page.length}.pdf`;
  return {
    mode,
    file,
    readScope,
    selection: {
      batchKey: batchKey || "",
      requestedPhotoIds: requestedIds,
      offset,
      returnedCount: rendered.rendered,
      totalSelectedCount: selected.length,
      hasMore: offset + page.length < selected.length,
      nextOffset: offset + page.length < selected.length ? offset + page.length : null,
      unsupportedPhotoIds
    },
    reviewInstruction: "The selected JobNimbus photos are attached as one image per PDF page. Inspect the actual pages visually. Treat visible measurement overlays as verified only when every digit and unit is legible; never infer an unreadable dimension. Do not treat ordinary inspection photos as measurement evidence.",
    openaiFileResponse: [{
      name: filename,
      mime_type: "application/pdf",
      content: rendered.bytes.toString("base64")
    }]
  };
}

async function dateOfLossResearch(input) {
  const query = required(input.query, "query");
  const { contact, readScope } = await findDocumentReadContact(query);
  const file = compactContact(contact);
  const address = [contact.address_line1, contact.city, contact.state_text, contact.zip]
    .filter(Boolean)
    .join(", ");
  if (!contact.address_line1 || !contact.city || !contact.state_text) {
    badRequest(`A complete JobNimbus property address is required for DOL research. Current address: ${address || "missing"}`);
  }

  const endDate = String(input.endDate || centralIsoDate()).trim();
  const startDate = String(input.startDate || shiftIsoDate(endDate, -730)).trim();
  let research;
  try {
    research = await researchPropertyHailDates({
      address,
      state: contact.state_text,
      startDate,
      endDate,
      radiusMiles: input.radiusMiles,
      minimumHailInches: input.minimumHailInches,
      limit: input.limit
    }, {
      geocoderUrl: CENSUS_GEOCODER_URL,
      reportsUrl: HAIL_REPORTS_URL
    });
  } catch (error) {
    if (/required|YYYY-MM-DD|800-day|on or before|geocoded/i.test(error.message || "")) {
      error.statusCode = 400;
    } else {
      error.statusCode = 502;
    }
    throw error;
  }

  return {
    file,
    readScope,
    currentJobNimbusDateOfLoss: file.dateOfLoss || null,
    ...research,
    instruction: "These dates are research candidates only. Compare them with the policy/dec coverage period, current JobNimbus documents, prior claim history, and carrier evidence. Never file a claim or update JobNimbus from weather research alone; show Chance the evidence and obtain approval first."
  };
}

async function createNote(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute notes.");
  }
  const query = required(input.query, "query");
  const note = required(input.note, "note");
  const { contact } = await findChanceContact(query);
  const body = {
    note,
    date_created: Math.floor(Date.now() / 1000),
    record_type_name: "Note",
    primary: { id: contact.jnid }
  };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan: { endpoint: "/activities", body } };
  const result = await jobNimbus("/activities", { method: "POST", body });
  const file = compactContact(contact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "create_note", result, "Created approved JobNimbus internal note.");
  return { mode: "executed", file, result, memoryCloseout };
}

async function createTask(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute tasks.");
  }
  const query = required(input.query, "query");
  const title = required(input.title || input.subject, "title");
  const { contact } = await findChanceContact(query);
  if (
    isRestrictedEffectRequest()
    && input.recordTypeName !== undefined
    && String(input.recordTypeName).trim().toLowerCase() !== "task"
  ) {
    badRequest("The Codex operator can create only JobNimbus Task records through this action.");
  }
  const ownerId = operatorActionOwnerId(contact);
  const body = cleanObject({
    title,
    subject: title,
    description: input.description || input.note || "",
    note: input.note || input.description || "",
    date_start: toUnixSeconds(input.dateStart || input.dueDate),
    date_end: toUnixSeconds(input.dateEnd || input.dueDate),
    is_completed: Boolean(input.completed || false),
    record_type_name: isRestrictedEffectRequest()
      ? "Task"
      : input.recordTypeName || "Task",
    owners: [{ id: ownerId }],
    primary: { id: contact.jnid },
    related: [{ id: contact.jnid }]
  });
  validateDateRange(body.date_start, body.date_end);
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      file: compactContact(contact),
      plan: { endpoint: "/tasks", body, schedule: centralSchedulePreview(body.date_start, body.date_end) }
    };
  }
  const result = await jobNimbus("/tasks", { method: "POST", body });
  const file = compactContact(contact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "create_task", result, `Created approved JobNimbus task: ${title}.`);
  return { mode: "executed", file, result, memoryCloseout };
}

async function listCompleteRelatedTasks(contactId) {
  const pageSize = 500;
  const maxTasksPerRelation = 5_000;
  const byId = new Map();
  for (const field of ["related.id", "primary.id"]) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ term: { [field]: contactId } }] }));
    let from = 0;
    while (from < maxTasksPerRelation) {
      const payload = await jobNimbus(`/tasks?size=${pageSize}&from=${from}&filter=${filter}`);
      const page = unwrapList(payload, "tasks");
      for (const task of page) {
        if (!referencesContact(task, contactId)) continue;
        const id = taskRecordId(task);
        if (!id) {
          const error = new Error("JobNimbus returned a related task without an exact task ID. Nothing was changed.");
          error.statusCode = 503;
          throw error;
        }
        byId.set(id, task);
      }
      const declaredTotalRaw = payload?.total ?? payload?.count ?? payload?.meta?.total;
      const hasDeclaredTotal = declaredTotalRaw !== undefined && declaredTotalRaw !== null && declaredTotalRaw !== "";
      const declaredTotal = hasDeclaredTotal ? Number(declaredTotalRaw) : NaN;
      if (hasDeclaredTotal) {
        if (
          !Number.isSafeInteger(declaredTotal)
          || declaredTotal < 0
          || declaredTotal > maxTasksPerRelation
          || from + page.length > declaredTotal
        ) {
          const error = new Error("JobNimbus returned an invalid task total, so the current-control task inventory may be incomplete. Nothing was changed.");
          error.statusCode = 503;
          throw error;
        }
        if (from + page.length >= declaredTotal) break;
        if (!page.length) {
          const error = new Error("JobNimbus task pagination stopped before its declared total, so the current-control task inventory may be incomplete. Nothing was changed.");
          error.statusCode = 503;
          throw error;
        }
        from += page.length;
        continue;
      }
      if (!page.length) break;
      from += page.length;
    }
    if (from >= maxTasksPerRelation) {
      const probe = unwrapList(
        await jobNimbus(`/tasks?size=1&from=${from}&filter=${filter}`),
        "tasks"
      );
      if (probe.length) {
        const error = new Error("JobNimbus task pagination reached the 5,000-record safety ceiling, so the current-control task inventory may be incomplete. Nothing was changed.");
        error.statusCode = 503;
        throw error;
      }
    }
  }
  return [...byId.values()];
}

function taskRecordId(task) {
  return String(task?.jnid || task?.id || "").trim();
}

function taskContainsCurrentControlMarker(task) {
  return [task?.description, task?.note, task?.title, task?.subject]
    .some((value) => String(value || "").includes(CURRENT_CONTROL_TASK_MARKER));
}

function taskIsOpenActive(task) {
  return !providerFlagTrue(task?.is_completed)
    && !providerFlagTrue(task?.is_archived)
    && !providerFlagTrue(task?.is_deleted)
    && !providerFlagFalse(task?.is_active);
}

function providerFlagTrue(value) {
  return value === true || value === 1 || ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function providerFlagFalse(value) {
  return value === false || value === 0 || ["false", "0", "no"].includes(String(value ?? "").trim().toLowerCase());
}

function taskOwnedByChance(task) {
  return assignedTo(task, CHANCE_OWNER_ID);
}

function currentControlTaskSnapshot(task) {
  if (!task) return null;
  return {
    id: taskRecordId(task),
    title: String(task.title || task.subject || ""),
    subject: String(task.subject || task.title || ""),
    description: String(task.description || task.note || ""),
    note: String(task.note || task.description || ""),
    date_start: Number(task.date_start || 0),
    date_end: Number(task.date_end || 0),
    is_completed: providerFlagTrue(task.is_completed),
    is_active: !providerFlagFalse(task.is_active),
    is_archived: providerFlagTrue(task.is_archived),
    owners: (Array.isArray(task.owners) ? task.owners : [])
      .map((owner) => String(owner?.id || owner?.jnid || owner || ""))
      .filter(Boolean)
      .sort()
  };
}

function currentControlTaskInventory(tasks, selectedTask = null) {
  const markerTasks = tasks.filter(taskContainsCurrentControlMarker);
  const state = {
    markers: markerTasks.map(currentControlTaskSnapshot).sort((left, right) => left.id.localeCompare(right.id)),
    selected: currentControlTaskSnapshot(selectedTask)
  };
  return {
    markerTasks,
    digest: digest({ version: 1, state })
  };
}

function requireCurrentControlTaskText(input) {
  const title = required(input.title || input.subject, "title");
  const description = required(input.description || input.note, "description");
  if (!/(?:^|\n)Do:\s*\S/i.test(description) || !/(?:^|\n)Waiting on:\s*\S/i.test(description)) {
    badRequest("A current-control task description must include separate 'Do:' and 'Waiting on:' lines.");
  }
  const dueDate = required(input.dueDate || input.dateStart, "dueDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    badRequest("dueDate must use YYYY-MM-DD for a current-control task.");
  }
  return { title, description, dueDate };
}

function assertUsableCurrentControlTask(task, contact) {
  assertOperatorRelatedRecord(task, contact, "current-control task", ["task"]);
  if (!taskIsOpenActive(task)) {
    conflictError("The selected current-control task is completed, archived, deleted, or inactive. Nothing was changed.");
  }
  if (!taskOwnedByChance(task)) {
    conflictError("The selected current-control task is not assigned to Chance. Nothing was changed.");
  }
}

async function ensureCurrentTask(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to create or update current-control tasks.");
  }
  if (taskCompletionRequested(input)) {
    badRequest("Current-control task actions cannot contain any completion-state field.");
  }
  const query = required(input.query, "query");
  const desired = requireCurrentControlTaskText(input);
  const { contact } = await findChanceContact(query, { expectedFileId: input.expectedFileId });
  const tasks = await listCompleteRelatedTasks(contact.jnid);
  const requestedTaskId = String(input.taskId || "").trim();
  const markerTasks = tasks.filter(taskContainsCurrentControlMarker);
  if (markerTasks.length > 1) {
    conflictError("More than one HCN current-control task marker exists on this file. Reconcile them manually before any task write.");
  }

  let selectedTask = null;
  if (requestedTaskId) {
    selectedTask = tasks.find((task) => taskRecordId(task) === requestedTaskId) || null;
    if (!selectedTask) conflictError("The selected task is not related to this exact JobNimbus file.");
    assertUsableCurrentControlTask(selectedTask, contact);
    if (markerTasks.length === 1 && taskRecordId(markerTasks[0]) !== requestedTaskId) {
      conflictError("A different HCN current-control task already exists on this file. Nothing was changed.");
    }
  } else if (markerTasks.length === 1) {
    selectedTask = markerTasks[0];
    assertUsableCurrentControlTask(selectedTask, contact);
  }

  const dateStart = toUnixSeconds(desired.dueDate);
  const dateEnd = toUnixSeconds(desired.dueDate);
  const note = `${CURRENT_CONTROL_TASK_MARKER}\n${desired.description}`;
  const updateBody = {
    title: desired.title,
    subject: desired.title,
    description: desired.description,
    note,
    date_start: dateStart,
    date_end: dateEnd
  };
  const createBody = {
    ...updateBody,
    is_completed: false,
    record_type_name: "Task",
    owners: [{ id: CHANCE_OWNER_ID }],
    primary: { id: contact.jnid },
    related: [{ id: contact.jnid }]
  };
  validateDateRange(dateStart, dateEnd);
  const inventory = currentControlTaskInventory(tasks, selectedTask);
  const decision = selectedTask
    ? recordMatchesFields(selectedTask, updateBody) ? "noop" : "update"
    : "create";
  const plan = {
    decision,
    selectedTaskId: selectedTask ? taskRecordId(selectedTask) : null,
    before: currentControlTaskSnapshot(selectedTask),
    after: selectedTask ? updateBody : createBody,
    markerTaskIds: markerTasks.map(taskRecordId),
    otherOpenTaskCount: tasks.filter((task) => taskIsOpenActive(task) && task !== selectedTask).length,
    controlInventoryDigest: inventory.digest,
    schedule: centralSchedulePreview(dateStart, dateEnd)
  };
  if (input.execute !== true) {
    return { mode: "dry_run", file: compactContact(contact), plan };
  }
  if (!input.expectedPlan || digest(input.expectedPlan) !== digest(plan)) {
    conflictError("The current-control task inventory or desired task changed after approval. Nothing was written; prepare a fresh plan.");
  }
  if (decision === "noop") {
    return {
      mode: "verified_noop",
      verifiedByReadback: true,
      changed: false,
      decision,
      taskId: taskRecordId(selectedTask),
      file: compactContact(contact),
      result: selectedTask,
      plan
    };
  }

  let providerResult;
  if (decision === "create") {
    providerResult = await jobNimbus("/tasks", { method: "POST", body: createBody });
  } else {
    try {
      providerResult = await jobNimbus(`/tasks/${encodeURIComponent(taskRecordId(selectedTask))}`, {
        method: "PUT",
        body: updateBody
      });
    } catch (error) {
      if (!isAmbiguousTaskUpdateError(error)) throw error;
      const task = await jobNimbus(`/tasks/${encodeURIComponent(taskRecordId(selectedTask))}`);
      if (!recordMatchesFields(task, updateBody)) throw error;
      providerResult = task;
    }
  }

  const refreshedTasks = await listCompleteRelatedTasks(contact.jnid);
  const refreshedMarkers = refreshedTasks.filter(taskContainsCurrentControlMarker);
  if (refreshedMarkers.length !== 1) {
    conflictError("JobNimbus did not read back exactly one open HCN current-control task. Reconciliation is required before any retry.");
  }
  const refreshedTask = refreshedMarkers[0];
  assertUsableCurrentControlTask(refreshedTask, contact);
  if (!recordMatchesFields(refreshedTask, updateBody) || providerFlagTrue(refreshedTask.is_completed)) {
    conflictError("JobNimbus accepted the task request, but a fresh read did not confirm the exact open current-control task state.");
  }
  const taskId = taskRecordId(refreshedTask);
  const memoryCloseout = await closeoutJobNimbusAction(
    compactContact(contact),
    "ensure_current_task",
    providerResult,
    `${decision === "create" ? "Created" : "Updated"} the approved current-control task ${taskId}.`
  );
  return {
    mode: "executed",
    verifiedByReadback: true,
    changed: true,
    decision,
    taskId,
    file: compactContact(contact),
    result: refreshedTask,
    memoryCloseout
  };
}

async function uploadJobNimbusFile(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute file uploads.");
  }
  const query = required(input.query, "query");
  const filename = path.basename(required(input.filename, "filename"));
  const description = String(input.description || "").trim().slice(0, 1000);
  const contentBase64 = required(input.contentBase64, "contentBase64").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) badRequest("contentBase64 must be valid base64.");
  const content = Buffer.from(contentBase64, "base64");
  if (!content.length) badRequest("Uploaded file is empty.");
  if (content.length > 8 * 1024 * 1024) badRequest("Uploaded file exceeds the bridge's 8 MB single-file limit.");

  const { contact } = await findChanceContact(query);
  const plan = jobNimbusUploadPlan(contact, {
    filename,
    description,
    bytes: content,
    isPrivate: Boolean(input.isPrivate || false)
  });
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  const result = await uploadBytesToJobNimbus(plan, content);
  const memoryCloseout = await closeoutJobNimbusAction(compactContact(contact), "upload_file", result, `Uploaded verified JobNimbus document ${filename} (${content.length} bytes).`);
  return {
    mode: "executed",
    file: compactContact(contact),
    result,
    memoryCloseout
  };
}

function jobNimbusUploadPlan(contact, input) {
  return {
    filename: safeMimeFilename(input.filename),
    description: String(input.description || "").trim().slice(0, 1000),
    sizeBytes: input.bytes.length,
    type: 1,
    related: [contact.jnid],
    isPrivate: Boolean(input.isPrivate)
  };
}

function assertOperatorRelatedRecord(record, contact, resource, allowedRecordTypes) {
  if (!referencesContact(record, String(contact.jnid || contact.id || ""))) {
    badRequest(`The requested ${resource} does not belong to the resolved ${operatorFileDescription()}.`);
  }
  const recordType = String(record.record_type_name || record.type_name || record.type || "").trim().toLowerCase();
  if (!allowedRecordTypes.includes(recordType)) {
    badRequest(`The requested JobNimbus record is not an allowed ${resource}.`);
  }
}

async function requireOperatorRelatedRecord({ query, resource, endpoint, recordId, allowedRecordTypes }) {
  const { contact } = await findChanceContact(required(query, "query"));
  const record = await jobNimbus(`${endpoint}/${encodeURIComponent(recordId)}`);
  assertOperatorRelatedRecord(record, contact, resource, allowedRecordTypes);
  return { contact, record };
}

async function uploadBytesToJobNimbus(plan, bytes) {
  const reservation = await jobNimbusFileApi("/files/v1/uploads/url", { method: "POST", body: plan });
  const uploadUrl = reservation?.data?.url;
  const fileId = reservation?.data?.jnid;
  if (!uploadUrl || !fileId) badRequest("JobNimbus did not return a presigned upload URL and file id.");
  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes
  });
  if (!upload.ok) {
    const text = await upload.text().catch(() => "");
    const error = new Error(`JobNimbus file storage upload ${upload.status}: ${text.slice(0, 500)}`);
    error.statusCode = upload.status;
    throw error;
  }
  const completion = await jobNimbusFileApi(`/files/v1/uploads/${encodeURIComponent(fileId)}/complete?generateThumbnail=true`, { method: "POST" });
  return {
    id: fileId,
    filename: plan.filename,
    sizeBytes: bytes.length,
    thumbnailUrl: completion?.data?.thumbnailUrl || ""
  };
}

async function updateTask(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute task updates.");
  }
  const taskId = String(input.taskId || input.id || "").trim();
  if (!taskId) badRequest("taskId is required");
  const fields = normalizeTaskUpdateFields(input);
  if (!Object.keys(fields).length) {
    badRequest("Task changes are required. To complete a task, use completed:true or fields:{is_completed:true}.");
  }
  const body = normalizeDateFields(fields);
  assertCodexOperatorFields(body, CODEX_OPERATOR_TASK_FIELDS, "task");
  validateDateRange(body.date_start, body.date_end);
  const scopedRecord = isRestrictedEffectRequest()
    ? await requireOperatorRelatedRecord({
        query: input.query,
        resource: "task",
        endpoint: "/tasks",
        recordId: taskId,
        allowedRecordTypes: ["task"]
      })
    : null;
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      ...(scopedRecord ? { file: compactContact(scopedRecord.contact) } : {}),
      plan: { endpoint: `/tasks/${taskId}`, body, schedule: centralSchedulePreview(body.date_start, body.date_end) }
    };
  }
  let result;
  let reconciledAfterApiError = false;
  try {
    result = await jobNimbus(`/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body });
  } catch (error) {
    if (!isAmbiguousTaskUpdateError(error)) throw error;
    const task = await jobNimbus(`/tasks/${encodeURIComponent(taskId)}`);
    if (!recordMatchesFields(task, body)) throw error;
    result = task;
    reconciledAfterApiError = true;
  }
  if (scopedRecord) {
    const refreshedTask = await jobNimbus(`/tasks/${encodeURIComponent(taskId)}`);
    assertOperatorRelatedRecord(refreshedTask, scopedRecord.contact, "task", ["task"]);
    if (!recordMatchesFields(refreshedTask, body)) {
      conflictError("JobNimbus accepted the task update request, but a fresh read did not confirm the requested fields.");
    }
    result = refreshedTask;
  }
  const taskSubjectKey = String(scopedRecord?.contact?.jnid || input.subjectKey || result?.primary?.id || result?.related?.[0]?.id || "").trim();
  const taskFile = scopedRecord
    ? compactContact(scopedRecord.contact)
    : input.query
      ? compactContact((await findChanceContact(input.query)).contact)
    : taskSubjectKey ? { id: taskSubjectKey, name: String(input.fileLabel || "") } : null;
  const memoryCloseout = taskFile
    ? await closeoutJobNimbusAction(taskFile, "update_task", result, `Updated approved JobNimbus task ${taskId}.`)
    : safeCloseoutAction(MEMORY_CONFIG, {
      channel: "jobnimbus",
      action: "update_task",
      subjectKey: taskSubjectKey,
      fileLabel: String(input.fileLabel || input.query || ""),
      summary: `Updated approved JobNimbus task ${taskId}.`,
      externalId: resultId(result) || taskId,
      evidence: [`jobnimbus:task:${taskId}`]
    });
  return {
    mode: "executed",
    ...(taskFile ? { file: taskFile } : {}),
    taskId,
    result,
    verifiedByReadback: Boolean(scopedRecord),
    reconciledAfterApiError,
    memoryCloseout
  };
}

async function createCalendarEvent(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute calendar events.");
  }
  const query = required(input.query, "query");
  const title = required(input.title || input.subject, "title");
  const dateStart = toUnixSeconds(required(input.dateStart || input.start, "dateStart"));
  const dateEnd = toUnixSeconds(input.dateEnd || input.end) || dateStart;
  validateDateRange(dateStart, dateEnd);
  const { contact } = await findChanceContact(query);
  if (
    currentRequestIdentity()?.type === "codex_operator_token"
    && input.recordTypeName !== undefined
    && String(input.recordTypeName).trim().toLowerCase() !== "event"
  ) {
    badRequest("The Codex operator can create only JobNimbus Event records through this action.");
  }
  const ownerId = operatorActionOwnerId(contact);
  const body = cleanObject({
    title,
    subject: title,
    note: input.note || input.description || "",
    description: input.description || input.note || "",
    date_start: dateStart,
    date_end: dateEnd,
    record_type_name: currentRequestIdentity()?.type === "codex_operator_token"
      ? "Event"
      : input.recordTypeName || "Event",
    owners: [{ id: ownerId }],
    primary: { id: contact.jnid },
    related: [{ id: contact.jnid }]
  });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      file: compactContact(contact),
      plan: { endpoint: "/activities", body, schedule: centralSchedulePreview(dateStart, dateEnd) }
    };
  }
  const result = await jobNimbus("/activities", { method: "POST", body });
  const file = compactContact(contact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "create_calendar_event", result, `Created approved JobNimbus calendar event: ${title}.`);
  return { mode: "executed", file, result, memoryCloseout };
}

async function updateCalendarEvent(input) {
  if (input.execute === true && !ALLOW_WRITES) {
    badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to execute calendar event updates.");
  }
  const eventId = String(input.eventId || input.activityId || input.id || "").trim();
  if (!eventId) badRequest("eventId is required");
  const fields = input.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) badRequest("fields object is required");
  const scopedRecord = currentRequestIdentity()?.type === "codex_operator_token"
    ? await requireOperatorRelatedRecord({
        query: input.query,
        resource: "calendar event",
        endpoint: "/activities",
        recordId: eventId,
        allowedRecordTypes: ["event", "appointment"]
      })
    : null;
  const file = scopedRecord
    ? compactContact(scopedRecord.contact)
    : input.query ? compactContact((await findChanceContact(input.query)).contact) : null;
  const body = normalizeDateFields(fields);
  assertCodexOperatorFields(body, CODEX_OPERATOR_EVENT_FIELDS, "calendar event");
  validateDateRange(body.date_start, body.date_end);
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      ...(file ? { file } : {}),
      plan: { endpoint: `/activities/${eventId}`, body, schedule: centralSchedulePreview(body.date_start, body.date_end) }
    };
  }
  let result = await jobNimbus(`/activities/${encodeURIComponent(eventId)}`, { method: "PUT", body });
  if (scopedRecord) {
    const refreshedEvent = await jobNimbus(`/activities/${encodeURIComponent(eventId)}`);
    assertOperatorRelatedRecord(refreshedEvent, scopedRecord.contact, "calendar event", ["event", "appointment"]);
    if (!recordMatchesFields(refreshedEvent, body)) {
      conflictError("JobNimbus accepted the calendar-event update request, but a fresh read did not confirm the requested fields.");
    }
    result = refreshedEvent;
  }
  const memoryCloseout = file
    ? await closeoutJobNimbusAction(file, "update_calendar_event", result, `Updated approved JobNimbus calendar event ${eventId}.`)
    : safeCloseoutAction(MEMORY_CONFIG, {
      channel: "jobnimbus",
      action: "update_calendar_event",
      summary: `Updated approved JobNimbus calendar event ${eventId}.`,
      externalId: resultId(result) || eventId,
      evidence: [`jobnimbus:activity:${eventId}`]
    });
  return { mode: "executed", ...(file ? { file } : {}), eventId, result, memoryCloseout };
}

async function gmailSearch(input) {
  const operatorFile = await operatorCommunicationFile(input, "Gmail search");
  const query = operatorFile
    ? buildFileGmailQuery(operatorFile, input.communicationDays)
    : required(input.query, "query");
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const messages = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
  const rows = Array.isArray(messages.messages) ? messages.messages : [];
  const hydrated = [];
  for (const row of rows) {
    const message = await gmailApi(
      operatorFile
        ? `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}?format=full`
        : `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`
    );
    if (operatorFile && !gmailMessageMatchesFile(compactGmailFullMessage(message), operatorFile)) continue;
    hydrated.push(compactGmailMessage(message));
  }
  return {
    query,
    ...(operatorFile ? { file: operatorFile, scope: operatorFileScopeLabel() } : {}),
    count: hydrated.length,
    messages: hydrated,
    threads: groupGmailMessagesByThread(hydrated)
  };
}

async function gmailThread(input) {
  const operatorFile = await operatorCommunicationFile(input, "Gmail thread");
  const threadId = required(input.threadId, "threadId");
  const thread = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/threads/${encodeURIComponent(threadId)}?format=full`);
  const messages = Array.isArray(thread.messages) ? thread.messages.map(compactGmailFullMessage) : [];
  if (operatorFile) {
    const correlations = messages.map((message) => gmailMessageFileCorrelation(message, operatorFile));
    if (
      !correlations.length
      || correlations.some((item) => !item.complete || item.conflictingFileIds.length > 0)
      || !correlations.some((item) => item.targetMatch)
    ) {
      operatorScopeError(`That Gmail thread is not exclusively correlated to the resolved ${operatorFileDescription()}.`);
    }
  }
  return {
    id: thread.id || threadId,
    ...(operatorFile ? { file: operatorFile, scope: operatorFileScopeLabel() } : {}),
    historyId: thread.historyId || "",
    messageCount: messages.length,
    messages,
    assistantRead: buildGmailAssistantRead(messages)
  };
}

async function gmailAttachmentReview(input) {
  const operatorFile = await operatorCommunicationFile(input, "Gmail attachment review");
  const messageId = required(input.messageId, "messageId");
  const attachmentId = required(input.attachmentId, "attachmentId");
  let filename = safeMimeFilename(required(input.filename, "filename"));
  let contentType = String(input.contentType || "application/octet-stream").trim();
  if (operatorFile) {
    const message = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(messageId)}?format=full`);
    const compact = compactGmailFullMessage(message);
    if (!gmailMessageMatchesFile(compact, operatorFile)) {
      operatorScopeError(`That Gmail message is not strongly correlated to the resolved ${operatorFileDescription()}.`);
    }
    const verifiedAttachment = compact.attachments.find((row) => String(row.attachmentId || "") === attachmentId);
    if (!verifiedAttachment) {
      operatorScopeError("That attachment id is not present on the verified client-scoped Gmail message.");
    }
    if (normalizeCompare(verifiedAttachment.filename) !== normalizeCompare(filename)) {
      badRequest("The requested filename does not match the verified Gmail attachment metadata.");
    }
    if (input.contentType && String(verifiedAttachment.mimeType || "").trim().toLowerCase() !== contentType.toLowerCase()) {
      badRequest("The requested content type does not match the verified Gmail attachment metadata.");
    }
    filename = safeMimeFilename(verifiedAttachment.filename);
    contentType = String(verifiedAttachment.mimeType || contentType || "application/octet-stream").trim();
  }
  const payload = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  const bytes = base64UrlToBuffer(payload?.data || "");
  const attachment = validateEmailAttachment({ filename, contentType, bytes });
  const document = { filename: attachment.filename, content_type: attachment.contentType };
  const extracted = await extractDocumentText(
    { bytes: attachment.bytes, contentType: attachment.contentType },
    document,
    clamp(Number(input.maxChars || 20000), 1000, 50000),
    { forceOcr: input.forceOcr === true, maxOcrPages: clamp(Number(input.maxOcrPages || 5), 1, 20) }
  );

  let upload = null;
  if (input.uploadToJobNimbus === true) {
    const query = required(input.query, "query");
    const { contact } = await findChanceContact(query);
    const file = compactContact(contact);
    const plan = jobNimbusUploadPlan(contact, {
      filename: attachment.filename,
      description: String(input.description || "Received by email and verified before upload.").trim().slice(0, 1000),
      bytes: attachment.bytes,
      isPrivate: Boolean(input.isPrivate)
    });
    if (input.execute === true) {
      if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true to upload Gmail attachments.");
      const result = await uploadBytesToJobNimbus(plan, attachment.bytes);
      const memoryCloseout = await closeoutJobNimbusAction(file, "upload_gmail_attachment", result, `Uploaded verified Gmail attachment ${attachment.filename} to JobNimbus.`);
      upload = {
        mode: "executed",
        file,
        result,
        memoryCloseout
      };
    } else {
      upload = { mode: "dry_run", file, plan };
    }
  }

  return {
    messageId,
    attachmentId,
    attachment: emailAttachmentDescriptor(attachment, "gmail"),
    extraction: extracted.extraction,
    pageCount: extracted.pageCount || null,
    truncated: Boolean(extracted.truncated),
    extractionError: extracted.error || "",
    textPreview: String(extracted.text || "").slice(0, clamp(Number(input.previewChars || 8000), 500, 12000)),
    upload
  };
}

async function operatorCommunicationFile(input, label) {
  if (currentRequestIdentity()?.type !== "codex_operator_token") return null;
  const internalFile = input?.[INTERNAL_COMMUNICATION_SCOPE]?.file;
  const file = internalFile?.id
    ? internalFile
    : compactContact((await findChanceContact(required(input?.fileQuery, `${label} fileQuery`))).contact);
  let companyIndex = null;
  if (
    file[GMAIL_FILE_EMAIL_UNIQUE] === undefined
    || file[GMAIL_FILE_CLAIM_UNIQUE] === undefined
    || file[GMAIL_FILE_COMPANY_CONTACTS] === undefined
  ) {
    companyIndex = await hcnCachedContactIndex({ maxRecords: 5000 });
    if (!companyIndex.complete) {
      const error = new Error("The complete company communication index is unavailable.");
      error.statusCode = 503;
      throw error;
    }
    if (file[GMAIL_FILE_COMPANY_CONTACTS] === undefined) {
      Object.defineProperty(file, GMAIL_FILE_COMPANY_CONTACTS, {
        value: companyIndex.rows,
        enumerable: false
      });
    }
  }
  if (
    file[GMAIL_FILE_EMAIL_UNIQUE] === undefined
    || file[GMAIL_FILE_CLAIM_UNIQUE] === undefined
  ) {
    const email = hcnNormalizeCorrelationEmail(file.email);
    const claimNumber = hcnNormalizeCorrelationClaim(file.claimNumber);
    const emailCorrelation = hcnGlobalScalarCorrelation(
      companyIndex.rows,
      email,
      HCN_CONTACT_EMAIL_KEYS,
      hcnNormalizeCorrelationEmail
    );
    const claimCorrelation = hcnGlobalScalarCorrelation(
      companyIndex.rows,
      claimNumber,
      HCN_CONTACT_CLAIM_KEYS,
      hcnNormalizeCorrelationClaim
    );
    Object.defineProperty(file, GMAIL_FILE_EMAIL_UNIQUE, {
      value:
        Boolean(email)
        && emailCorrelation.complete
        && emailCorrelation.matches.length === 1
        && String(emailCorrelation.matches[0]?.jnid || emailCorrelation.matches[0]?.id || "") === String(file.id || ""),
      enumerable: false
    });
    Object.defineProperty(file, GMAIL_FILE_CLAIM_UNIQUE, {
      value:
        claimNumber.length >= 6
        && claimCorrelation.complete
        && claimCorrelation.matches.length === 1
        && String(claimCorrelation.matches[0]?.jnid || claimCorrelation.matches[0]?.id || "") === String(file.id || ""),
      enumerable: false
    });
  }
  if (
    file[GMAIL_FILE_EMAIL_UNIQUE] !== true
    && file[GMAIL_FILE_CLAIM_UNIQUE] !== true
  ) {
    badRequest(`The resolved ${operatorFileDescription()} has neither a company-unique client email nor a company-unique claim number, so ${label} is ambiguous and blocked.`);
  }
  return file;
}

async function operatorGmailActionFile(input, label) {
  if (currentRequestIdentity()?.type !== "codex_operator_token") return null;
  const fileQuery = required(input?.query || input?.fileQuery, `${label} query`);
  return compactContact((await findChanceContact(fileQuery)).contact);
}

function operatorScopeError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  throw error;
}

function gmailMessageFileCorrelation(message, file) {
  const headerText = [
    message.from,
    message.to,
    message.cc,
    message.bcc,
    message.subject
  ].map((value) => String(value || "")).join("\n").toLowerCase();
  const clientEmail = String(file.email || "").trim().toLowerCase();
  const headerAddresses = new Set(
    [...headerText.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
      .map((match) => String(match[0] || "").toLowerCase())
  );
  const content = [
    headerText,
    message.plainText,
    message.htmlText,
    message.snippet,
    ...(Array.isArray(message.attachments) ? message.attachments.map((row) => row.filename) : [])
  ].map((value) => String(value || "")).join("\n");
  const claimNumber = String(file.claimNumber || "").trim();
  const targetMatch = Boolean(
    (
      file[GMAIL_FILE_EMAIL_UNIQUE] === true
      && clientEmail
      && headerAddresses.has(clientEmail)
    )
    || (
      file[GMAIL_FILE_CLAIM_UNIQUE] === true
      && normalizeCompare(claimNumber).length >= 6
      && contentContainsExactIdentifier(content, claimNumber)
    )
  );
  const companyContacts = file[GMAIL_FILE_COMPANY_CONTACTS];
  if (!Array.isArray(companyContacts)) {
    return { complete: false, targetMatch: false, conflictingFileIds: [] };
  }
  const conflictingFileIds = [];
  for (const contact of companyContacts) {
    const contactId = String(contact?.jnid || contact?.id || "");
    if (!contactId) return { complete: false, targetMatch: false, conflictingFileIds: [] };
    const emailInventory = hcnContactScalarInventory(
      contact,
      HCN_CONTACT_EMAIL_KEYS,
      hcnNormalizeCorrelationEmail
    );
    const claimInventory = hcnContactScalarInventory(
      contact,
      HCN_CONTACT_CLAIM_KEYS,
      hcnNormalizeCorrelationClaim
    );
    if (!emailInventory.complete || !claimInventory.complete) {
      return { complete: false, targetMatch: false, conflictingFileIds: [] };
    }
    const emailMatch = [...emailInventory.values]
      .some((email) => headerAddresses.has(email));
    const claimMatch = [...claimInventory.values]
      .some((claim) => claim.length >= 6 && contentContainsExactIdentifier(content, claim));
    if ((emailMatch || claimMatch) && contactId !== String(file.id || "")) {
      conflictingFileIds.push(contactId);
    }
  }
  return {
    complete: true,
    targetMatch,
    conflictingFileIds: [...new Set(conflictingFileIds)]
  };
}

function gmailMessageMatchesFile(message, file) {
  const correlation = gmailMessageFileCorrelation(message, file);
  return correlation.complete
    && correlation.targetMatch
    && correlation.conflictingFileIds.length === 0;
}

function gmailDraftReconciliationShape(value = {}) {
  return {
    to: String(value.to || "").trim(),
    cc: String(value.cc || "").trim(),
    bcc: String(value.bcc || "").trim(),
    subject: String(value.subject || "").trim(),
    body: normalizeEmailBody(value.body || ""),
    attachments: (Array.isArray(value.attachments) ? value.attachments : []).map((attachment) => ({
      filename: String(attachment?.filename || ""),
      bytes: Number(attachment?.bytes || 0),
      sha256: String(attachment?.sha256 || "").toLowerCase()
    }))
  };
}

function gmailDraftReconciliationDigest(value = {}) {
  return digest({ version: 1, draft: gmailDraftReconciliationShape(value) });
}

function gmailImmutableSendDigest(value = {}) {
  const deliveryHeaders = value.deliveryHeaders || {};
  const body = normalizeEmailBody(value.body || "");
  const bodyRepresentations = Array.isArray(value.bodyRepresentations)
    ? value.bodyRepresentations.map((representation) => ({
      mimeType: String(representation?.mimeType || "").toLowerCase(),
      bytes: Number(representation?.bytes || 0),
      sha256: String(representation?.sha256 || "").toLowerCase(),
      content: normalizeEmailBody(representation?.content || "")
    }))
    : [{
      mimeType: "text/plain",
      bytes: Buffer.byteLength(body, "utf8"),
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      content: body
    }];
  return digest({
    version: 1,
    message: {
      from: String(deliveryHeaders.from || "").trim(),
      sender: String(deliveryHeaders.sender || "").trim(),
      replyTo: String(deliveryHeaders.replyTo || "").trim(),
      ...gmailDraftReconciliationShape(value),
      bodyRepresentations,
      attachments: (Array.isArray(value.attachments) ? value.attachments : []).map((attachment) => ({
        filename: String(attachment?.filename || ""),
        mimeType: String(attachment?.mimeType || attachment?.contentType || "").toLowerCase(),
        bytes: Number(attachment?.bytes || 0),
        sha256: String(attachment?.sha256 || "").toLowerCase()
      }))
    }
  });
}

function contentContainsExactIdentifier(content, identifier) {
  const expected = String(identifier || "").normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (expected.length < 6) return false;
  const candidates = String(content || "").match(/[A-Za-z0-9]+(?:[-_.#/][A-Za-z0-9]+)*/g) || [];
  return candidates.some((candidate) => (
    candidate.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "").toLowerCase() === expected
  ));
}

async function gmailDraft(input) {
  const operatorFile = await operatorGmailActionFile(input, "Gmail draft");
  const to = validateEmailAddressList(required(input.to, "to"), "to", { required: true });
  const subject = validateEmailHeaderValue(required(input.subject, "subject"), "subject");
  if (
    operatorFile
    && isMacCodexOperatorRequest()
    && !operatorCompanyScopeActive()
    && input.insuranceClaimEmail === true
  ) {
    const claimNumber = String(operatorFile.claimNumber || "").trim();
    if (!claimNumber) {
      badRequest("The exact JobNimbus file has no verified claim number, so a carrier Gmail draft cannot be created in the locked Chance run.");
    }
    if (subject.trim() !== claimNumber) {
      badRequest(`Carrier Gmail draft subject must be exactly the live JobNimbus claim number: ${claimNumber}.`);
    }
  }
  const cc = validateEmailAddressList(input.cc, "cc");
  const bcc = validateEmailAddressList(input.bcc, "bcc");
  const threadId = String(input.threadId || "").trim();
  const attachments = await loadEmailAttachments(operatorFile
    ? { ...input, [INTERNAL_GMAIL_ACTION_SCOPE]: { file: operatorFile } }
    : input);
  const resolvedMessage = await resolveGmailMessageBody(input, attachments);
  const body = resolvedMessage.body;
  const reusable = await reusableGmailDraft(input, subject);
  if (reusable) {
    const bodyMatches = normalizeEmailBody(reusable.snapshot.body) === normalizeEmailBody(body);
    if (input.execute === true) {
      conflictError(
        bodyMatches
          ? "A Gmail draft for this exact file and claim subject appeared after approval. Nothing new was created; reconcile and review that draft before any retry."
          : "A different Gmail draft for this exact file and claim subject appeared after approval. Nothing new was created; reconcile the mismatch before any retry."
      );
    }
    return {
      mode: "existing_draft",
      fileScope: {
        id: reusable.file.id,
        number: reusable.file.number,
        name: reusable.file.name
      },
      draft: reusable.snapshot,
      bodyTemplate: resolvedMessage.template,
      bodyMatches,
      instruction: bodyMatches
        ? "A verified Gmail draft already exists for this file and subject. Do not create another draft. After Chance separately approves sending it, use gmail.send_existing_draft with this exact draftId; the reviewed source draft remains for separately approved cleanup."
        : "A Gmail draft already exists for this file and subject, but its body does not match the current approved carrier template. Do not send it and do not create a duplicate. Show Chance the mismatch and obtain approval before replacing the existing draft.",
      sendPayload: cleanObject({
        query: input.query || input.fileQuery || "",
        draftId: reusable.snapshot.id
      }),
      expectedBody: bodyMatches ? undefined : body
    };
  }
  const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments });
  const draftBody = { message: cleanObject({ raw, threadId }) };
  const plan = {
    endpoint: "/gmail/v1/users/me/drafts",
    ...(operatorFile ? {
      fileScope: {
        id: operatorFile.id,
        number: operatorFile.number,
        name: operatorFile.name
      }
    } : {}),
    to,
    cc,
    bcc,
    subject,
    body,
    bodyTemplate: resolvedMessage.template,
    threadId,
    attemptId: String(input.attemptId || "initial"),
    attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source))
  };
  const approvalDigest = digest({ channel: "gmail", action: "create_draft", plan });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan,
      approvalDigest
    };
  }
  requireApprovalDigest(input.approvalDigest, approvalDigest, "Gmail draft");
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to create Gmail drafts.");
  const reservation = await reserveOutboundSend("gmail_draft", approvalDigest, {
    to,
    subject,
    sourceKey: operatorFile
      ? `claim-draft:${operatorFile.id}:${subject.trim()}`
      : ""
  });
  let result;
  let verifiedByReadback = false;
  try {
    result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts`, {
      method: "POST",
      body: draftBody
    });
    const externalId = String(result.id || result.message?.id || "").trim();
    const lockedOperatorDraft = operatorFile
      && isMacCodexOperatorRequest()
      && !operatorCompanyScopeActive()
      && CHANCE_OPERATOR_RUN_MANIFEST?.allowedActionTypes.includes("gmail.create_draft");
    if (lockedOperatorDraft) {
      await completeOutboundSend(reservation.id, "readback_pending", externalId);
      const snapshot = await gmailDraftSnapshot(externalId);
      if (
        gmailDraftReconciliationDigest(snapshot) !== gmailDraftReconciliationDigest(plan)
        || (threadId && String(snapshot.threadId || "") !== threadId)
      ) {
        conflictError("The Gmail provider readback does not match the approved draft content. The exact file is quarantined from retry.");
      }
      verifiedByReadback = true;
    }
    await completeOutboundSend(reservation.id, "completed", externalId);
  } catch (error) {
    await completeOutboundSend(
      reservation.id,
      "failed_requires_review",
      result?.id || result?.message?.id || "",
      error.message
    );
    throw error;
  }
  const file = operatorFile || await optionalChanceFile(input.query || input.fileQuery);
  const memoryCloseout = closeoutGmailAction(input, file, "create_draft", result.id || result.message?.id, `Created approved Gmail draft with subject ${subject} and ${attachments.length} verified attachment(s).`, "drafted");
  return {
    mode: "executed",
    ...(verifiedByReadback ? { verifiedByReadback: true } : {}),
    ...(file ? { file } : {}),
    ...(operatorFile ? {
      fileScope: {
        id: operatorFile.id,
        number: operatorFile.number,
        name: operatorFile.name
      }
    } : {}),
    draft: compactGmailDraft(result),
    attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source)),
    memoryCloseout
  };
}

async function gmailSend(input, options = {}) {
  const draftId = String(input.draftId || "").trim();
  const operatorFile = await operatorGmailActionFile(input, "Gmail send");
  if (draftId) {
    return gmailSendExistingDraft(input, draftId, operatorFile, {
      operatorExistingDraftLane: options.operatorExistingDraftLane === true
    });
  }
  if (operatorFile) {
    badRequest("The Codex operator may send only a bridge-created Gmail draft that was reviewed by exact draftId.");
  }

  const to = validateEmailAddressList(required(input.to, "to"), "to", { required: true });
  const subject = validateEmailHeaderValue(required(input.subject, "subject"), "subject");
  const cc = validateEmailAddressList(input.cc, "cc");
  const bcc = validateEmailAddressList(input.bcc, "bcc");
  const threadId = String(input.threadId || "").trim();
  const attachments = await loadEmailAttachments(input);
  const resolvedMessage = await resolveGmailMessageBody(input, attachments);
  const body = resolvedMessage.body;
  const reusable = await reusableGmailDraft(input, subject);
  if (reusable) {
    badRequest(`A verified Gmail draft already exists for this file and subject. Send the reviewed draft with gmail.send_existing_draft payload {draftId:'${reusable.snapshot.id}', query:'${input.query || input.fileQuery || ""}'}; do not rebuild the email or create another draft.`);
  }
  const raw = buildRawEmail({ to, cc, bcc, subject, body, attachments });
  const sendBody = cleanObject({ raw, threadId });
  const plan = {
    endpoint: "/gmail/v1/users/me/messages/send",
    to,
    cc,
    bcc,
    subject,
    body,
    bodyTemplate: resolvedMessage.template,
    threadId,
    attemptId: String(input.attemptId || "initial"),
    attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source))
  };
  const approvalDigest = digest({ channel: "gmail", action: "send", plan });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan,
      approvalDigest,
      instruction: "Nothing was sent. After Chance approves this exact plan, repeat with execute:true and this approvalDigest."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to send Gmail messages.");
  if (!ALLOW_GMAIL_SEND) badRequest("Gmail sending is disabled. Set ALLOW_GMAIL_SEND=true in Render.");
  requireApprovalDigest(input.approvalDigest, approvalDigest, "Gmail send");
  const reservation = await reserveOutboundSend("gmail", approvalDigest, { to, subject });
  let result;
  try {
    result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/send`, {
      method: "POST",
      body: sendBody
    });
    await completeOutboundSend(reservation.id, "completed", result.id || "");
  } catch (error) {
    await completeOutboundSend(reservation.id, "failed_requires_review", "", redactSensitiveText(error.message));
    throw error;
  }
  const file = await optionalChanceFile(input.query || input.fileQuery);
  const memoryCloseout = closeoutGmailAction(input, file, "send_email", result.id, `Sent approved Gmail message with subject ${subject} and ${attachments.length} verified attachment(s).`);
  return { mode: "executed", message: compactGmailMessage(result), attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source)), memoryCloseout };
}

function normalizeEmailBody(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function standardRepresentationPackage(attachments = []) {
  const names = attachments.map((attachment) => String(attachment.filename || "").toLowerCase());
  return {
    isComplete: names.some((name) => /(?:^|[^a-z])(?:lor|letter[ _-]*of[ _-]*representation)(?:[^a-z]|$)/i.test(name)) &&
      names.some((name) => /(?:fin[ _-]*535|tdi)/i.test(name)) &&
      names.some((name) => /(?:^|[^a-z])w[ _-]*-?[ _-]*9(?:[^a-z]|$)/i.test(name))
  };
}

function paymentRedirectionEmailBody(policyholder) {
  return [
    "Good afternoon,",
    "",
    `Attached please find an executed FIN535, an updated LOR, and W9 for the above referenced claim (policyholder: ${policyholder}). Please send payment to our office with Wave Public Adjusting LLC included as a payee.`,
    "",
    "Thank you,",
    "",
    "Chance Pearson",
    "",
    "972-573-1730",
    "",
    "Wave Public Adjusting LLC",
    "",
    "3500 Oak Lawn Ave #460C",
    "",
    "Dallas TX 75219",
    "",
    "TX Lic # 3351885"
  ].join("\n");
}

async function resolveGmailMessageBody(input, attachments) {
  const packageReview = standardRepresentationPackage(attachments);
  const requestedTemplate = String(input.template || "").trim().toLowerCase();
  if (requestedTemplate && requestedTemplate !== "payment_redirection") {
    badRequest(`Unsupported Gmail template: ${requestedTemplate}`);
  }
  if (requestedTemplate === "payment_redirection" || packageReview.isComplete) {
    const query = required(input.query || input.fileQuery, "query");
    const file = await optionalChanceFile(query);
    const generatedPolicyholder = attachments.find((attachment) => attachment.source === "generated_lor")?.insuredName;
    const policyholder = String(input.policyholderName || generatedPolicyholder || file?.name || "").trim();
    if (!policyholder) badRequest("A verified policyholder name is required for the payment-redirection email template.");
    return { body: paymentRedirectionEmailBody(policyholder), template: "payment_redirection" };
  }
  return { body: required(input.body, "body"), template: "custom" };
}

async function gmailSendExistingDraft(input, draftId, operatorFile = null, options = {}) {
  const lockedOperatorLane = options.operatorExistingDraftLane === true
    && operatorFile
    && isMacCodexOperatorRequest()
    && !operatorCompanyScopeActive()
    && CHANCE_OPERATOR_RUN_MANIFEST?.allowedActionTypes.includes("gmail.send_existing_draft");
  if (options.operatorExistingDraftLane === true && !lockedOperatorLane) {
    operatorScopeError("The existing-draft send lane is available only to the assigned Mac operator under the current pinned run manifest.");
  }
  const draftProvenance = operatorFile
    ? await assertOperatorDraftProvenance(operatorFile, draftId, {
      currentRunOnly: lockedOperatorLane
    })
    : null;
  const sourceKey = `gmail-draft:${String(draftId)}`;
  await assertOutboundSourceAvailable("gmail", sourceKey);
  const snapshot = await gmailDraftSnapshot(draftId);
  if (lockedOperatorLane) {
    const liveClaimNumber = String(operatorFile.claimNumber || "").trim();
    if (!liveClaimNumber || snapshot.subject !== liveClaimNumber) {
      conflictError("The reviewed Gmail draft subject no longer equals the live JobNimbus claim number. Nothing was sent.");
    }
  }
  const plan = {
    endpoint: "/gmail/v1/users/me/messages/send",
    action: "send_existing_draft",
    deliveryMode: "immutable_reviewed_snapshot_source_draft_retained",
    ...(operatorFile ? {
      fileScope: {
        id: operatorFile.id,
        number: operatorFile.number,
        name: operatorFile.name
      }
    } : {}),
    draftId: snapshot.id,
    messageId: snapshot.messageId,
    threadId: snapshot.threadId,
    to: snapshot.to,
    cc: snapshot.cc,
    bcc: snapshot.bcc,
    subject: snapshot.subject,
    deliveryHeaders: snapshot.deliveryHeaders,
    body: snapshot.body,
    bodyRepresentations: snapshot.bodyRepresentations,
    attachments: snapshot.attachments,
    contentDigest: snapshot.contentDigest,
    transmittedHeaders: ["From", "Sender", "Reply-To", "To", "Cc", "Bcc", "Subject", "MIME-Version", "Content-Type"],
    omittedOriginalHeaders: "Any original draft header not listed in transmittedHeaders is excluded from the immutable send.",
    sourceDraftRetention: "retained_for_separate_cleanup",
    ...(lockedOperatorLane ? {
      draftProvenance: {
        createdByBridge: true,
        creationRunPolicySha256: draftProvenance.runPolicySha256,
        currentRunPolicySha256: CHANCE_OPERATOR_RUN_MANIFEST.sha256,
        immediatePredecessorReattested: draftProvenance.immediatePredecessorReattested,
        providerSnapshotReadback: true
      }
    } : {})
  };
  const approvalDigest = digest({ channel: "gmail", action: "send_existing_draft", plan });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan,
      approvalDigest,
      instruction: "Nothing was sent. After Chance approves this exact existing draft, repeat gmail.send_existing_draft unchanged with execute:true, this draftId, and this approvalDigest. The bridge sends only the immutable reviewed snapshot and retains the source draft; deleting it is a separate approval-gated action."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to send Gmail messages.");
  if (!lockedOperatorLane && !ALLOW_GMAIL_SEND) {
    badRequest("General Gmail sending is disabled. Only the pinned assigned-operator existing-draft lane may bypass ALLOW_GMAIL_SEND.");
  }
  requireApprovalDigest(input.approvalDigest, approvalDigest, "Gmail existing-draft send");
  const reservation = await reserveOutboundSend("gmail", approvalDigest, {
    to: snapshot.to,
    subject: snapshot.subject,
    sourceKey
  });
  let result;
  let sentSnapshot;
  try {
    const raw = buildRawEmail({
      from: snapshot.deliveryHeaders.from || "",
      sender: snapshot.deliveryHeaders.sender || "",
      replyTo: snapshot.deliveryHeaders.replyTo || "",
      to: snapshot.to,
      cc: snapshot.cc,
      bcc: snapshot.bcc,
      subject: snapshot.subject,
      body: snapshot.body,
      attachments: snapshot[GMAIL_DRAFT_MIME_BYTES]
    });
    result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/send`, {
      method: "POST",
      body: cleanObject({ raw, threadId: snapshot.threadId })
    });
    const externalId = String(result.id || "").trim();
    if (lockedOperatorLane) {
      await completeOutboundSend(reservation.id, "readback_pending", externalId);
      sentSnapshot = await gmailSentMessageSnapshot(externalId);
      const labels = new Set(sentSnapshot.labelIds);
      if (
        !labels.has("SENT")
        || labels.has("DRAFT")
        || labels.has("TRASH")
        || labels.has("SPAM")
        || gmailImmutableSendDigest(sentSnapshot) !== gmailImmutableSendDigest(snapshot)
        || (snapshot.threadId && sentSnapshot.threadId !== snapshot.threadId)
      ) {
        conflictError("The Gmail Sent-message readback does not match the approved immutable draft snapshot. Never retry this send; reconcile the exact file and provider receipt.");
      }
      const retainedSnapshot = await gmailDraftSnapshot(draftId);
      if (retainedSnapshot.contentDigest !== snapshot.contentDigest) {
        conflictError("The source Gmail draft was not retained unchanged after delivery. Never retry this send; reconcile the exact file and provider receipt.");
      }
    }
    await completeOutboundSend(reservation.id, "completed", externalId);
  } catch (error) {
    await completeOutboundSend(
      reservation.id,
      "failed_requires_review",
      result?.id || "",
      redactSensitiveText(error.message)
    );
    throw error;
  }
  const sourceDraftRetention = {
    retained: true,
    status: "retained_for_separate_cleanup",
    authority: "The send approval did not authorize deleting the source draft."
  };
  const file = operatorFile || await optionalChanceFile(input.query || input.fileQuery);
  const memoryCloseout = closeoutGmailAction(
    input,
    file,
    "send_draft",
    result.id,
    `Sent approved immutable Gmail draft snapshot with ${snapshot.attachments.length} verified attachment(s); the source draft was retained.`
  );
  return {
    mode: "executed",
    ...(lockedOperatorLane ? { verifiedByReadback: true } : {}),
    ...(file ? { file } : {}),
    message: sentSnapshot?.message || compactGmailMessage(result),
    sourceDraftId: draftId,
    attachments: snapshot.attachments,
    sourceDraftRetention,
    memoryCloseout
  };
}

async function reusableGmailDraft(input, subject) {
  const query = input.query || input.fileQuery;
  if (!query) return null;
  const file = await optionalChanceFile(query);
  if (!file) return null;
  const receipt = latestActionReceipts(MEMORY_CONFIG, 40, { subjectKey: file.id })
    .find((row) => row.channel === "gmail" && row.action === "create_draft" && row.status === "drafted" && row.externalId && row.summary.includes(`subject ${subject}`));
  let draftId = String(receipt?.externalId || "").trim();
  if (!draftId) {
    const sourceKeyHash = createHash("sha256")
      .update(`claim-draft:${file.id}:${String(subject || "").trim()}`, "utf8")
      .digest("hex");
    const outbound = (await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger"))
      .find((row) => (
        row.channel === "gmail_draft"
        && row.sourceKeyHash === sourceKeyHash
        && row.status === "completed"
        && row.externalId
      ));
    draftId = String(outbound?.externalId || "").trim();
  }
  if (!draftId) return null;
  try {
    return { file, receipt: receipt || null, snapshot: await gmailDraftSnapshot(draftId) };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

async function reconcileGmailDraftIntent(intent) {
  const expected = intent?.reconciliation || {};
  const subject = String(expected.subject || "").trim();
  const expectedDigest = String(expected.contentDigest || "").trim();
  const sourceKeyHash = String(expected.sourceKeyHash || "").trim();
  const channelApprovalDigest = String(expected.channelApprovalDigest || "").trim();
  if (!subject || !expectedDigest || !sourceKeyHash || !channelApprovalDigest) {
    conflictError("The interrupted Gmail draft intent is incomplete. Manual reconciliation is required.");
  }
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(intent.fileId)}`);
  assertOperatorContactScope(contact);
  if (String(compactContact(contact).claimNumber || "").trim() !== subject) {
    conflictError("The file claim number changed after the interrupted Gmail draft. Manual reconciliation is required.");
  }

  const outbound = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
  const candidates = outbound.filter((row) => (
    row.channel === "gmail_draft"
    && row.sourceKeyHash === sourceKeyHash
    && row.approvalDigest === channelApprovalDigest
    && row.status !== "verified_not_applied"
  ));
  if (candidates.length > 1) {
    conflictError("More than one Gmail draft reservation exists for this exact file and claim subject. Manual reconciliation is required.");
  }
  const reservation = candidates[0] || null;
  if (!reservation) {
    return { applied: false, externalId: "", reservationId: "", verifiedByReadback: true };
  }

  let snapshots = [];
  const recordedDraftId = String(reservation.externalId || "").trim();
  if (recordedDraftId) {
    try {
      snapshots = [await gmailDraftSnapshot(recordedDraftId)];
    } catch (error) {
      if (Number(error?.statusCode) !== 404) throw error;
    }
  } else {
    let pageToken = "";
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({
        maxResults: "100",
        q: `in:drafts subject:\"${subject.replace(/["\\]/g, " ")}\"`
      });
      if (pageToken) params.set("pageToken", pageToken);
      const listed = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts?${params.toString()}`);
      for (const draft of Array.isArray(listed?.drafts) ? listed.drafts : []) {
        const draftId = String(draft?.id || "").trim();
        if (!draftId) continue;
        const snapshot = await gmailDraftSnapshot(draftId);
        if (snapshot.subject === subject) snapshots.push(snapshot);
      }
      pageToken = String(listed?.nextPageToken || "").trim();
      if (!pageToken) break;
      if (page === 4) {
        const error = new Error("Gmail draft reconciliation exceeded 500 candidate drafts and cannot prove a complete result.");
        error.statusCode = 503;
        throw error;
      }
    }
  }

  const matches = snapshots.filter((snapshot) => (
    gmailDraftReconciliationDigest(snapshot) === expectedDigest
    && (!expected.threadId || String(snapshot.threadId || "") === String(expected.threadId))
  ));
  if (matches.length > 1) {
    conflictError("Multiple Gmail drafts exactly match the interrupted approved intent. Manual reconciliation is required.");
  }
  const applied = matches.length === 1;
  const externalId = applied ? String(matches[0].id || "") : "";
  await withOutboundSendMutation(async () => {
    const ledger = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
    const row = ledger.find((item) => item.id === reservation.id);
    if (!row) conflictError("The Gmail draft reservation changed during reconciliation.");
    row.status = applied ? "completed" : "verified_not_applied";
    row.externalId = externalId;
    row.reconciledAt = new Date().toISOString();
    row.updatedAt = row.reconciledAt;
    await writeOutboundSendLedger(ledger);
  });
  return {
    applied,
    externalId,
    reservationId: reservation.id,
    verifiedByReadback: true
  };
}

async function reconcileGmailSendIntent(intent) {
  const expected = intent?.reconciliation || {};
  const subject = String(expected.subject || "").trim();
  const expectedDigest = String(expected.contentDigest || "").trim();
  const sourceKeyHash = String(expected.sourceKeyHash || "").trim();
  const channelApprovalDigest = String(expected.channelApprovalDigest || "").trim();
  const draftId = String(expected.draftId || "").trim();
  const sourceDraftContentDigest = String(expected.sourceDraftContentDigest || "").trim();
  if (
    !subject
    || !expectedDigest
    || !sourceKeyHash
    || !channelApprovalDigest
    || !draftId
    || !sourceDraftContentDigest
  ) {
    conflictError("The interrupted Gmail existing-draft send intent is incomplete. Manual reconciliation is required.");
  }
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(intent.fileId)}`);
  assertOperatorContactScope(contact);
  if (String(compactContact(contact).claimNumber || "").trim() !== subject) {
    conflictError("The file claim number changed after the approved Gmail send. Manual reconciliation is required.");
  }

  const outbound = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
  const candidates = outbound.filter((row) => (
    row.channel === "gmail"
    && row.sourceKeyHash === sourceKeyHash
    && row.approvalDigest === channelApprovalDigest
    && row.status !== "verified_not_applied"
  ));
  if (candidates.length > 1) {
    conflictError("More than one Gmail send reservation exists for this exact source draft. Manual reconciliation is required.");
  }
  const reservation = candidates[0] || null;
  if (!reservation) {
    return { applied: false, externalId: "", reservationId: "", verifiedByReadback: true };
  }
  const externalId = String(reservation.externalId || "").trim();
  if (!externalId) {
    conflictError("The Gmail send reservation has no provider message id. The outcome is ambiguous and the exact file must remain quarantined.");
  }

  const snapshot = await gmailSentMessageSnapshot(externalId);
  const labels = new Set(snapshot.labelIds);
  if (
    !labels.has("SENT")
    || labels.has("DRAFT")
    || labels.has("TRASH")
    || labels.has("SPAM")
    || gmailImmutableSendDigest(snapshot) !== expectedDigest
    || (expected.threadId && snapshot.threadId !== String(expected.threadId))
  ) {
    conflictError("The recorded Gmail message does not exactly match the approved existing-draft send intent. Manual reconciliation is required.");
  }
  const retainedSnapshot = await gmailDraftSnapshot(draftId);
  if (retainedSnapshot.contentDigest !== sourceDraftContentDigest) {
    conflictError("The source Gmail draft is not retained unchanged after the interrupted send. Manual reconciliation is required.");
  }
  await withOutboundSendMutation(async () => {
    const ledger = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
    const row = ledger.find((item) => item.id === reservation.id);
    if (!row) conflictError("The Gmail send reservation changed during reconciliation.");
    row.status = "completed";
    row.externalId = externalId;
    row.reconciledAt = new Date().toISOString();
    row.updatedAt = row.reconciledAt;
    await writeOutboundSendLedger(ledger);
  });
  return {
    applied: true,
    externalId,
    reservationId: reservation.id,
    verifiedByReadback: true
  };
}

function operatorDraftCreationRunPolicyShas() {
  const current = CHANCE_OPERATOR_RUN_MANIFEST;
  if (!current) return new Set();
  const accepted = new Set([current.sha256]);
  if (current.allowedActionTypes.includes("gmail.send_existing_draft")) {
    const immediatePredecessor = loadChanceOperatorRunManifest({
      schemaVersion: current.schemaVersion,
      id: current.id,
      operatorScope: current.operatorScope,
      expiresAt: current.expiresAt,
      files: current.files.map((row) => ({ number: row.number, fileId: row.fileId })),
      excludedFileNumbers: current.excludedFileNumbers,
      allowedActionTypes: current.allowedActionTypes.filter(
        (type) => type !== "gmail.send_existing_draft"
      ),
      allowedContactFields: current.allowedContactFields
    });
    accepted.add(immediatePredecessor.sha256);
  }
  return accepted;
}

async function assertOperatorDraftProvenance(file, draftId, options = {}) {
  const batches = await readActionBatchLedger();
  const currentPrincipalHash = options.currentRunOnly === true
    ? actionApprovalIdentityHash()
    : "";
  const acceptedRunPolicyShas = operatorDraftCreationRunPolicyShas();
  let matched = null;
  for (const batch of batches) {
    if (options.currentRunOnly === true) {
      if (
        batch.principalHash !== currentPrincipalHash
        || batch.operatorScope !== "assigned"
        || batch.runPolicyId !== CHANCE_OPERATOR_RUN_MANIFEST?.id
        || !acceptedRunPolicyShas.has(batch.runPolicySha256)
        || batch.status !== "completed"
        || Number(batch.operationCount) !== 1
        || Number(batch.fileCount) !== 1
      ) continue;
      const boundFile = (Array.isArray(batch.files) ? batch.files : []).find((row) => (
        String(row?.id || "") === String(file.id)
        && String(row?.number || "").replace(/^#/, "") === String(file.number || "").replace(/^#/, "")
      ));
      if (
        !boundFile
        || !Array.isArray(boundFile.operationTypes)
        || boundFile.operationTypes.length !== 1
        || boundFile.operationTypes[0] !== "gmail.create_draft"
      ) continue;
    }
    const completedReceipt = (Array.isArray(batch.completed) ? batch.completed : []).find((row) => (
      row.type === "gmail.create_draft"
      && row.status === "executed"
      && String(row.receipt?.fileId || "") === String(file.id)
      && String(row.receipt?.externalId || "") === String(draftId)
      && (
        options.currentRunOnly !== true
        || batch.runPolicySha256 !== CHANCE_OPERATOR_RUN_MANIFEST?.sha256
        || row.receipt?.verifiedByReadback === true
      )
      && row.receipt?.manualVerificationRequired !== true
    ));
    if (completedReceipt) {
      matched = { batch, completedReceipt };
      break;
    }
  }
  if (!matched) {
    operatorScopeError(`The Codex operator may send only a Gmail draft created by this bridge for the resolved ${operatorFileDescription()}.`);
  }
  return {
    runPolicySha256: String(matched.batch.runPolicySha256 || ""),
    immediatePredecessorReattested: options.currentRunOnly === true
      && matched.batch.runPolicySha256 !== CHANCE_OPERATOR_RUN_MANIFEST?.sha256
  };
}

async function gmailDraftSnapshot(draftId) {
  const draft = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts/${encodeURIComponent(draftId)}?format=full`);
  const rawMessage = draft.message || {};
  const message = compactGmailMessage(rawMessage);
  const headers = gmailDeliveryHeaders(draft.message || {});
  const mime = await gmailDraftMimeSnapshot(rawMessage);
  const deliveryHeaders = cleanObject({
    from: headers.from,
    sender: headers.sender,
    replyTo: headers["reply-to"],
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc,
    subject: headers.subject
  });
  const snapshot = {
    id: String(draft.id || draftId),
    messageId: message.id,
    threadId: message.threadId,
    to: headers.to || "",
    cc: headers.cc || "",
    bcc: headers.bcc || "",
    subject: headers.subject || "",
    deliveryHeaders,
    body: mime.primaryBody,
    bodyRepresentations: mime.bodyRepresentations,
    attachments: mime.attachments,
    contentDigest: digest({
      draftId: String(draft.id || draftId),
      messageId: message.id,
      threadId: message.threadId,
      deliveryHeaders,
      bodyRepresentations: mime.bodyRepresentations,
      attachments: mime.attachments,
      payload: draft.message?.payload || null
    })
  };
  Object.defineProperty(snapshot, GMAIL_DRAFT_MIME_BYTES, {
    value: mime[GMAIL_DRAFT_MIME_BYTES],
    enumerable: false
  });
  return snapshot;
}

async function gmailSentMessageSnapshot(messageId) {
  const messageIdValue = String(messageId || "").trim();
  if (!messageIdValue) {
    conflictError("Gmail did not return a sent message id, so delivery cannot be verified.");
  }
  const rawMessage = await gmailApi(
    `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(messageIdValue)}?format=full`
  );
  const message = compactGmailMessage(rawMessage);
  const headers = gmailDeliveryHeaders(rawMessage);
  const mime = await gmailDraftMimeSnapshot(rawMessage);
  const deliveryHeaders = cleanObject({
    from: headers.from,
    sender: headers.sender,
    replyTo: headers["reply-to"],
    to: headers.to,
    cc: headers.cc,
    bcc: headers.bcc,
    subject: headers.subject
  });
  const snapshot = {
    id: message.id,
    messageId: message.id,
    message,
    threadId: message.threadId,
    labelIds: [...new Set(
      (Array.isArray(rawMessage?.labelIds) ? rawMessage.labelIds : [])
        .map((label) => String(label || "").trim().toUpperCase())
        .filter(Boolean)
    )],
    to: headers.to || "",
    cc: headers.cc || "",
    bcc: headers.bcc || "",
    subject: headers.subject || "",
    deliveryHeaders,
    body: mime.primaryBody,
    bodyRepresentations: mime.bodyRepresentations,
    attachments: mime.attachments
  };
  Object.defineProperty(snapshot, GMAIL_DRAFT_MIME_BYTES, {
    value: mime[GMAIL_DRAFT_MIME_BYTES],
    enumerable: false
  });
  return snapshot;
}

async function gmailDraftMimeSnapshot(message) {
  const bodyRepresentations = [];
  const attachments = [];
  const attachmentMaterial = [];
  let bodyBytesTotal = 0;
  let attachmentBytesTotal = 0;
  let leafIndex = 0;
  const leafParts = [];
  walkGmailParts(message?.payload || {}, (part) => {
    if (Array.isArray(part?.parts) && part.parts.length) return;
    leafParts.push(part || {});
  });

  for (const part of leafParts) {
    leafIndex += 1;
    const mimeType = String(part.mimeType || "application/octet-stream").trim().toLowerCase();
    const filename = String(part.filename || "").trim();
    const partHeaders = gmailPartHeaders(part);
    const attachmentId = String(part.body?.attachmentId || "").trim();
    let bytes = Buffer.alloc(0);
    if (attachmentId) {
      if (!message?.id) badRequest("Gmail draft attachment is missing its message id.");
      const payload = await gmailApi(
        `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachmentId)}`
      );
      bytes = base64UrlToBuffer(payload?.data || "");
    } else if (part.body?.data) {
      bytes = base64UrlToBuffer(part.body.data);
    }

    const isBodyRepresentation = !filename && ["text/plain", "text/html"].includes(mimeType);
    if (isBodyRepresentation) {
      bodyBytesTotal += bytes.length;
      if (bodyBytesTotal > 100 * 1024) {
        badRequest("Gmail draft body representations exceed the 100 KB exact-review limit.");
      }
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) {
        badRequest(`Gmail draft ${mimeType} body is not valid UTF-8 and cannot be reviewed exactly.`);
      }
      bodyRepresentations.push(cleanObject({
        partId: String(part.partId || leafIndex),
        mimeType,
        disposition: partHeaders["content-disposition"] || "",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content
      }));
      continue;
    }

    if (!bytes.length) {
      badRequest(`Gmail draft MIME part ${filename || part.partId || leafIndex} is empty or unavailable.`);
    }
    if (!filename) {
      badRequest(`Gmail draft MIME part ${part.partId || leafIndex} has no filename and cannot be reconstructed for an exact immutable send.`);
    }
    const disposition = String(partHeaders["content-disposition"] || "").trim();
    if (disposition && !/^attachment(?:;|$)/i.test(disposition)) {
      badRequest(`Gmail draft attachment ${filename} uses unsupported non-attachment disposition.`);
    }
    if (partHeaders["content-id"]) {
      badRequest(`Gmail draft attachment ${filename} uses an unsupported Content-ID.`);
    }
    attachmentBytesTotal += bytes.length;
    if (attachmentBytesTotal > 20 * 1024 * 1024) {
      badRequest("Gmail draft attachments exceed the bridge's 20 MB exact-review limit.");
    }
    const descriptor = cleanObject({
      partId: String(part.partId || leafIndex),
      filename: safeMimeFilename(filename),
      mimeType,
      disposition,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    attachments.push(descriptor);
    attachmentMaterial.push({
      filename: descriptor.filename,
      contentType: mimeType,
      bytes
    });
  }

  if (
    bodyRepresentations.length !== 1
    || bodyRepresentations[0].mimeType !== "text/plain"
  ) {
    badRequest("Exact Gmail draft sending requires exactly one UTF-8 text/plain body representation; alternate HTML or multiple bodies are not supported.");
  }
  return {
    primaryBody: bodyRepresentations[0].content || "",
    bodyRepresentations,
    attachments,
    [GMAIL_DRAFT_MIME_BYTES]: attachmentMaterial
  };
}

function gmailPartHeaders(part) {
  const out = {};
  for (const header of Array.isArray(part?.headers) ? part.headers : []) {
    const key = String(header.name || "").trim().toLowerCase();
    if (!key || out[key] !== undefined) continue;
    out[key] = String(header.value || "");
  }
  return out;
}

function quoConfig() {
  return {
    apiKey: QUO_API_KEY,
    baseUrl: QUO_API_BASE_URL,
    defaultFrom: QUO_DEFAULT_FROM_NUMBER,
    allowSend: ALLOW_QUO_SEND,
    redact: redactSensitiveText
  };
}

async function quoNumbers() {
  if (currentRequestIdentity()?.type === "codex_operator_token") {
    const line = await authorizedQuoLine();
    const numbers = line.number ? [line] : [];
    return { count: numbers.length, numbers, scope: "authenticated_operator_line" };
  }
  const numbers = await listQuoNumbers(quoConfig());
  return { count: numbers.length, numbers };
}

async function assertUniqueChanceFilePhone(file, label) {
  const phone = normalizePhone(file?.phone);
  if (!phone) badRequest(`The resolved ${operatorFileDescription()} has no phone number for ${label}.`);
  const index = await hcnCachedContactIndex({ maxRecords: 5000 });
  if (!index.complete) {
    badRequest(`The complete company insurance-file phone index is unavailable, so ${label} is blocked.`);
  }
  const correlation = hcnGlobalPhoneCorrelation(
    index.rows.filter(isInsuranceFile),
    phone
  );
  if (
    !correlation.complete
    || correlation.matches.length !== 1
    || String(correlation.matches[0]?.jnid || correlation.matches[0]?.id || "") !== String(file.id)
  ) {
    badRequest(`The resolved phone is shared across multiple company insurance files, so ${label} is ambiguous and blocked.`);
  }
}

async function readExactOperatorQuoHistory(file, input = {}) {
  const history = await readQuoHistoryStrict(quoConfig(), {
    phone: file.phone,
    maxResults: clamp(Number(input.maxResults || 25), 1, 50),
    maxPages: clamp(Number(input.maxPages || 10), 1, 10)
  });
  const transcripts = [];
  if (input.includeTranscripts === true) {
    const recentCalls = history.timeline
      .filter((item) => item.type === "call")
      .sort((left, right) => String(right.atUtc).localeCompare(String(left.atUtc)))
      .slice(0, 3);
    for (const call of recentCalls) {
      const transcript = await readQuoTranscript(quoConfig(), call.id, {
        allowMissing: true
      });
      if (transcript) transcripts.push(transcript);
    }
  }
  return { ...history, transcripts };
}

async function quoHistory(input = {}) {
  let file = null;
  let phone = String(input.phone || "").trim();
  if (currentRequestIdentity()?.type === "codex_operator_token") {
    if (phone) badRequest("The Codex operator cannot query arbitrary Quo phone numbers.");
    const query = required(input.query, "query");
    file = compactContact((await findChanceContact(query)).contact);
    phone = file.phone;
    await assertUniqueChanceFilePhone(file, "Quo history");
  }
  if (input.query) {
    file ||= compactContact((await findChanceContact(input.query)).contact);
    phone ||= file.phone;
  }
  if (!phone) badRequest("phone or a Chance file query with a phone number is required");
  const history = isCodexOperatorRequest()
    ? await readExactOperatorQuoHistory(file, input)
    : await readQuoHistory(quoConfig(), {
        phone,
        maxResults: input.maxResults,
        includeTranscripts: input.includeTranscripts === true
      });
  return {
    generatedAt: new Date().toISOString(),
    file,
    ...(isCodexOperatorRequest() ? { scope: operatorFileScopeLabel() } : {}),
    ...history
  };
}

async function quoTranscript(input = {}) {
  const callId = required(input.callId, "callId");
  if (currentRequestIdentity()?.type !== "codex_operator_token") {
    return readQuoTranscript(quoConfig(), callId);
  }
  const query = required(input.query, "query");
  const file = compactContact((await findChanceContact(query)).contact);
  await assertUniqueChanceFilePhone(file, "Quo transcript verification");
  const history = await readExactOperatorQuoHistory(file, {
    maxResults: 50,
    includeTranscripts: false
  });
  const call = history.timeline.find((row) => row.type === "call" && String(row.id || "") === callId);
  if (!call) {
    operatorScopeError(`That Quo call id is not present in the current history for the resolved ${operatorFileDescription()}.`);
  }
  return {
    file,
    call,
    transcript: await readQuoTranscript(quoConfig(), callId),
    scope: operatorFileScopeLabel()
  };
}

async function quoSend(input = {}) {
  const query = required(input.query, "query");
  const { contact } = await findChanceContact(query);
  const file = compactContact(contact);
  const to = String(input.to || file.phone || "").trim();
  const content = required(input.content || input.message || input.text, "content");
  if (currentRequestIdentity()?.type === "codex_operator_token") {
    await assertUniqueChanceFilePhone(file, "Quo sending");
    if (input.userId !== undefined && String(input.userId || "").trim()) {
      badRequest("The Codex operator cannot select an arbitrary Quo userId.");
    }
    const allowedRecipients = new Set(
      [file.phone, file.adjusterPhone].map(normalizePhone).filter(Boolean)
    );
    if (!allowedRecipients.has(normalizePhone(to))) {
      badRequest("The Codex operator may text only a freshly verified client or desk-adjuster phone on the resolved file.");
    }
  }
  const authorizedLine = await authorizedQuoLine();
  const from = authorizedLine.number;
  if (!from) badRequest("No Quo sending line is configured for the authenticated employee.");
  const preview = await sendQuoText(quoConfig(), {
    from,
    to,
    content,
    userId: currentRequestIdentity()?.type === "codex_operator_token" ? undefined : input.userId,
    execute: false
  });
  const plan = { ...preview.plan, attemptId: String(input.attemptId || "initial") };
  const approvalDigest = digest({ channel: "quo", action: "send_text", fileId: file.id, plan });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      file,
      plan,
      approvalDigest,
      instruction: "Nothing was sent. After Chance approves this exact text and recipient, repeat with execute:true and this approvalDigest."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to send Quo texts.");
  if (!ALLOW_QUO_SEND) badRequest("Quo sending is disabled. Set ALLOW_QUO_SEND=true in Render.");
  requireApprovalDigest(input.approvalDigest, approvalDigest, "Quo send");
  const reservation = await reserveOutboundSend("quo", approvalDigest, { to: plan.to });
  let result;
  try {
    result = await sendQuoText(quoConfig(), {
      from: preview.plan.from,
      to: preview.plan.to,
      content: preview.plan.content,
      userId: currentRequestIdentity()?.type === "codex_operator_token" ? undefined : input.userId,
      execute: true
    });
    const acceptedStatus = String(result.message.status || "accepted").toLowerCase();
    await completeOutboundSend(
      reservation.id,
      acceptedStatus === "delivered" ? "completed" : `accepted_${acceptedStatus}`,
      result.message.id || ""
    );
  } catch (error) {
    await completeOutboundSend(reservation.id, "failed_requires_review", "", redactSensitiveText(error.message));
    throw error;
  }
  const deliveryStatus = String(result.message.status || "accepted").toLowerCase();
  const deliveryConfirmed = deliveryStatus === "delivered";
  const deliveryFailed = deliveryStatus === "failed" || deliveryStatus === "undelivered";
  const memoryCloseout = isCodexOperatorRequest()
    ? operatorMemoryCloseoutBoundary()
    : safeCloseoutAction(MEMORY_CONFIG, {
        channel: "quo",
        action: "send_text",
        status: result.message.status || "accepted",
        subjectKey: file.id,
        fileLabel: `${file.number || ""} ${file.name || ""}`.trim(),
        summary: "Submitted approved Quo text from Chance's configured line; final carrier delivery must be verified from Quo history.",
        externalId: result.message.id || "",
        followUps: input.followUps || [],
        evidence: result.message.id ? [`quo:${result.message.id}`] : []
      });
  return {
    ...result,
    file,
    delivery: {
      status: deliveryStatus,
      confirmed: deliveryConfirmed,
      failed: deliveryFailed,
      instruction: deliveryConfirmed
        ? "Quo reports the message delivered."
        : deliveryFailed
          ? "Quo reports a delivery failure. Do not retry automatically; use the failure detail in Quo and switch channels when appropriate."
          : "Quo accepted the message but carrier delivery is not confirmed. Do not describe it as delivered; recheck reviewQuoHistory for the final status."
    },
    memoryCloseout
  };
}

async function quoLineLink(input = {}) {
  const identity = currentRequestIdentity();
  if (!identity || identity.type !== "google_oauth") {
    badRequest("Quo line verification requires the employee to sign in with their own Wave Google account.");
  }
  const mode = String(input.mode || "status").trim().toLowerCase();
  if (!new Set(["status", "start", "verify"]).has(mode)) {
    badRequest("mode must be status, start, or verify");
  }

  if (mode === "status") {
    const line = await authorizedQuoLine(identity);
    return {
      mode,
      linked: Boolean(line.number),
      employee: { email: identity.email, name: identity.name },
      line: line.number ? { number: line.number, name: line.name, source: line.source } : null,
      instruction: line.number
        ? "This employee's approved Quo sends are locked to the linked line. Every message still requires an exact dry run and approval."
        : "Provide the employee's Quo business number with mode=start to receive a six-digit verification code."
    };
  }

  if (mode === "start") return startQuoLineVerification(identity, input);
  return verifyQuoLineCode(identity, input);
}

async function startQuoLineVerification(identity, input) {
  const number = normalizePhone(input.phone || input.number || "");
  if (!/^\+1\d{10}$/.test(number)) badRequest("A valid US Quo business number is required.");
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !normalizePhone(QUO_VERIFICATION_FROM_NUMBER)) {
    badRequest("Quo line verification SMS is not configured.");
  }
  const verificationFrom = normalizePhone(QUO_VERIFICATION_FROM_NUMBER);
  if (verificationFrom === number) badRequest("The verification sender must be different from the Quo line being linked.");

  const companyLines = await listQuoNumbers(quoConfig());
  const line = companyLines.find((row) => normalizePhone(row.number) === number);
  if (!line) badRequest("That number is not available in the company Quo account.");

  return mutateQuoLineStores(async () => {
    const now = Date.now();
    const links = await readQuoLineLinks();
    assertQuoLineAvailable(identity, line, links);
    const current = links.find((row) => row.email === String(identity.email || "").toLowerCase());
    if (current?.number === number) {
      return {
        mode: "start",
        linked: true,
        employee: { email: identity.email, name: identity.name },
        line: { number, name: line.name || "" },
        instruction: "This Quo line is already verified for the signed-in employee."
      };
    }

    const challenges = (await readQuoLineChallenges()).filter((row) => Number(row.expiresAt || 0) > now - 24 * 60 * 60 * 1000);
    const employeeChallenges = challenges.filter((row) => row.email === identity.email && Number(row.createdAt || 0) > now - 60 * 60 * 1000);
    if (employeeChallenges.length >= 5) {
      const error = new Error("Too many Quo verification codes were requested. Try again later.");
      error.statusCode = 429;
      throw error;
    }
    const latest = employeeChallenges.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
    if (latest && now - Number(latest.createdAt || 0) < 60 * 1000) {
      const error = new Error("Wait at least 60 seconds before requesting another verification code.");
      error.statusCode = 429;
      throw error;
    }

    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const challenge = {
      id: randomUUID(),
      email: String(identity.email || "").toLowerCase(),
      subject: String(identity.subject || ""),
      employeeName: String(identity.name || ""),
      lineId: String(line.id || ""),
      lineName: String(line.name || ""),
      number,
      codeHash: quoVerificationCodeHash(identity, number, code),
      attempts: 0,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      verifiedAt: 0
    };
    const delivery = await sendTwilioVerificationSms({
      to: number,
      from: verificationFrom,
      body: `Wave Ops verification code: ${code}. It expires in 10 minutes. Do not share this code.`
    });
    challenges.push(challenge);
    await writeQuoLineChallenges(challenges);
    return {
      mode: "start",
      linked: false,
      challengeId: challenge.id,
      employee: { email: identity.email, name: identity.name },
      line: { number, name: line.name || "" },
      verification: {
        sent: true,
        from: maskPhone(verificationFrom),
        to: maskPhone(number),
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        messageId: String(delivery.sid || "")
      },
      instruction: "Ask the employee for the six-digit code received in Quo, then call this action with mode=verify and the code. Never ask for or expose API credentials."
    };
  });
}

async function verifyQuoLineCode(identity, input) {
  const code = String(input.code || "").trim();
  if (!/^\d{6}$/.test(code)) badRequest("A six-digit verification code is required.");
  return mutateQuoLineStores(async () => {
    const now = Date.now();
    const challenges = await readQuoLineChallenges();
    const challenge = challenges
      .filter((row) => row.email === identity.email && !row.verifiedAt)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
    if (!challenge) badRequest("No pending Quo verification challenge was found for this employee.");
    if (Number(challenge.expiresAt || 0) <= now) badRequest("The Quo verification code has expired. Request a new code.");
    if (Number(challenge.attempts || 0) >= 5) badRequest("The Quo verification code is locked after too many failed attempts. Request a new code.");

    challenge.attempts = Number(challenge.attempts || 0) + 1;
    const expected = quoVerificationCodeHash(identity, challenge.number, code);
    if (!secureEqual(expected, challenge.codeHash)) {
      await writeQuoLineChallenges(challenges);
      badRequest("The Quo verification code is incorrect.");
    }

    const companyLines = await listQuoNumbers(quoConfig());
    const line = companyLines.find((row) => row.id === challenge.lineId && normalizePhone(row.number) === challenge.number);
    if (!line) badRequest("The Quo line is no longer available to the company API.");
    const links = await readQuoLineLinks();
    assertQuoLineAvailable(identity, line, links);
    const email = String(identity.email || "").toLowerCase();
    const updatedLinks = links.filter((row) => row.email !== email);
    updatedLinks.push({
      email,
      subject: String(identity.subject || ""),
      employeeName: String(identity.name || ""),
      lineId: String(line.id || ""),
      lineName: String(line.name || ""),
      number: normalizePhone(line.number),
      verifiedAt: new Date(now).toISOString(),
      verificationMethod: "twilio_sms_otp"
    });
    challenge.verifiedAt = now;
    await writeQuoLineLinks(updatedLinks);
    await writeQuoLineChallenges(challenges);
    return {
      mode: "verify",
      linked: true,
      employee: { email: identity.email, name: identity.name },
      line: { number: normalizePhone(line.number), name: line.name || "", source: "verified_sms_link" },
      instruction: "The employee's approved Quo sends are now locked to this line. Every actual message still requires an exact dry run and approval."
    };
  });
}

function assertQuoLineAvailable(identity, line, links) {
  const email = String(identity.email || "").toLowerCase();
  const number = normalizePhone(line.number);
  const claimed = links.find((row) => normalizePhone(row.number) === number && row.email !== email);
  if (claimed) {
    const error = new Error("That Quo line is already linked to another employee.");
    error.statusCode = 409;
    throw error;
  }
  if (number === normalizePhone(QUO_DEFAULT_FROM_NUMBER) && email !== CHANCE_GOOGLE_EMAIL) {
    const error = new Error("That Quo line is reserved for another employee.");
    error.statusCode = 409;
    throw error;
  }
  for (const user of WAVE_AUTH_USERS.values()) {
    const configured = normalizePhone(user.quoLineId || "");
    const configuredId = String(user.quoLineId || "").trim();
    if ((configured === number || configuredId === String(line.id || "")) && user.email !== email) {
      const error = new Error("That Quo line is reserved for another employee.");
      error.statusCode = 409;
      throw error;
    }
  }
}

function quoVerificationCodeHash(identity, number, code) {
  const secret = OAUTH_SESSION_SECRET || TWILIO_AUTH_TOKEN;
  return createHash("sha256")
    .update([secret, identity.email, identity.subject, normalizePhone(number), code].join("|"))
    .digest("hex");
}

function mutateQuoLineStores(operation) {
  const run = quoLineMutationQueue.then(operation);
  quoLineMutationQueue = run.catch(() => {});
  return run;
}

async function readQuoLineLinks() {
  const rows = await readJsonFile(QUO_LINE_LINK_STORE_PATH, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeQuoLineLinks(rows) {
  await writePrivateJsonFile(QUO_LINE_LINK_STORE_PATH, rows.slice(-200));
}

async function readQuoLineChallenges() {
  const rows = await readJsonFile(QUO_LINE_CHALLENGE_STORE_PATH, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeQuoLineChallenges(rows) {
  await writePrivateJsonFile(QUO_LINE_CHALLENGE_STORE_PATH, rows.slice(-500));
}

async function writePrivateJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function sendTwilioVerificationSms({ to, from, body: content }) {
  const url = `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ To: to, From: from, Body: content })
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!response.ok) {
    const error = new Error(json.message || `Twilio verification SMS failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  return phone ? `***-***-${phone.slice(-4)}` : "";
}

async function authorizedQuoLine(identity = currentRequestIdentity()) {
  if (!identity) return { number: "", name: "", id: "", source: "none" };
  const employeeLine = String(identity.quoLineId || "").trim();
  if (employeeLine) {
    const configuredPhone = normalizePhone(employeeLine);
    if (/^\+1\d{10}$/.test(configuredPhone)) {
      return {
        number: configuredPhone,
        name: String(identity.name || ""),
        id: "",
        source: "configured_employee"
      };
    }
    const companyLines = await listQuoNumbers(quoConfig());
    const configuredLine = companyLines.find((row) => row.id === employeeLine);
    if (!configuredLine) return { number: "", name: "", id: "", source: "invalid_configured_employee" };
    return {
      number: normalizePhone(configuredLine.number),
      name: String(configuredLine.name || identity.name || ""),
      id: String(configuredLine.id || ""),
      source: "configured_employee"
    };
  }

  const links = await readQuoLineLinks();
  const email = String(identity.email || "").trim().toLowerCase();
  const linked = links.find((row) => row.email === email);
  if (linked?.number) {
    return {
      number: normalizePhone(linked.number),
      name: String(linked.lineName || ""),
      id: String(linked.lineId || ""),
      source: "verified_sms_link"
    };
  }

  const isChance = identity.role === "chance" && (
    identity.type === "bridge_token" || email === CHANCE_GOOGLE_EMAIL
  );
  return isChance
    ? { number: normalizePhone(QUO_DEFAULT_FROM_NUMBER), name: "Chance Pearson", id: "", source: "chance_default" }
    : { number: "", name: "", id: "", source: "none" };
}

async function reviewChanceFiles(input = {}) {
  const operatorRequest = isCodexOperatorRequest();
  const companyScope = operatorCompanyScopeActive();
  const page = clamp(Number(input.page || 1), 1, 1000);
  const limit = clamp(Number(input.limit || (input.query ? 1 : 5)), 1, 10);
  let contacts;
  if (input.query) {
    contacts = [(await findChanceContact(input.query)).contact];
  } else {
    contacts = (await listContacts({ maxPages: Number(input.maxPages || 25) }))
      .filter(isInsuranceFile)
      .filter(chanceOperatorContactAllowed)
      .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
      .filter((contact) => input.activeOnly === false || isOpenActive(contact))
      .sort(fileSort);
  }
  const total = contacts.length;
  if (input.indexOnly === true && !input.query) {
    return {
      generatedAt: new Date().toISOString(),
      owner: { id: CHANCE_OWNER_ID, name: "Chance Pearson" },
      scope: "chance_assigned_file_index",
      mode: "index",
      total,
      files: contacts.map(compactChanceIndexContact),
      brain: operatorRequest ? operatorBrainBoundary() : reviewBrainContext("", input.maxPerSection),
      assistantDirective: [
        "This is a lightweight, fresh JobNimbus index for prioritization only.",
        operatorRequest
          ? "Chance Brain client memory is neither read nor written by the Codex operator."
          : "The company brain is included, but rich client snapshots are intentionally not overwritten by this lightweight index.",
        "Choose the highest-priority candidate using current status, missing claim facts, and last update.",
        "Then call this endpoint again with that exact file as query, limit 1, and Gmail/Quo enabled before proposing any action.",
        "Do not execute or infer completed work from this index."
      ]
    };
  }
  const selected = input.query ? contacts : contacts.slice((page - 1) * limit, page * limit);
  const exactModelAdvisory = input.includeBrainAdvisory === true && Boolean(input.query) && selected.length === 1;
  const packets = [];
  for (const contact of selected) {
    packets.push(await buildChanceEvidencePacket(contact, {
      ...input,
      includeBrainAdvisory: exactModelAdvisory
    }));
  }
  const exactSubjectKey = input.query && packets.length === 1 ? packets[0].file.id : "";
  return {
    generatedAt: new Date().toISOString(),
    owner: companyScope
      ? { id: "", name: "Explicit company file" }
      : { id: CHANCE_OWNER_ID, name: "Chance Pearson" },
    scope: companyScope
      ? "explicit_company_file"
      : "chance_assigned_file",
    query: String(input.query || ""),
    page,
    limit,
    total,
    pageCount: Math.ceil(total / limit),
    complete: packets.every((packet) => packet.complete),
    packets,
    brain: operatorRequest ? operatorBrainBoundary() : reviewBrainContext(exactSubjectKey, input.maxPerSection),
    assistantDirective: [
      operatorRequest
        ? `These are fresh ${
          companyScope ? "company" : "Chance-assigned"
        } exact-file evidence packets with ephemeral continuity metadata; no Chance Brain client memory was read or written.`
        : ALLOW_LEGACY_CLIENT_MEMORY_WRITES
          ? "These are fresh evidence packets joined with durable client continuity, not automatic decisions."
          : "These are fresh evidence packets. Existing legacy continuity is read-only while HCN Operations Brain v2 is established.",
      "Compare current JobNimbus fields, activities, tasks, operational documents, Gmail, Quo, and prior action receipts.",
      operatorRequest
        ? "Use only the live evidence in this response; no client snapshot was refreshed."
        : ALLOW_LEGACY_CLIENT_MEMORY_WRITES
          ? "The snapshot has been refreshed by this review. Use it to remember prior context, but let live evidence win."
          : "No legacy client snapshot or advisory was written. Live evidence is authoritative.",
      "For each file, choose one primary next action, draft its exact content, and show Chance what requires approval.",
      "Do not treat memory or an old task as proof that work is still needed. Do not execute without approval."
    ]
  };
}

async function startThresherOperationalSession(input = {}) {
  const identity = await authWhoAmI();
  if (input.focus === "today_inspections") {
    return startTodaysInspectionReview(input, identity);
  }
  if (input.focus === "communications") {
    return startCommunicationRecoveryReview(input, identity);
  }
  const index = await reviewChanceFiles({
    indexOnly: true,
    activeOnly: true,
    maxPages: input.maxPages,
    maxPerSection: input.maxPerSection
  });
  const ranked = index.files
    .map((file) => ({ ...file, priority: operationalPriority(file) }))
    .sort((a, b) => b.priority.score - a.priority.score || fileSort(a, b));
  const selected = ranked[0];
  if (!selected) {
    return {
      identity,
      generatedAt: new Date().toISOString(),
      total: 0,
      selected: null,
      review: null,
      assistantDirective: [
        "No active Chance-assigned JobNimbus files were found.",
        "Do not invent an approval queue. Report the empty result."
      ]
    };
  }
  const query = String(selected.number || selected.id || selected.name || "").trim();
  const review = await reviewChanceFiles({
    query,
    limit: 1,
    activeOnly: true,
    includeGmail: true,
    includeQuo: true,
    includeQuoTranscripts: input.includeQuoTranscripts === true,
    communicationDays: input.communicationDays,
    gmailLimit: input.gmailLimit,
    gmailThreadLimit: input.gmailThreadLimit,
    quoLimit: input.quoLimit,
    includeBrainAdvisory: input.includeBrainAdvisory === true,
    maxPerSection: input.maxPerSection
  });
  return {
    identity,
    generatedAt: new Date().toISOString(),
    total: index.total,
    rankedCandidates: ranked.slice(0, 10),
    selected,
    review,
    assistantDirective: [
      "The bridge completed identity verification, stale-aware prioritization, and the exact-file deep review in one action.",
      "Begin with the employee name and Thresher Operational Session heading, then state verified role and scope.",
      "Analyze the selected file's fresh JobNimbus, Gmail, Quo, task, calendar, document, and memory evidence now.",
      "Give one primary next action and an exact approval queue. Do not stop with a promise to review later.",
      "Nothing in this response authorizes a write, send, call, task, event, upload, or status change."
    ]
  };
}

async function recoverSchedulingCommunications(input = {}) {
  const identity = await authWhoAmI();
  return startCommunicationRecoveryReview(input, identity);
}

async function startCommunicationRecoveryReview(input, identity) {
  const days = clamp(Number(input.communicationDays || 30), 1, 90);
  const contacts = (await listContacts({ maxPages: Number(input.maxPages || 25) }))
    .filter(isInsuranceFile)
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
    .filter(isOpenActive);
  const files = contacts.map(compactContact);
  const gmailQuery = `newer_than:${days}d {appointment inspection schedule scheduling reschedule adjuster reinspection appraiser appraisal arrival}`;
  const [gmailResult, quoResult] = await Promise.allSettled([
    loadGmailRecoveryItems(gmailQuery, clamp(Number(input.gmailLimit || 25), 1, 25)),
    readQuoInbox(quoConfig(), {
      days,
      maxResults: clamp(Number(input.quoLimit || 50), 1, 50),
      transcriptLimit: input.includeQuoTranscripts === false ? 0 : clamp(Number(input.quoTranscriptLimit || 12), 0, 25)
    })
  ]);
  const gmailItems = gmailResult.status === "fulfilled" ? gmailResult.value : [];
  const quoItems = quoResult.status === "fulfilled" ? quoResult.value.items : [];
  const recovery = buildCommunicationRecoveryQueue([...gmailItems, ...quoItems], files);

  return {
    identity,
    generatedAt: new Date().toISOString(),
    focus: "communications",
    days,
    activeFileCount: files.length,
    sources: {
      gmail: communicationSourceStatus(gmailResult, gmailItems.length),
      quo: communicationSourceStatus(quoResult, quoItems.length, quoResult.status === "fulfilled" ? quoResult.value : null)
    },
    recovery,
    assistantDirective: [
      "This is an inbox-first, read-only communication recovery sweep. It scanned Gmail scheduling mail and incoming calls/texts across every available Quo team line before matching them to active Chance files.",
      "Review appointment_scheduling and callback_required items first. Unknown numbers and unmatched messages must remain visible for manual identification; never silently discard them.",
      "A proposed match is evidence, not proof. Verify the exact file using claim number, insured, address, policy, or a fresh transcript before proposing a JobNimbus change.",
      "Report any source marked unavailable or partial. Do not claim the communication sweep is complete when Gmail or Quo failed.",
      "Nothing in this response authorizes a text, email, call, note, task, calendar event, upload, or status change."
    ]
  };
}

async function loadGmailRecoveryItems(query, limit) {
  const search = await gmailSearch({ query, limit });
  const threadIds = [...new Set(search.messages.map((message) => message.threadId).filter(Boolean))].slice(0, limit);
  const items = [];
  for (const threadId of threadIds) {
    const thread = await gmailThread({ threadId });
    for (const message of thread.messages) {
      if (!message.id || items.some((item) => item.id === message.id)) continue;
      const recovered = {
        id: message.id,
        threadId,
        channel: "gmail",
        type: "email",
        direction: gmailDirection(message),
        at: message.date || "",
        atUtc: gmailTimestamp(message),
        from: message.from || "",
        to: message.to || "",
        cc: message.cc || "",
        subject: message.subject || "",
        snippet: message.snippet || "",
        text: String(message.plainText || message.htmlText || message.snippet || "").slice(0, 12000),
        attachments: message.attachments || []
      };
      if (recovered.direction === "incoming") items.push(recovered);
    }
  }
  return items.sort((a, b) => String(b.atUtc).localeCompare(String(a.atUtc)));
}

function gmailDirection(message) {
  const from = String(message.from || "").toLowerCase();
  const identityEmail = String(currentRequestIdentity()?.email || CHANCE_GOOGLE_EMAIL).toLowerCase();
  return identityEmail && from.includes(identityEmail) ? "outgoing" : "incoming";
}

function gmailTimestamp(message) {
  const numeric = Number(message.internalDate || 0);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const parsed = Date.parse(String(message.date || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function communicationSourceStatus(result, count, detail = null) {
  return result.status === "fulfilled"
    ? detail?.partial
      ? { status: "partial", count, failureCount: detail.failures?.length || 0 }
      : { status: "fresh", count }
    : { status: "unavailable", count: 0, error: redactSensitiveText(result.reason?.message || "Unknown source error") };
}

async function startTodaysInspectionReview(input, identity) {
  const contacts = (await listContacts({ maxPages: Number(input.maxPages || 25) }))
    .filter(isInsuranceFile)
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
    .filter(isOpenActive);
  const taskRows = [];

  for (let offset = 0; offset < contacts.length; offset += 8) {
    const batch = contacts.slice(offset, offset + 8);
    const taskGroups = await Promise.all(batch.map(async (contact) => {
      const tasks = await listRelated("/tasks", contact.jnid, 60);
      return tasks.map((task) => ({ contact, task }));
    }));
    taskRows.push(...taskGroups.flat());
  }

  const matches = selectTodaysInspectionTasks(taskRows);
  const files = [];
  const seen = new Set();
  for (const match of matches) {
    const id = String(match.contact.jnid || match.contact.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const file = compactContact(match.contact);
    const review = await reviewChanceFiles({
      query: String(file.number || file.id || file.name),
      limit: 1,
      activeOnly: true,
      includeGmail: true,
      includeQuo: true,
      // The inspection router must stay small enough for a single GPT action.
      // Timeline metadata is sufficient for confirmation and access checks;
      // exact call transcripts can be pulled separately when needed.
      includeQuoTranscripts: false,
      communicationDays: input.communicationDays,
      gmailLimit: input.gmailLimit,
      gmailThreadLimit: input.gmailThreadLimit,
      quoLimit: input.quoLimit,
      includeBrainAdvisory: input.includeBrainAdvisory === true,
      maxPerSection: input.maxPerSection
    });
    const packet = Array.isArray(review.packets) ? review.packets[0] : null;
    files.push({
      file,
      inspectionTask: compactTask(match.task),
      review: packet ? compactClientCoordinatorEvidence(packet) : {
        complete: false,
        error: "The exact-file evidence packet was unavailable."
      }
    });
  }

  return {
    identity,
    generatedAt: new Date().toISOString(),
    focus: "today_inspections",
    localDate: localDateKey(new Date()),
    count: files.length,
    files,
    assistantDirective: files.length ? [
      "The bridge resolved today's inspections from active Chance-assigned JobNimbus inspection tasks before consulting calendar occupancy.",
      "Review every returned exact file using its fresh JobNimbus, Gmail, company-wide Quo, task, document, and client-memory evidence.",
      "State the exact appointment time, confirmation evidence, access/reschedule risk, remaining inspection scope, language needs, and what Chance should do before leaving.",
      "Calendar busy blocks are supporting conflict evidence only; never use them as the source of client identity.",
      "Do not execute any write, send, call, upload, task completion, or status change without exact approval."
    ] : [
      "No active Chance-assigned JobNimbus inspection task due today was found.",
      "Do not infer client identity from a merged calendar busy block.",
      "Report the empty task result, then ask for a homeowner name, address, or JobNimbus number only if the user believes an inspection is missing."
    ]
  };
}

function operationalPriority(file = {}) {
  const status = String(file.status || "").toLowerCase();
  const missing = file.missing || {};
  const rawUpdated = file.dateUpdated;
  const numericUpdated = Number(rawUpdated);
  const updated = Number.isFinite(numericUpdated) && numericUpdated > 0
    ? numericUpdated * (numericUpdated < 1e12 ? 1000 : 1)
    : Date.parse(String(rawUpdated || ""));
  const staleDays = Number.isFinite(updated)
    ? Math.max(0, Math.floor((Date.now() - updated) / 86400000))
    : 365;
  let score = Math.min(staleDays, 120);
  const reasons = [`${staleDays} day(s) since the recorded update`];

  if (status.includes("ready for pa review")) {
    score += 160;
    reasons.push("Ready for PA Review requires claim investigation or filing");
  } else if (status.includes("ready for appraisal")) {
    score += 150;
    reasons.push("Ready for Appraisal should not sit without submission");
  } else if (status.includes("submitted") && status.includes("confirmation")) {
    score += 130;
    reasons.push("Submitted file still needs the two key confirmations");
  } else if (status.includes("hot") || status.includes("final negotiation")) {
    score += 120;
    reasons.push("Hot final negotiation is settlement-priority work");
  } else if (status.includes("negotiat")) {
    score += 80;
    reasons.push("Active negotiation requires continued carrier progress");
  } else if (status.includes("submitted for appraisal")) {
    score += 70;
    reasons.push("Submitted appraisal requires milestone monitoring");
  }

  if (missing.claimNumber && status.includes("ready for pa review")) {
    score += 45;
    reasons.push("Claim number is missing");
  }
  if (missing.adjuster && status.includes("confirmation")) {
    score += 40;
    reasons.push("Adjuster confirmation is missing");
  }
  if (missing.policyNumber || missing.dateOfLoss) {
    score += 20;
    reasons.push("Core claim data is incomplete");
  }
  return { score, staleDays, reasons };
}

function compactChanceIndexContact(contact) {
  const file = compactContact(contact);
  return {
    id: file.id,
    number: file.number,
    name: file.name,
    status: file.status,
    dateUpdated: contact.date_updated || "",
    missing: {
      claimNumber: !file.claimNumber,
      policyNumber: !file.policyNumber,
      dateOfLoss: !file.dateOfLoss,
      adjuster: !file.adjusterName && !file.adjusterPhone && !file.adjusterEmail
    }
  };
}

async function buildChanceEvidencePacket(contact, input) {
  const operatorRequest = isCodexOperatorRequest();
  const file = compactContact(contact);
  const [activities, tasks, documents] = await Promise.all([
    listRelated("/activities", contact.jnid, operatorRequest ? 5000 : 60),
    listRelated("/tasks", contact.jnid, operatorRequest ? 5000 : 60),
    listRelated("/files", contact.jnid, operatorRequest ? 5000 : 1000)
  ]);
  const operationalDocuments = documents.filter(isOperationalDocumentMetadata);
  const sourceStatus = { jobNimbus: { status: "fresh", at: new Date().toISOString() } };

  let gmail = { status: "not_requested", query: "", messages: [], threads: [] };
  if (input.includeGmail !== false) {
    if (!googleAccessConfiguredForRequest()) {
      gmail = { status: "unavailable", error: "Gmail is not configured.", messages: [], threads: [] };
    } else {
      try {
        const query = buildFileGmailQuery(file, input.communicationDays);
        const communicationScope = { file };
        const search = await gmailSearch({
          query,
          limit: clamp(Number(input.gmailLimit || 8), 1, 15),
          [INTERNAL_COMMUNICATION_SCOPE]: communicationScope
        });
        const threads = [];
        for (const row of search.threads.slice(0, clamp(Number(input.gmailThreadLimit || 3), 1, 5))) {
          const thread = await gmailThread({
            threadId: row.threadId,
            [INTERNAL_COMMUNICATION_SCOPE]: communicationScope
          });
          threads.push(compactGmailEvidenceThread(thread));
        }
        gmail = { status: "fresh", query, messages: search.messages, threads };
      } catch (error) {
        gmail = { status: "error", error: redactSensitiveText(error.message), messages: [], threads: [] };
      }
    }
  }
  sourceStatus.gmail = { status: gmail.status, at: new Date().toISOString() };

  let quo = { status: "not_requested", timeline: [], transcripts: [] };
  if (input.includeQuo !== false) {
    if (!QUO_API_KEY) {
      quo = { status: "unavailable", error: "Quo is not configured.", timeline: [], transcripts: [] };
    } else if (!file.phone) {
      quo = { status: "no_file_phone", timeline: [], transcripts: [] };
    } else {
      try {
        if (operatorRequest) await assertUniqueChanceFilePhone(file, "Quo evidence review");
        const history = operatorRequest
          ? await readExactOperatorQuoHistory(file, {
              maxResults: clamp(Number(input.quoLimit || 25), 1, 50),
              includeTranscripts: input.includeQuoTranscripts === true
            })
          : await readQuoHistory(quoConfig(), {
              phone: file.phone,
              maxResults: clamp(Number(input.quoLimit || 25), 1, 50),
              includeTranscripts: input.includeQuoTranscripts === true
            });
        const historyComplete = !operatorRequest
          || history?.completeness?.complete === true;
        quo = {
          status: historyComplete ? "fresh" : "partial",
          ...history,
          timeline: history.timeline.slice(-30).reverse()
        };
      } catch (error) {
        quo = { status: "error", error: redactSensitiveText(error.message), timeline: [], transcripts: [] };
      }
    }
  }
  sourceStatus.quo = { status: quo.status, at: new Date().toISOString() };

  const sortedActivities = [...activities].sort(
    (a, b) => providerTimeMs(b.date_created) - providerTimeMs(a.date_created)
  );
  const openTasks = tasks
    .filter((task) => !providerFlagTrue(task.is_completed))
    .sort(
      (a, b) => providerTimeMs(a.date_start || a.date_end)
        - providerTimeMs(b.date_start || b.date_end)
    );
  const requestedSourcesComplete = [gmail.status, quo.status]
    .every((status) => !["unavailable", "error", "partial"].includes(status));
  const packet = {
    complete: requestedSourcesComplete,
    file,
    liveJobNimbus: {
      rawContact: contact,
      recentActivities: sortedActivities.slice(0, 30).map(compactActivity),
      openTasks: openTasks.slice(0, 30).map(compactTask),
      operationalDocuments: operationalDocuments.slice(0, 60).map(compactDocument),
      excludedPhotoLikeDocumentCount: documents.length - operationalDocuments.length,
      assistantRead: buildAssistantRead(contact, activities, tasks, operationalDocuments)
    },
    gmail,
    quo,
    actionReceipts: operatorRequest
      ? []
      : latestActionReceipts(MEMORY_CONFIG, 20, { subjectKey: file.id }),
    sourceStatus,
    factualSignals: buildFactualSignals(file, sortedActivities, openTasks, operationalDocuments, gmail, quo)
  };
  if (operatorRequest) {
    return {
      ...packet,
      clientMemory: operatorEphemeralContinuity(file, sourceStatus, {
        recentActivityCount: packet.liveJobNimbus.recentActivities.length,
        openTaskCount: packet.liveJobNimbus.openTasks.length,
        operationalDocumentCount: packet.liveJobNimbus.operationalDocuments.length,
        gmailMessageCount: Array.isArray(gmail.messages) ? gmail.messages.length : 0,
        gmailThreadCount: Array.isArray(gmail.threads) ? gmail.threads.length : 0,
        quoTimelineItemCount: Array.isArray(quo.timeline) ? quo.timeline.length : 0,
        quoTranscriptCount: Array.isArray(quo.transcripts) ? quo.transcripts.length : 0
      }),
      operational: operatorBrainBoundary(),
      operationalAdvisory: {
        status: "blocked_for_operator_privacy",
        authority: "The Codex operator cannot send client evidence to an advisory model."
      }
    };
  }
  const snapshot = ALLOW_LEGACY_CLIENT_MEMORY_WRITES
    ? refreshFileSnapshot(MEMORY_CONFIG, {
        subjectKey: file.id,
        file: packet.file,
        liveJobNimbus: packet.liveJobNimbus,
        gmail: packet.gmail,
        quo: packet.quo,
        actionReceipts: packet.actionReceipts,
        sourceStatus: packet.sourceStatus,
        factualSignals: packet.factualSignals
      })
    : readFileSnapshot(MEMORY_CONFIG, file.id, { quarantineCorrupt: false });
  const operational = ALLOW_LEGACY_CLIENT_MEMORY_WRITES
    ? reconcileOperationalState(MEMORY_CONFIG, snapshot)
    : operationalState(MEMORY_CONFIG, file.id, { quarantineCorrupt: false });
  let operationalAdvisory = {
    status: ALLOW_LEGACY_CLIENT_MEMORY_WRITES ? "not_requested" : "disabled_privacy_gate",
    reason: ALLOW_LEGACY_CLIENT_MEMORY_WRITES
      ? "Set includeBrainAdvisory:true on an exact-file review to request one bounded model advisory."
      : "Legacy client-memory and advisory writes are disabled while HCN Operations Brain v2 is being established."
  };
  if (input.includeBrainAdvisory === true && ALLOW_LEGACY_CLIENT_MEMORY_WRITES) {
    try {
      operationalAdvisory = await createOperationalAdvisory(MEMORY_CONFIG, snapshot, operational, {
        providers: operationalAdvisoryProviders()
      });
    } catch (error) {
      operationalAdvisory = {
        status: "error",
        error: redactSensitiveText(error.message || String(error)),
        authority: "The model advisory failed, but the deterministic evidence review and open-loop ledger remain valid. No action was executed."
      };
    }
  }
  return {
    ...packet,
    clientMemory: clientMemoryEnvelope(snapshot),
    operational,
    operationalAdvisory
  };
}

function legacyActionBatchRowSha256(row) {
  return digest({ version: 1, row });
}

function legacyIsolationRuntimeSafe() {
  return REQUIRE_CHANCE_RUN_POLICY
    && !ALLOW_GMAIL_SEND
    && !ALLOW_QUO_SEND
    && !ALLOW_VOICE_CALLS
    && !ALLOW_CLIENT_COORDINATOR_CALLS
    && !ALLOW_CARRIER_FOLLOWUP_CALLS
    && !HCN_ACTION_EXECUTION_ENABLED
    && !ALLOW_LEGACY_CLIENT_MEMORY_WRITES;
}

function isLegacyHistoricalIsolationCandidate(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (!/^[a-f0-9-]{36}$/.test(String(row.id || "").trim())) return false;
  if (
    Object.hasOwn(row, "schemaVersion")
    && (
      !Number.isSafeInteger(Number(row.schemaVersion))
      || Number(row.schemaVersion) > 1
    )
  ) return false;
  if (validActionBatchPrincipalHash(row.principalHash)) return false;
  if (String(row.runPolicyId || "").trim() || String(row.runPolicySha256 || "").trim()) return false;
  if (Array.isArray(row.files) ? row.files.length > 0 : Object.hasOwn(row, "files")) return false;
  if (Array.isArray(row.intents) ? row.intents.length > 0 : Object.hasOwn(row, "intents")) return false;
  if (row.current !== undefined && row.current !== null) return false;
  if (String(row.operatorScope || "").trim().toLowerCase() === "company") return false;
  const operationCount = Number(row.operationCount);
  const completed = Array.isArray(row.completed) ? row.completed : [];
  if (!Number.isSafeInteger(operationCount) || operationCount < 1 || operationCount > 15) return false;
  if (row.status === "partial_failure") return completed.length === 0;
  if (row.status !== "completed_pending_verification") return false;
  if (operationCount !== 1 || completed.length !== 1) return false;
  const item = completed[0];
  return Number(item?.index) === 0
    && String(item?.type || "").trim().length > 0
    && item?.receipt
    && typeof item.receipt === "object"
    && !Array.isArray(item.receipt)
    && item.receipt.manualVerificationRequired === true;
}

function resolveChanceLegacyHistoricalIsolation(ledger) {
  const config = CHANCE_OPERATOR_LEGACY_ISOLATION_STATE.config;
  const empty = (errorCode, error = CHANCE_OPERATOR_LEGACY_ISOLATION_STATE.error) => ({
    configured: Boolean(String(process.env.CHANCE_OPERATOR_LEGACY_ISOLATION_JSON || "").trim()),
    valid: false,
    id: config?.id || CHANCE_OPERATOR_LEGACY_ISOLATION_ID,
    isolatedIds: new Set(),
    entries: [],
    errorCode,
    error: String(error || "").slice(0, 300)
  });
  if (!config) return empty(
    CHANCE_OPERATOR_LEGACY_ISOLATION_STATE.error ? "configuration_invalid" : "not_configured"
  );
  if (
    !CHANCE_OPERATOR_RUN_MANIFEST
    || config.runPolicyId !== CHANCE_OPERATOR_RUN_MANIFEST.id
    || config.runPolicySha256 !== CHANCE_OPERATOR_RUN_MANIFEST.sha256
  ) return empty("run_policy_mismatch", "Legacy isolation does not match the active run policy.");
  if (!legacyIsolationRuntimeSafe()) {
    return empty("runtime_not_safe", "Unapproved sends, unrelated call lanes, browser-action execution, and legacy-memory writes must remain disabled.");
  }
  const candidates = (Array.isArray(ledger) ? ledger : [])
    .filter(isLegacyHistoricalIsolationCandidate);
  const candidateIds = candidates.map((row) => String(row.id));
  const configuredIds = config.entries.map((entry) => entry.batchId);
  if (
    candidates.length !== config.entries.length
    || new Set(candidateIds).size !== candidateIds.length
    || configuredIds.some((id) => !candidateIds.includes(id))
    || candidateIds.some((id) => !configuredIds.includes(id))
  ) return empty("candidate_set_mismatch", "The exact set of legacy receipt candidates changed.");
  const entries = [];
  for (const expected of config.entries) {
    const matches = candidates.filter((row) => String(row.id) === expected.batchId);
    if (matches.length !== 1) return empty("candidate_identity_mismatch", "A legacy receipt is missing or duplicated.");
    const row = matches[0];
    const completedCount = Array.isArray(row.completed) ? row.completed.length : 0;
    if (
      String(row.status || "") !== expected.expectedStatus
      || Number(row.operationCount) !== expected.operationCount
      || completedCount !== expected.completedCount
      || legacyActionBatchRowSha256(row) !== expected.rawRowSha256
    ) return empty("fingerprint_mismatch", "A legacy receipt no longer matches its exact approved fingerprint.");
    const completed = row.status === "completed_pending_verification"
      ? row.completed[0]
      : null;
    const receiptFileId = String(completed?.receipt?.fileId || "").trim();
    const receiptFileNumber = String(completed?.receipt?.fileNumber || "").trim().replace(/^#/, "");
    const manifestBoundFile = Boolean(
      receiptFileId
      && receiptFileNumber
      && chanceManifestFileBinding(
        CHANCE_OPERATOR_RUN_MANIFEST,
        receiptFileNumber,
        receiptFileId
      )
    );
    entries.push({
      batchId: expected.batchId,
      rawRowSha256: expected.rawRowSha256,
      status: expected.expectedStatus,
      operationCount: expected.operationCount,
      completedCount: expected.completedCount,
      fileNumber: manifestBoundFile ? receiptFileNumber : "",
      operationType: String(completed?.type || "").trim(),
      priorOutcome: expected.expectedStatus === "partial_failure"
        ? "unknown_provider_outcome"
        : "completed_delivery_unverified"
    });
  }
  return {
    configured: true,
    valid: true,
    id: config.id,
    isolatedIds: new Set(entries.map((entry) => entry.batchId)),
    entries,
    errorCode: "",
    error: ""
  };
}

async function operatorRunPolicy() {
  if (!isMacCodexOperatorRequest()) {
    const error = new Error("The locked Chance run-policy attestation is available only to the dedicated Mac operator.");
    error.statusCode = 403;
    throw error;
  }
  const policy = chanceOperatorRunManifestSummary(CHANCE_OPERATOR_RUN_MANIFEST);
  const ledger = await readActionBatchLedger();
  const legacyIsolation = resolveChanceLegacyHistoricalIsolation(ledger);
  const principalHash = actionApprovalIdentityHash();
  const attentionStatuses = new Set([
    "in_progress",
    "partial_failure",
    "reconciliation_required",
    "legacy_quarantined",
    "manual_quarantined",
    "completed_pending_verification"
  ]);
  const manifestFileIds = new Set(
    (CHANCE_OPERATOR_RUN_MANIFEST?.files || [])
      .map((file) => String(file.fileId || ""))
      .filter(Boolean)
  );
  const isAttentionRow = (row) => (
    attentionStatuses.has(String(row.status || ""))
    || Boolean(row.current)
  );
  const own = ledger.filter((row) => row.principalHash === principalHash);
  const unownedAttention = ledger.filter((row) => (
    !validActionBatchPrincipalHash(row.principalHash)
    && isAttentionRow(row)
  ));
  const foreignAttention = ledger.filter((row) => {
    if (
      row.principalHash === principalHash
      || !validActionBatchPrincipalHash(row.principalHash)
      || !isAttentionRow(row)
    ) return false;
    const lockScope = actionBatchResourceLockScope(row);
    return lockScope.global
      || lockScope.files.some((file) => manifestFileIds.has(file.id));
  });
  const visible = [
    ...own,
    ...unownedAttention.filter((row) => !own.includes(row)),
    ...foreignAttention.filter(
      (row) => !own.includes(row) && !unownedAttention.includes(row)
    )
  ];
  const attention = visible.filter(isAttentionRow);
  const historicalAttention = attention.filter((row) => (
    legacyIsolation.isolatedIds.has(String(row.id || ""))
  ));
  const unresolved = attention.filter((row) => {
    if (legacyIsolation.isolatedIds.has(String(row.id || ""))) return false;
    if (!validActionBatchPrincipalHash(row.principalHash)) return true;
    if (row.principalHash !== principalHash) {
      return actionBatchResourceLockScope(row).global;
    }
    return ["in_progress", "reconciliation_required"]
      .includes(String(row.status || ""))
      || (
        row.status === "legacy_quarantined"
        && row.recovery?.fileScopedQuarantine !== true
      )
      || (
        row.status === "manual_quarantined"
        && row.recovery?.fileScopedQuarantine !== true
      )
      || (
        row.status === "completed_pending_verification"
        && validatedQuarantineFileScope(row).length === 0
      )
      || Boolean(row.current);
  });
  const reconciliationEligible = unresolved.filter((row) => (
    row.principalHash === principalHash
    &&
    row.current?.status === "reconciliation_required"
  ));
  const reconciliationEligibleIds = new Set(reconciliationEligible.map((row) => row.id));
  const hardBlocked = unresolved.filter((row) => !reconciliationEligibleIds.has(row.id));
  return {
    mode: "read_only",
    bridgeBootId: BRIDGE_BOOT_ID,
    recoveryBoundary: { ...ACTION_RECEIPT_RECOVERY_STATE },
    runPolicy: {
      ...policy,
      loadError: policy.available ? "" : CHANCE_OPERATOR_RUN_MANIFEST_STATE.error
    },
    receipts: {
      total: visible.length,
      unresolvedCount: unresolved.length,
      unresolvedBatchIds: unresolved.map((row) => row.id),
      reconciliationEligibleCount: reconciliationEligible.length,
      reconciliationEligibleBatchIds: reconciliationEligible.map((row) => row.id),
      hardBlockedCount: hardBlocked.length,
      hardBlockedBatchIds: hardBlocked.map((row) => row.id),
      hardBlockedSummaries: hardBlocked
        .slice(0, 50)
        .map((row) => minimizedHardBlockedRunReceipt(row, principalHash)),
      attentionCount: attention.length,
      attentionBatchIds: attention.map((row) => row.id),
      historicalAttentionCount: historicalAttention.length,
      historicalAttentionBatchIds: historicalAttention.map((row) => row.id),
      historicalAttentionSummaries: historicalAttention
        .slice(0, 50)
        .map((row) => minimizedHardBlockedRunReceipt(row, principalHash))
    },
    legacyIsolation: {
      configured: legacyIsolation.configured,
      valid: legacyIsolation.valid,
      id: legacyIsolation.id,
      runPolicyId: CHANCE_OPERATOR_LEGACY_ISOLATION_STATE.config?.runPolicyId || "",
      runPolicySha256: CHANCE_OPERATOR_LEGACY_ISOLATION_STATE.config?.runPolicySha256 || "",
      entryCount: legacyIsolation.entries.length,
      errorCode: legacyIsolation.errorCode,
      error: legacyIsolation.error,
      classification: legacyIsolation.valid
        ? "legacy_historical_attention_nonblocking"
        : "inactive_fail_closed",
      reasonCode: legacyIsolation.valid
        ? "pre_scope_receipt_unrecoverable_manual_risk_acceptance"
        : "",
      neverReplay: true,
      freshReadRequired: true
    },
    ready: policy.available
      && ACTION_RECEIPT_RECOVERY_STATE.status === "ready"
      && (!legacyIsolation.configured || legacyIsolation.valid)
      && unresolved.length === 0,
    instruction: "Verify this manifest ID/hash/count/expiry against the local plugin before any action plan. Reconcile every unresolved batch before retrying its actions. Historical-isolation receipts remain unknown, visible, non-replayable audit attention and require a fresh provider read before every new action."
  };
}

function minimizedHardBlockedRunReceipt(row, principalHash) {
  const files = validatedActionBatchFileScope(row);
  const manifestMatches = CHANCE_OPERATOR_RUN_MANIFEST
    ? files.filter((file) => chanceManifestFileBinding(
        CHANCE_OPERATOR_RUN_MANIFEST,
        file.number,
        file.id
      ))
    : [];
  const scope = !files.length || (
    manifestMatches.length > 0
    && manifestMatches.length !== files.length
  )
    ? "global"
    : manifestMatches.length === files.length
      ? "manifest_files"
      : "outside_manifest_files";
  const knownTypes = new Set([
    ...ACTION_OPERATION_TYPES,
    ...HCN_BROWSER_ACTION_TYPES
  ]);
  const safeToken = (value) => {
    const token = String(value || "").trim();
    return /^[a-z0-9_]{1,80}$/i.test(token) ? token : "";
  };
  const safeTimestamp = (value) => {
    const timestamp = String(value || "").trim();
    return Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : "";
  };
  const runPolicyId = String(row?.runPolicyId || "").trim();
  const runPolicySha256 = String(row?.runPolicySha256 || "").trim().toLowerCase();
  const principalBound = validActionBatchPrincipalHash(row?.principalHash);
  const minimizedOperation = (entry = {}) => {
    const receipt = entry?.receipt && typeof entry.receipt === "object"
      ? entry.receipt
      : {};
    const type = String(entry?.type || "").trim();
    const fileNumber = String(entry?.fileNumber || receipt?.fileNumber || "")
      .trim()
      .replace(/^#/, "");
    const index = Number(entry?.index);
    return {
      index: Number.isSafeInteger(index) && index >= 0 && index < 15 ? index : -1,
      type: knownTypes.has(type) ? type : "",
      status: safeToken(entry?.status),
      fileNumber: /^\d{1,12}$/.test(fileNumber) ? fileNumber : "",
      receipt: {
        mode: safeToken(receipt?.mode),
        verifiedByReadback: typeof receipt?.verifiedByReadback === "boolean"
          ? receipt.verifiedByReadback
          : null,
        deliveryStatus: safeToken(receipt?.deliveryStatus),
        deliveryConfirmed: typeof receipt?.deliveryConfirmed === "boolean"
          ? receipt.deliveryConfirmed
          : null,
        manualVerificationRequired: typeof receipt?.manualVerificationRequired === "boolean"
          ? receipt.manualVerificationRequired
          : null
      }
    };
  };
  return {
    batchId: /^[a-zA-Z0-9_-]{8,100}$/.test(String(row?.id || ""))
      ? String(row.id)
      : "",
    rawRowSha256: legacyActionBatchRowSha256(row),
    status: safeToken(row?.status) || "unknown",
    principalBound,
    principalMatchesCurrent: principalBound
      && String(row.principalHash) === String(principalHash),
    createdAt: safeTimestamp(row?.createdAt),
    updatedAt: safeTimestamp(row?.updatedAt),
    operationCount: Number.isSafeInteger(Number(row?.operationCount))
      ? Number(row.operationCount)
      : 0,
    batchMode: safeToken(row?.batchMode),
    completedCount: Array.isArray(row?.completed)
      ? Math.min(row.completed.length, 15)
      : 0,
    completed: (Array.isArray(row?.completed) ? row.completed : [])
      .slice(0, 15)
      .map(minimizedOperation),
    failedAt: row?.failedAt && typeof row.failedAt === "object"
      ? minimizedOperation(row.failedAt)
      : null,
    notAttempted: (Array.isArray(row?.notAttempted) ? row.notAttempted : [])
      .slice(0, 15)
      .map(minimizedOperation),
    currentPresent: Boolean(row?.current),
    files: files.slice(0, 5).map((file) => {
      const source = (Array.isArray(row?.files) ? row.files : []).find((item) => (
        String(item?.id || "").trim() === file.id
        && String(item?.number || "").trim().replace(/^#/, "") === file.number
      ));
      return {
        number: file.number,
        operationTypes: [...new Set(
          (Array.isArray(source?.operationTypes) ? source.operationTypes : [])
            .map((type) => String(type || "").trim())
            .filter((type) => knownTypes.has(type))
        )].slice(0, 15)
      };
    }),
    runPolicy: {
      present: Boolean(runPolicyId || runPolicySha256),
      matchesCurrent: Boolean(
        CHANCE_OPERATOR_RUN_MANIFEST
        && runPolicyId === CHANCE_OPERATOR_RUN_MANIFEST.id
        && runPolicySha256 === CHANCE_OPERATOR_RUN_MANIFEST.sha256
      )
    },
    recovery: {
      phase: safeToken(row?.recovery?.phase),
      reasonCode: safeToken(row?.recovery?.reasonCode),
      fileScopedQuarantine: row?.recovery?.fileScopedQuarantine === true
    },
    scope
  };
}

function minimizedActionBatchReceipt(row, options = {}) {
  const detail = options.detail === true;
  const files = (Array.isArray(row.files) ? row.files : []).map((file) => ({
    number: String(file.number || ""),
    operationIndexes: Array.isArray(file.operationIndexes) ? file.operationIndexes : [],
    operationTypes: Array.isArray(file.operationTypes) ? file.operationTypes : []
  }));
  const completed = Array.isArray(row.completed) ? row.completed : [];
  const base = {
    batchId: row.id,
    status: row.status,
    batchMode: row.batchMode || "",
    operatorScope: row.operatorScope || "assigned",
    runPolicyId: row.runPolicyId || "",
    runPolicySha256: row.runPolicySha256 || "",
    approvalDigest: row.approvalDigest || "",
    operationCount: Number(row.operationCount || 0),
    fileCount: Number(row.fileCount || files.length),
    files,
    completedCount: completed.length,
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || "",
    completedAt: row.completedAt || ""
  };
  if (!detail) return base;
  return {
    ...base,
    intents: (Array.isArray(row.intents) ? row.intents : []).map((intent) => ({
      index: intent.index,
      type: intent.type,
      fileNumber: intent.fileNumber || "",
      intentDigest: intent.intentDigest || ""
    })),
    completed: completed.map((item) => ({
      index: item.index,
      type: item.type,
      status: item.status,
      receipt: cleanObject({
        mode: item.receipt?.mode || "",
        fileNumber: item.receipt?.fileNumber || "",
        externalId: item.receipt?.externalId || "",
        sourceDraftId: item.receipt?.sourceDraftId || "",
        sourceDraftRetention: item.receipt?.sourceDraftRetention || "",
        verifiedByReadback: item.receipt?.verifiedByReadback,
        deliveryStatus: item.receipt?.deliveryStatus || "",
        deliveryConfirmed: item.receipt?.deliveryConfirmed,
        manualVerificationRequired: item.receipt?.manualVerificationRequired
      })
    })),
    current: row.current ? {
      index: row.current.index,
      type: row.current.type,
      fileNumber: row.current.fileNumber || "",
      status: row.current.status || "",
      reason: redactSensitiveText(String(row.current.reason || "")).slice(0, 500)
    } : null,
    failedAt: row.failedAt,
    notAttempted: (Array.isArray(row.notAttempted) ? row.notAttempted : []).map((item) => ({
      index: item.index,
      type: item.type,
      fileNumber: item.fileNumber || "",
      status: item.status || "not_attempted"
    })),
    error: redactSensitiveText(String(row.error || "")).slice(0, 500),
    manualQuarantine: row.manualQuarantine ? {
      index: row.manualQuarantine.index,
      type: row.manualQuarantine.type,
      fileNumber: row.manualQuarantine.fileNumber || "",
      fileNumbers: Array.isArray(row.manualQuarantine.fileNumbers)
        ? row.manualQuarantine.fileNumbers.map(String)
        : [],
      scope: row.manualQuarantine.scope || "",
      reasonCode: row.manualQuarantine.reasonCode || "",
      reason: redactSensitiveText(String(row.manualQuarantine.reason || "")).slice(0, 500),
      quarantinedAt: row.manualQuarantine.quarantinedAt || ""
    } : null,
    automaticRetryAllowed: false,
    freshApprovalRequired: !["completed", "completed_pending_verification", "manual_quarantined"].includes(String(row.status || ""))
  };
}

async function actionBatchReceipts(input = {}) {
  if (!isMacCodexOperatorRequest() || operatorCompanyScopeActive()) {
    const error = new Error("Assigned operator action-batch receipts are available only to the dedicated Mac assigned-file lane.");
    error.statusCode = 403;
    throw error;
  }
  const batchId = String(input.batchId || "").trim();
  const fileNumber = String(input.fileNumber || "").trim().replace(/^#/, "");
  if (fileNumber && !/^\d+$/.test(fileNumber)) badRequest("fileNumber must be an exact numeric JobNimbus number.");
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.map((status) => String(status || "").trim()).filter(Boolean)
    : [];
  const limit = clamp(Number(input.limit || 25), 1, 50);
  const principalHash = actionApprovalIdentityHash();
  const own = (await readActionBatchLedger()).filter((row) => (
    row.principalHash === principalHash
    && row.operatorScope !== "company"
  ));
  if (batchId) {
    const row = own.find((item) => item.id === batchId);
    if (!row) {
      const error = new Error("No action-batch receipt was found.");
      error.statusCode = 404;
      throw error;
    }
    return {
      mode: "receipt_detail",
      generatedAt: new Date().toISOString(),
      recoveryBoundary: { ...ACTION_RECEIPT_RECOVERY_STATE },
      receipt: minimizedActionBatchReceipt(row, { detail: true })
    };
  }
  const rows = own
    .filter((row) => !fileNumber || (row.files || []).some((file) => String(file.number || "").replace(/^#/, "") === fileNumber))
    .filter((row) => !statuses.length || statuses.includes(String(row.status || "")))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
    .slice(0, limit);
  return {
    mode: "receipt_list",
    generatedAt: new Date().toISOString(),
    recoveryBoundary: { ...ACTION_RECEIPT_RECOVERY_STATE },
    count: rows.length,
    receipts: rows.map((row) => minimizedActionBatchReceipt(row))
  };
}

async function actionBatchReconcile(input = {}) {
  if (!isMacCodexOperatorRequest() || operatorCompanyScopeActive()) {
    const error = new Error("Assigned operator reconciliation is available only to the dedicated Mac assigned-file lane.");
    error.statusCode = 403;
    throw error;
  }
  assertOperatorReceiptBoundaryReady();
  const batchId = required(input.batchId, "batchId");
  return withActionBatchMutation(async () => {
    const ledger = await readActionBatchLedger();
    const principalHash = actionApprovalIdentityHash();
    const row = ledger.find((item) => (
      item.id === batchId
      && item.principalHash === principalHash
      && item.operatorScope !== "company"
    ));
    if (!row) {
      const error = new Error("No action-batch receipt was found.");
      error.statusCode = 404;
      throw error;
    }
    if (!row.current || row.current.status !== "reconciliation_required") {
      return {
        mode: "verified_noop",
        receipt: minimizedActionBatchReceipt(row, { detail: true }),
        instruction: "This batch has no provider-uncertain current operation. Review its completed and not-attempted indexes before preparing any fresh work."
      };
    }
    const index = Number(row.current.index);
    const currentDescriptor = {
      index,
      type: String(row.current.type || ""),
      fileId: String(row.current.fileId || ""),
      fileNumber: String(row.current.fileNumber || "")
    };
    const batchDescriptors = actionBatchOperationDescriptors(row);
    const expectedDescriptor = batchDescriptors?.[index] || null;
    const validatedBatchFiles = validatedQuarantineFileScope(row);
    const currentDescriptorBound = Boolean(
      expectedDescriptor
      && expectedDescriptor.type === currentDescriptor.type
      && expectedDescriptor.fileId === currentDescriptor.fileId
      && expectedDescriptor.fileNumber === currentDescriptor.fileNumber
      && validatedBatchFiles.some((file) => (
        file.id === expectedDescriptor.fileId
        && file.number === expectedDescriptor.fileNumber
      ))
    );
    const descriptor = currentDescriptorBound ? expectedDescriptor : currentDescriptor;
    const quarantineFiles = currentDescriptorBound
      ? [{ id: expectedDescriptor.fileId, number: expectedDescriptor.fileNumber }]
      : validatedBatchFiles;
    const quarantineCurrent = async (error, reasonCode = "provider_state_unprovable") => {
      const quarantinedAt = new Date().toISOString();
      const fileIds = [...new Set(quarantineFiles.map((file) => String(file.id || "")).filter(Boolean))];
      const fileNumbers = [...new Set(quarantineFiles.map((file) => String(file.number || "")).filter(Boolean))];
      row.status = "manual_quarantined";
      row.failedAt = index;
      row.manualQuarantine = {
        index,
        type: currentDescriptorBound ? descriptor.type : "unknown",
        fileId: currentDescriptorBound ? descriptor.fileId : "",
        fileNumber: currentDescriptorBound ? descriptor.fileNumber : "",
        fileIds,
        fileNumbers,
        scope: fileIds.length === 0 ? "global" : fileIds.length === 1 ? "file" : "files",
        reasonCode,
        reason: redactSensitiveText(error?.message || String(error)),
        quarantinedAt
      };
      row.recovery = {
        ...(row.recovery || {}),
        resolvedAt: quarantinedAt,
        resolvedOutcome: "unknown_file_quarantined",
        fileScopedQuarantine: fileIds.length > 0,
        automaticRetryAllowed: false,
        freshApprovalRequired: false
      };
      row.updatedAt = quarantinedAt;
      delete row.current;
      const ledgerIndex = ledger.findIndex((item) => item.id === row.id);
      ledger[ledgerIndex] = row;
      await writeActionBatchLedger(ledger);
      return {
        mode: "manual_quarantined",
        outcome: "unknown_file_quarantined",
        receipt: minimizedActionBatchReceipt(row, { detail: true }),
        instruction: fileIds.length
          ? `${fileIds.length === 1 ? "The exact affected file is" : "The affected files are"} quarantined from further actions, while unrelated files may continue. Never retry the uncertain action.`
          : "The affected file scope cannot be proven, so all locked-run actions remain blocked pending manual ledger recovery. Never retry the uncertain action."
      };
    };
    const intent = currentDescriptorBound
      ? validActionBatchIntent(row, descriptor)
      : null;
    if (!intent) {
      return quarantineCurrent(
        new Error("The interrupted batch does not contain a complete immutable operation intent."),
        "immutable_intent_invalid"
      );
    }
    let applied = false;
    let externalId = "";
    try {
      if (intent.type === "jobnimbus.update_contact" || intent.type === "jobnimbus.update_status") {
        const contact = await jobNimbus(`/contacts/${encodeURIComponent(intent.fileId)}`);
        const after = intent.reconciliation?.after || {};
        applied = recordMatchesFields(contact, after);
        externalId = String(contact.jnid || contact.id || "");
      } else if (intent.type === "jobnimbus.ensure_current_task") {
        const tasks = await listCompleteRelatedTasks(intent.fileId);
        const markers = tasks.filter(taskContainsCurrentControlMarker);
        const expected = intent.reconciliation?.after || {};
        const matched = markers.filter((task) => (
          taskIsOpenActive(task)
          && taskOwnedByChance(task)
          && recordMatchesFields(task, expected)
        ));
        if (markers.length > 1) {
          conflictError("More than one current-control task marker exists. Reconcile the duplicate tasks manually before retrying.");
        }
        applied = matched.length === 1;
        externalId = matched.length === 1 ? taskRecordId(matched[0]) : "";
      } else if (intent.type === "gmail.create_draft") {
        const draftReconciliation = await reconcileGmailDraftIntent(intent);
        applied = draftReconciliation.applied;
        externalId = draftReconciliation.externalId;
      } else if (intent.type === "gmail.send_existing_draft") {
        const sendReconciliation = await reconcileGmailSendIntent(intent);
        applied = sendReconciliation.applied;
        externalId = sendReconciliation.externalId;
      } else {
        conflictError("This interrupted operation requires channel-specific reconciliation and cannot be automatically retried or closed.");
      }
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (![400, 403, 404, 409].includes(statusCode)) throw error;
      return quarantineCurrent(error);
    }

    const reconciledAt = new Date().toISOString();
    if (applied) {
      row.completed = (Array.isArray(row.completed) ? row.completed : []).filter((item) => Number(item.index) !== index);
      row.completed.push({
        index,
        type: intent.type,
        status: "executed",
          receipt: {
            mode: "recovered_verified",
            fileId: intent.fileId,
            fileNumber: intent.fileNumber,
            externalId,
            verifiedByReadback: true,
            ...(intent.type === "gmail.send_existing_draft" ? {
              sourceDraftId: String(intent.reconciliation?.draftId || ""),
              sourceDraftRetention: "retained_for_separate_cleanup"
            } : {})
          }
      });
      row.completed.sort((left, right) => Number(left.index) - Number(right.index));
    } else {
      row.failedAt = index;
      row.verifiedNotApplied = {
        index,
        type: intent.type,
        fileId: intent.fileId,
        fileNumber: intent.fileNumber,
        verifiedAt: reconciledAt
      };
    }
    delete row.current;
    row.status = (row.notAttempted || []).length || !applied
      ? "partial_failure"
      : actionBatchTerminalStatus(row.completed || []);
    row.recovery = {
      ...(row.recovery || {}),
      resolvedAt: reconciledAt,
      resolvedOutcome: applied ? "applied_verified" : "not_applied_verified",
      automaticRetryAllowed: false,
      freshApprovalRequired: row.status === "partial_failure"
    };
    row.updatedAt = reconciledAt;
    const ledgerIndex = ledger.findIndex((item) => item.id === row.id);
    ledger[ledgerIndex] = row;
    await writeActionBatchLedger(ledger);
    return {
      mode: "reconciled",
      outcome: applied ? "applied_verified" : "not_applied_verified",
      receipt: minimizedActionBatchReceipt(row, { detail: true }),
      instruction: applied
        ? "The provider state matches the approved intent. Never retry this operation."
        : "The provider state does not match the approved intent. Any still-needed action requires a fresh exact-file review, dry run, and approval."
    };
  });
}

async function processActionBatch(input = {}) {
  assertOperatorReceiptBoundaryReady();
  const runPolicy = actionBatchRunPolicy(input);
  const preparedBatch = await prepareCanonicalActionBatch(input.operations, { runPolicy });
  const { operations, plans, approvalDigest, batchScope } = preparedBatch;
  await assertNoUnresolvedBatchOverlap(batchScope);
  if (input.execute !== true) {
    const approval = await issueActionApprovalChallenge(
      approvalDigest,
      operations.length,
      batchScope
    );
    return {
      mode: "dry_run",
      batchMode: batchScope.mode,
      fileCount: batchScope.fileCount,
      operationCount: operations.length,
      files: batchScope.files,
      runPolicy: stableRunPolicy(runPolicy),
      operations: plans,
      displayComplete: true,
      executionSemantics: "sequential_fail_stop_no_rollback",
      approvalDigest,
      approvalChallenge: approval.challenge,
      approvalExpiresAt: approval.expiresAt,
      instruction: "Nothing was executed. Show Chance every exact action. After approval, repeat unchanged before expiry with execute:true, this approvalDigest, and the single-use approval challenge."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true before executing an approved batch.");
  requireApprovalDigest(input.approvalDigest, approvalDigest, "action batch");
  const approval = await consumeActionApprovalChallenge(
    input.approvalChallenge,
    approvalDigest,
    "action_batch",
    batchScope
  );

  const reservation = await reserveActionBatch(
    approval.id,
    approvalDigest,
    operations.length,
    batchScope,
    operations,
    plans
  );
  if (reservation.existing) {
    return {
      mode: "blocked_duplicate",
      reason: `This exact approved batch is already ${reservation.existing.status}. Review its receipt before attempting anything again.`,
      batch: reservation.existing
    };
  }
  const batch = reservation.batch;

  for (let index = 0; index < operations.length; index += 1) {
    const file = batchScope.operationFiles[index];
    batch.current = {
      index,
      type: operations[index].type,
      fileId: file.id,
      fileNumber: file.number,
      status: "executing",
      startedAt: new Date().toISOString()
    };
    batch.updatedAt = new Date().toISOString();
    await updateActionBatch(batch);
    const operationCurrent = { ...batch.current };
    let verifiedReceipt = null;
    try {
      const result = await executeActionOperation(operations[index], plans[index]);
      verifiedReceipt = summarizeOperationResult(result);
      batch.completed.push({ index, type: operations[index].type, status: "executed", receipt: verifiedReceipt });
      delete batch.current;
      await updateActionBatch(batch);
    } catch (error) {
      batch.completed = batch.completed.filter((item) => item.index !== index);
      batch.status = "partial_failure";
      batch.failedAt = index;
      batch.current = {
        ...operationCurrent,
        status: "reconciliation_required",
        reason: verifiedReceipt
          ? "The provider write and readback succeeded, but the durable completion receipt could not be saved. Reconcile the exact file and ledger before any retry."
          : "The provider outcome may be uncertain. Fresh-read this exact file before any retry.",
        ...(verifiedReceipt ? { verifiedReceipt } : {})
      };
      batch.notAttempted = operations.slice(index + 1).map((operation, offset) => {
        const laterIndex = index + offset + 1;
        const laterFile = batchScope.operationFiles[laterIndex];
        return {
          index: laterIndex,
          type: operation.type,
          fileId: laterFile.id,
          fileNumber: laterFile.number,
          status: "not_attempted"
        };
      });
      batch.error = redactSensitiveText(error.message || String(error));
      batch.updatedAt = new Date().toISOString();
      await updateActionBatch(batch);
      return {
        mode: "partial_failure",
        batch,
        reason: "Execution stopped immediately. Fresh-read the failed file, preserve completed receipts, and do not retry failed or unattempted actions without a new review and approval."
      };
    }
  }
  batch.status = actionBatchTerminalStatus(batch.completed);
  batch.notAttempted = [];
  batch.completedAt = new Date().toISOString();
  await updateActionBatch(batch);
  return { mode: "executed", batch };
}

async function assertNoUnresolvedBatchOverlap(batchScope) {
  const ledger = await readActionBatchLedger();
  const legacyIsolation = resolveChanceLegacyHistoricalIsolation(ledger);
  const allowLegacyIsolation = legacyIsolationAppliesToBatch(batchScope);
  if (allowLegacyIsolation && legacyIsolation.configured && !legacyIsolation.valid) {
    conflictError("The exact historical receipt isolation no longer attests. No action may be planned until its six fingerprints, runtime gates, and run policy match again.");
  }
  const blocking = findUnresolvedBatchOverlap(ledger, batchScope, { allowLegacyIsolation });
  if (!blocking) return;
  throwUnresolvedBatchOverlap(blocking);
}

function legacyIsolationAppliesToBatch(batchScope) {
  return isMacCodexOperatorRequest()
    && !operatorCompanyScopeActive()
    && String(batchScope?.runPolicyId || "") === String(CHANCE_OPERATOR_RUN_MANIFEST?.id || "")
    && String(batchScope?.runPolicySha256 || "") === String(CHANCE_OPERATOR_RUN_MANIFEST?.sha256 || "")
    && Number(batchScope?.fileCount || 0) >= 1;
}

function findUnresolvedBatchOverlap(ledger, batchScope, options = {}) {
  const desiredFileIds = new Set((batchScope?.files || []).map((file) => String(file.id || "")));
  const legacyIsolation = resolveChanceLegacyHistoricalIsolation(ledger);
  return ledger.find((row) => {
    if (
      options.allowLegacyIsolation === true
      && legacyIsolation.isolatedIds.has(String(row?.id || ""))
    ) return false;
    const status = String(row.status || "");
    const blocks = [
      "in_progress",
      "reconciliation_required",
      "legacy_quarantined",
      "manual_quarantined",
      "completed_pending_verification"
    ].includes(status)
      || (
        status === "partial_failure"
        && !validActionBatchPrincipalHash(row.principalHash)
      )
      || Boolean(row.current);
    if (!blocks) return false;
    if (!validActionBatchPrincipalHash(row.principalHash)) return true;
    const lockScope = actionBatchResourceLockScope(row);
    return lockScope.global
      || desiredFileIds.size === 0
      || lockScope.files.some((file) => desiredFileIds.has(file.id));
  });
}

function throwUnresolvedBatchOverlap(blocking) {
  const error = new Error(
    `Action batch ${blocking.id} still requires receipt reconciliation for one of these exact files. Review that receipt before preparing overlapping work.`
  );
  error.statusCode = 409;
  throw error;
}

async function prepareCanonicalActionBatch(operationsInput, options = {}) {
  const operations = normalizeActionOperations(operationsInput);
  const runPolicy = options.runPolicy || null;
  if (runPolicy?.enforced) {
    const singleOperationGmailTypes = new Set([
      "gmail.create_draft",
      "gmail.send_existing_draft"
    ]);
    if (
      operations.some((operation) => singleOperationGmailTypes.has(operation.type))
      && (operations.length !== 1 || !singleOperationGmailTypes.has(operations[0].type))
    ) {
      badRequest("A locked-run Gmail draft must be the only operation in its action batch; an existing-draft send follows the same sole-operation rule.");
    }
    for (const [index, operation] of operations.entries()) {
      if (!runPolicy.allowedActionTypes.includes(operation.type)) {
        badRequest(
          `The ${runPolicy.id} run policy blocks operations[${index}] (${operation.type}). Allowed actions: ${runPolicy.allowedActionTypes.join(", ")}.`
        );
      }
      if (!/^#?\d+$/.test(String(operation.payload?.query || operation.payload?.fileQuery || "").trim())) {
        badRequest(`operations[${index}] requires the exact JobNimbus file number under ${runPolicy.id}.`);
      }
      if (taskCompletionRequested(operation.payload)) {
        badRequest(`The ${runPolicy.id} run policy forbids completing tasks.`);
      }
      if (operation.type === "gmail.create_draft" && operation.payload?.insuranceClaimEmail !== true) {
        badRequest("Chance work-file Gmail drafts must declare insuranceClaimEmail:true so the claim-only subject rule is enforced.");
      }
      if (operation.type === "gmail.send_existing_draft") {
        const payloadKeys = Object.keys(operation.payload).sort();
        if (
          ![2, 3].includes(payloadKeys.length)
          || !payloadKeys.includes("draftId")
          || !payloadKeys.includes("query")
          || payloadKeys.some((key) => !["draftId", "operatorScope", "query"].includes(key))
          || (
            payloadKeys.includes("operatorScope")
            && operation.payload.operatorScope !== "assigned"
          )
        ) {
          badRequest("Locked-run existing-draft send payload must contain only {query,draftId} plus the coordinator-injected assigned scope; raw recipients, content, attachments, and fileQuery are forbidden.");
        }
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(String(operation.payload.draftId || ""))) {
          badRequest("Locked-run existing-draft send requires one exact Gmail draftId.");
        }
      }
    }
  }
  const plans = [];
  for (const operation of operations) {
    plans.push(await prepareActionOperation(operation, { runPolicy }));
  }
  const batchScope = await operatorBatchScope(operations, plans, { runPolicy });
  return {
    operations,
    plans,
    batchScope,
    approvalDigest: digest({
      version: 4,
      runPolicy: stableRunPolicy(runPolicy),
      batchScope: stableApprovalBatchScope(batchScope),
      plans: stableApprovalPlans(plans)
    })
  };
}

function actionBatchRunPolicy(input = {}) {
  if (
    !isMacCodexOperatorRequest()
    || isHcnRestrictedEffectRequest()
  ) {
    return null;
  }
  if (
    operatorCompanyScopeActive()
    && (REQUIRE_CHANCE_RUN_POLICY || CHANCE_OPERATOR_RUN_MANIFEST)
  ) {
    badRequest("Company-scope action batches are disabled during the locked Chance 58-file run. Read-only exact-file company review remains available.");
  }
  if (!input.runPolicy && !REQUIRE_CHANCE_RUN_POLICY) return null;
  try {
    return resolveChanceOperatorRunPolicy(input.runPolicy, CHANCE_OPERATOR_RUN_MANIFEST);
  } catch (error) {
    const unavailable = new Error(error.message);
    unavailable.statusCode = CHANCE_OPERATOR_RUN_MANIFEST ? 409 : 503;
    throw unavailable;
  }
}

function stableRunPolicy(runPolicy) {
  if (!runPolicy) return { enforced: false };
  return chanceOperatorRunManifestSummary(runPolicy.manifest);
}

function taskCompletionRequested(payload = {}) {
  const fields = payload.fields && typeof payload.fields === "object"
    ? payload.fields
    : {};
  return ["completed", "isCompleted", "is_completed"].some((key) => (
    Object.prototype.hasOwnProperty.call(payload, key)
    || Object.prototype.hasOwnProperty.call(fields, key)
  ));
}

function stableApprovalBatchScope(batchScope) {
  return {
    mode: batchScope?.mode || "",
    runPolicyId: batchScope?.runPolicyId || "",
    runPolicySha256: batchScope?.runPolicySha256 || "",
    runPolicyExpiresAt: batchScope?.runPolicyExpiresAt || "",
    fileCount: Number(batchScope?.fileCount || 0),
    files: (batchScope?.files || []).map((file) => ({
      id: file.id,
      number: file.number,
      operationIndexes: file.operationIndexes,
      operationTypes: file.operationTypes
    }))
  };
}

function stableApprovalPlans(plans) {
  return JSON.parse(JSON.stringify(plans, (key, value) => {
    if (["date_created", "generatedAt", "instruction"].includes(key)) return undefined;
    return value;
  }));
}

async function findChanceContact(query, options = {}) {
  const needle = normalizeContactLookupQuery(query);
  if (!needle) badRequest("query is required");
  const lower = needle.toLowerCase();
  const contacts = await listContacts({ maxPages: 25 });
  const companyScope = operatorCompanyScopeActive();
  const matches = contacts
    .filter(isInsuranceFile)
    .filter(chanceOperatorContactAllowed)
    .filter((contact) => (
      companyScope
      || assignedTo(contact, CHANCE_OWNER_ID)
    ))
    .filter((contact) => contactMatches(contact, lower))
    .map((contact) => ({ contact, score: chanceMatchScore(contact, needle) }))
    .filter(({ score }) => score >= 85)
    .sort((a, b) => b.score - a.score || fileSort(a.contact, b.contact));

  if (!matches.length) {
    badRequest(
      `No ${
        companyScope ? "company" : "Chance Pearson"
      } JobNimbus insurance file found for: ${needle}`
    );
  }
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    const choices = matches.slice(0, 5).map(({ contact }) => `${contact.number || contact.recid || "?"}: ${contact.display_name || contact.name || "Unnamed"}`);
    badRequest(`Ambiguous ${companyScope ? "company" : "Chance"} file query: ${needle}. Use the JobNimbus number, claim number, or exact address. Matches: ${choices.join("; ")}`);
  }

  const selectedId = matches[0].contact.jnid || matches[0].contact.id;
  const expectedFileId = String(options.expectedFileId || "").trim();
  if (expectedFileId && String(selectedId) !== expectedFileId) {
    conflictError(
      `The exact file binding changed after approval. Expected ${expectedFileId}; resolved ${selectedId}. Nothing was written.`
    );
  }
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(selectedId)}`);
  if (expectedFileId && String(contact?.jnid || contact?.id || "") !== expectedFileId) {
    conflictError("JobNimbus returned a different file than the approved immutable file binding. Nothing was written.");
  }
  if (
    !isInsuranceFile(contact)
    || (!companyScope && !assignedTo(contact, CHANCE_OWNER_ID))
    || (!companyScope && !chanceOperatorContactAllowed(contact))
    || (
      isMacCodexOperatorRequest()
      && !companyScope
      && isRestrictedEffectRequest()
      && !isExplicitlyOpenActive(contact)
    )
    || (
      isHcnRestrictedEffectRequest()
      && !hcnContactIsExplicitlyActive(contact)
    )
  ) {
    badRequest(`Resolved record is not ${companyScope ? "a company" : "a Chance Pearson"} insurance file: ${needle}`);
  }
  const knownStatusNames = [...new Set(contacts
    .filter(isInsuranceFile)
    .map((row) => String(row.status_name || "").trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return { contact, alternatives: matches.slice(1, 6).map(({ contact: row }) => row), knownStatusNames };
}

function resolveWorkflowStatusName(requestedStatus, knownStatusNames = []) {
  const requested = String(requestedStatus || "").trim();
  if (!requested) badRequest("status is required");

  const statuses = [...new Set((Array.isArray(knownStatusNames) ? knownStatusNames : [])
    .map((status) => String(status || "").trim())
    .filter(Boolean))];
  const exact = statuses.find((status) => normalizeCompare(status) === normalizeCompare(requested));
  if (exact) return exact;

  const requestedTokens = workflowStatusTokens(requested);
  const semanticMatches = statuses.filter((status) => {
    const candidateTokens = workflowStatusTokens(status);
    return requestedTokens.length >= 2 && requestedTokens.every((token) => candidateTokens.includes(token));
  });
  if (semanticMatches.length === 1) return semanticMatches[0];

  const available = statuses.slice(0, 30).join("; ") || "none returned by the current JobNimbus file index";
  if (semanticMatches.length > 1) {
    badRequest(`Ambiguous JobNimbus status: ${requested}. Matching live statuses: ${semanticMatches.join("; ")}. Use the exact status name.`);
  }
  badRequest(`Invalid JobNimbus status: ${requested}. The approval dry run was blocked before execution. Live insurance-file statuses: ${available}`);
}

function workflowStatusTokens(value) {
  return normalizeNameWords(value)
    .replace(/\b2\b/g, "two")
    .split(/\s+/)
    .map((token) => token.replace(/(?:ation|ations)$/i, "ation"))
    .filter((token) => token.length >= 3);
}

async function findDocumentReadContact(query, { documentQuery = "" } = {}) {
  const needle = normalizeContactLookupQuery(query);
  if (!needle) badRequest("query is required");
  const lower = needle.toLowerCase();
  const contacts = await listContacts({ maxPages: 25 });
  const ranked = contacts
    .filter(isInsuranceFile)
    .filter((contact) => contactMatches(contact, lower))
    .map((contact) => ({ contact, score: chanceMatchScore(contact, needle) }))
    .filter(({ score }) => score >= 85)
    .sort((a, b) => b.score - a.score || fileSort(a.contact, b.contact));
  const chanceMatches = ranked.filter(({ contact }) => assignedTo(contact, CHANCE_OWNER_ID));
  const companyScope = operatorCompanyScopeActive();

  let matches = companyScope ? ranked : chanceMatches;
  let readScope = companyScope ? "explicit_company_file" : "chance_assigned";
  if (!matches.length) {
    if (
      currentRequestIdentity()?.type === "codex_operator_token"
      && !companyScope
    ) {
      badRequest(`No Chance Pearson JobNimbus insurance file found for document review: ${needle}.`);
    }
    matches = ranked.filter(({ score }) => score >= 85);
    readScope = "explicit_company_read";
  }

  if (!matches.length) {
    const documentMatch = await findCompanyContactByExactDocument(needle, documentQuery);
    if (documentMatch) return documentMatch;
    badRequest(`No Chance Pearson file or exact, unambiguous company insurance-file match found for document review: ${needle}. Use the JobNimbus number, claim number, full client name, exact address, or exact document filename.`);
  }
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    const choices = matches.slice(0, 5).map(({ contact }) => `${contact.number || contact.recid || "?"}: ${contact.display_name || contact.name || "Unnamed"}`);
    badRequest(`Ambiguous document-review file query: ${needle}. Use the JobNimbus number, claim number, or exact address. Matches: ${choices.join("; ")}`);
  }

  const selectedId = matches[0].contact.jnid || matches[0].contact.id;
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(selectedId)}`);
  if (!isInsuranceFile(contact)) {
    badRequest(`Resolved record is not a JobNimbus insurance file: ${needle}`);
  }
  if (readScope === "chance_assigned" && !assignedTo(contact, CHANCE_OWNER_ID)) {
    badRequest(`Resolved record is not a Chance Pearson insurance file: ${needle}`);
  }
  return {
    contact,
    readScope,
    alternatives: matches.slice(1, 6).map(({ contact: row }) => row)
  };
}

async function findCompanyContactByExactDocument(query, documentQuery) {
  const queryWords = normalizeNameWords(query).split(" ").filter((token) => token.length >= 2);
  const exactDocument = normalizeCompare(documentQuery);
  if (queryWords.length < 2 || !exactDocument) return null;

  const matches = [];
  const filenameCandidates = uniqueDocumentFilenameCandidates(documentQuery);
  for (const filename of filenameCandidates) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ term: { filename } }] }));
    const rows = unwrapList(await jobNimbus(`/files?size=1000&from=0&filter=${filter}`), "files");
    matches.push(...rows.filter((document) => normalizeCompare(compactDocument(document).name) === exactDocument));
  }
  if (!matches.length) return null;

  const contactIds = new Set();
  for (const document of matches) {
    const ids = [];
    for (const key of ["primary", "related", "customer", "contact"]) collectIds(document?.[key], ids);
    ids.filter(Boolean).forEach((id) => contactIds.add(String(id)));
  }
  const contacts = [];
  for (const contactId of contactIds) {
    const contact = await jobNimbus(`/contacts/${encodeURIComponent(contactId)}`);
    if (!isInsuranceFile(contact)) continue;
    const names = [contact.display_name, contact.name, [contact.first_name, contact.last_name].filter(Boolean).join(" ")]
      .map(normalizeNameWords)
      .filter(Boolean);
    if (!names.some((name) => {
      const words = new Set(name.split(" ").filter(Boolean));
      return queryWords.every((word) => words.has(word));
    })) continue;
    contacts.push(contact);
  }

  const uniqueContacts = [...new Map(contacts.map((contact) => [String(contact.jnid || contact.id), contact])).values()];
  if (uniqueContacts.length > 1) {
    const choices = uniqueContacts.slice(0, 5).map((contact) => `${contact.number || contact.recid || "?"}: ${contact.display_name || contact.name || "Unnamed"}`);
    badRequest(`Exact document filename matched multiple company insurance files. Retry with the JobNimbus number, claim number, or exact address. Matches: ${choices.join("; ")}`);
  }
  if (!uniqueContacts.length) return null;
  return { contact: uniqueContacts[0], readScope: "explicit_company_document_read", alternatives: [] };
}

function chanceMatchScore(contact, query) {
  const exact = normalizeCompare(query);
  const identifiers = [contact.jnid, contact.id, contact.number, contact.recid].map(normalizeCompare).filter(Boolean);
  if (identifiers.includes(exact)) return 100;
  const claimValues = [
    fieldValue(contact, ["Claim #", "Claim Number", "claim_number", "cf_string_10", "cf_string_2"]),
    fieldValue(contact, ["Policy #", "Policy Number", "policy_number", "cf_string_4", "cf_string_3"])
  ].map(normalizeCompare).filter(Boolean);
  if (claimValues.includes(exact)) return 95;
  const names = [contact.display_name, contact.name, [contact.first_name, contact.last_name].filter(Boolean).join(" ")].map(normalizeCompare).filter(Boolean);
  if (names.includes(exact)) return 90;
  const nameTokens = normalizeNameWords(query).split(" ").filter((token) => token.length >= 2);
  const wordNames = [contact.display_name, contact.name, [contact.first_name, contact.last_name].filter(Boolean).join(" ")]
    .map(normalizeNameWords)
    .filter(Boolean);
  if (nameTokens.length >= 2 && wordNames.some((name) => {
    const words = new Set(name.split(" ").filter(Boolean));
    return nameTokens.every((token) => words.has(token));
  })) return 85;
  const addresses = [
    contact.address_line1,
    [contact.address_line1, contact.city, contact.state_text, contact.zip].filter(Boolean).join(" ")
  ].map(normalizeCompare).filter(Boolean);
  if (addresses.includes(exact)) return 90;
  return 10;
}

async function listContacts({ maxPages }) {
  return listResourcePages("/contacts", maxPages);
}

async function loadHcnJobNimbusIndex({
  maxRecords,
  requestedAt
} = {}) {
  const page = await hcnCachedContactIndex({
    maxRecords
  });
  return mapJobNimbusIndexEnvelope({
    contacts: page.rows,
    contactsComplete: page.complete,
    ...hcnFreshnessWindow(requestedAt)
  }, {
    chanceOwnerId: CHANCE_OWNER_ID
  });
}

async function loadHcnJobNimbusFile({
  providerFileId,
  recentLimit,
  requestedAt
} = {}) {
  const id = hcnProviderFileId(providerFileId);
  const maximumRelated = Math.min(
    500,
    Math.max(50, Number(recentLimit || 20) * 5)
  );
  const [contact, activities, tasks, documents] = await Promise.all([
    hcnCachedContact(id),
    listHcnResourceComplete("/activities", {
      maxRecords: maximumRelated,
      relatedContactId: id
    }),
    listHcnResourceComplete("/tasks", {
      maxRecords: maximumRelated,
      relatedContactId: id
    }),
    listHcnResourceComplete("/files", {
      maxRecords: 500,
      relatedContactId: id
    })
  ]);

  return mapJobNimbusFileEnvelope({
    contact,
    activities: activities.rows,
    tasks: tasks.rows,
    documents: documents.rows,
    activitiesComplete: activities.complete,
    tasksComplete: tasks.complete,
    documentsComplete: documents.complete,
    ...hcnFreshnessWindow(requestedAt)
  }, {
    chanceOwnerId: CHANCE_OWNER_ID,
    expectedProviderFileId: id
  });
}

async function loadHcnGmailFile({
  providerFileId,
  recentLimit,
  requestedAt
} = {}) {
  if (
    !GOOGLE_CLIENT_ID
    || !GOOGLE_CLIENT_SECRET
    || !GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const id = hcnProviderFileId(providerFileId);
  const scope = await hcnExactCommunicationScope(id);
  const file = scope.file;
  const query = buildFileGmailQuery(file, 365);
  const maximumMessages = Math.min(
    50,
    Math.max(10, Number(recentLimit || 20) * 3)
  );
  if (
    scope.file[GMAIL_FILE_EMAIL_UNIQUE] !== true
    && scope.file[GMAIL_FILE_CLAIM_UNIQUE] !== true
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const result = await hcnGmailApi(
    `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages`
      + `?q=${encodeURIComponent(query)}&maxResults=${maximumMessages}`
  );
  if (
    !result
    || typeof result !== "object"
    || Array.isArray(result)
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const rows = Array.isArray(result.messages)
    ? result.messages
    : result.messages === undefined
      && Number(result.resultSizeEstimate) === 0
      ? []
      : null;
  if (
    !rows
    || rows.length > maximumMessages
    || rows.some(
      (row) => {
        const messageId = String(row?.id || "");
        return !row
          || typeof row !== "object"
          || Array.isArray(row)
          || !messageId
          || messageId.length > 512
          || /[\s\x00-\x1f\x7f]/.test(messageId);
      }
    )
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  if (
    new Set(rows.map((row) => String(row.id))).size !== rows.length
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const nextPageToken = result.nextPageToken;
  if (
    nextPageToken !== undefined
    && nextPageToken !== null
    && (
      typeof nextPageToken !== "string"
      || !nextPageToken.trim()
      || nextPageToken.length > 2048
    )
  ) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const items = [];
  for (const row of rows) {
    const message = compactGmailFullMessage(
      await hcnGmailApi(
        `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/`
          + `${encodeURIComponent(row.id)}?format=full`
      )
    );
    if (!gmailMessageMatchesFile(message, file)) continue;
    items.push({
      ...message,
      providerFileId: id,
      direction: hcnGmailDirection(message, file)
    });
  }
  return mapScopedGmailEnvelope({
    providerFileId: id,
    items,
    scope: {
      providerFileId: id,
      exactFileMatch: true
    },
    itemsComplete: !String(nextPageToken || ""),
    ...hcnFreshnessWindow(requestedAt)
  }, {
    expectedProviderFileId: id
  });
}

async function loadHcnQuoFile({
  providerFileId,
  recentLimit,
  requestedAt
} = {}) {
  const id = hcnProviderFileId(providerFileId);
  const scope = await hcnExactCommunicationScope(id);
  if (!scope.file.phone) {
    throw new Error("Quo evidence is unavailable.");
  }
  const history = await readQuoHistoryStrict(quoConfig(), {
    phone: scope.file.phone,
    maxResults: Math.min(50, Math.max(10, Number(recentLimit || 20))),
    maxPages: 5
  });
  const items = (Array.isArray(history?.timeline)
    ? history.timeline
    : []).map((item) => ({
      ...item,
      providerFileId: id
    }));
  return mapScopedQuoEnvelope({
    providerFileId: id,
    items,
    scope: {
      providerFileId: id,
      exactFileMatch: true
    },
    itemsComplete: history?.completeness?.complete === true,
    ...hcnFreshnessWindow(requestedAt)
  }, {
    expectedProviderFileId: id
  });
}

async function hcnExactCommunicationScope(providerFileId) {
  const cache = hcnFreshProviderCache();
  const existing = cache?.communicationScopePromises.get(providerFileId);
  if (existing) return existing;
  const pending = buildHcnExactCommunicationScope(providerFileId);
  if (cache) cache.communicationScopePromises.set(providerFileId, pending);
  try {
    return await pending;
  } catch (error) {
    cache?.communicationScopePromises.delete(providerFileId);
    throw error;
  }
}

async function buildHcnExactCommunicationScope(providerFileId) {
  const [contact, index] = await Promise.all([
    hcnCachedContact(providerFileId),
    hcnCachedContactIndex({
      maxRecords: 5000
    })
  ]);
  if (!index.complete) {
    throw new Error("Exact communication scope is unavailable.");
  }
  const exactId = String(contact?.jnid || contact?.id || "");
  if (
    exactId !== providerFileId
    || !isInsuranceFile(contact)
    || !assignedTo(contact, CHANCE_OWNER_ID)
    || !hcnContactIsExplicitlyActive(contact)
  ) {
    throw new Error("Exact communication scope is unavailable.");
  }
  const file = compactContact(contact);
  Object.defineProperty(file, GMAIL_FILE_COMPANY_CONTACTS, {
    value: index.rows,
    enumerable: false
  });

  const email = hcnNormalizeCorrelationEmail(
    fieldValue(contact, [
      "email",
      "primary_email",
      "primaryEmail"
    ])
  );
  file.email = email;
  const emailCorrelation = hcnGlobalScalarCorrelation(
    index.rows,
    email,
    HCN_CONTACT_EMAIL_KEYS,
    hcnNormalizeCorrelationEmail
  );
  Object.defineProperty(file, GMAIL_FILE_EMAIL_UNIQUE, {
    value:
      Boolean(email)
      && emailCorrelation.complete
      && emailCorrelation.matches.length === 1
      && String(
        emailCorrelation.matches[0]?.jnid
          || emailCorrelation.matches[0]?.id
          || ""
      ) === providerFileId,
    enumerable: false
  });

  const rawClaimNumber = fieldValue(contact, [
    "Claim #",
    "Claim Number",
    "claim_number",
    "claimNumber",
    "cf_string_10",
    "cf_string_2"
  ]);
  file.claimNumber = String(rawClaimNumber || "").trim();
  const claimNumber = hcnNormalizeCorrelationClaim(rawClaimNumber);
  const claimCorrelation = hcnGlobalScalarCorrelation(
    index.rows,
    claimNumber,
    HCN_CONTACT_CLAIM_KEYS,
    hcnNormalizeCorrelationClaim
  );
  Object.defineProperty(file, GMAIL_FILE_CLAIM_UNIQUE, {
    value:
      claimNumber.length >= 6
      && claimCorrelation.complete
      && claimCorrelation.matches.length === 1
      && String(
        claimCorrelation.matches[0]?.jnid
          || claimCorrelation.matches[0]?.id
          || ""
      ) === providerFileId,
    enumerable: false
  });

  const phone = normalizePhone(file.phone);
  const phoneCorrelation = hcnGlobalPhoneCorrelation(
    index.rows,
    phone
  );
  if (
    !phone
    || !phoneCorrelation.complete
    || (
      phoneCorrelation.matches.length !== 1
      || String(
        phoneCorrelation.matches[0]?.jnid
          || phoneCorrelation.matches[0]?.id
          || ""
      ) !== providerFileId
    )
  ) {
    file.phone = "";
  }
  return { contact, file };
}

function hcnFreshProviderCache() {
  const context = currentRequestAuthentication();
  if (context?.authenticationMethod !== "hcn_cookie") return null;
  if (!context[HCN_FRESH_PROVIDER_CACHE]) {
    Object.defineProperty(context, HCN_FRESH_PROVIDER_CACHE, {
      value: {
        contactIndexPromise: null,
        contactIndexMaximum: 0,
        contactPromises: new Map(),
        communicationScopePromises: new Map()
      },
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  return context[HCN_FRESH_PROVIDER_CACHE];
}

async function hcnCachedContactIndex({ maxRecords } = {}) {
  const maximum = Number(maxRecords);
  const cache = hcnFreshProviderCache();
  if (!cache) {
    return listHcnResourceComplete("/contacts", {
      maxRecords: maximum
    });
  }
  if (
    cache.contactIndexPromise
    && cache.contactIndexMaximum >= maximum
  ) {
    return cache.contactIndexPromise;
  }
  const pending = listHcnResourceComplete("/contacts", {
    maxRecords: maximum
  });
  cache.contactIndexPromise = pending;
  cache.contactIndexMaximum = maximum;
  try {
    return await pending;
  } catch (error) {
    if (cache.contactIndexPromise === pending) {
      cache.contactIndexPromise = null;
      cache.contactIndexMaximum = 0;
    }
    throw error;
  }
}

async function hcnCachedContact(providerFileId) {
  const id = hcnProviderFileId(providerFileId);
  const cache = hcnFreshProviderCache();
  if (!cache) {
    return hcnJobNimbus(`/contacts/${encodeURIComponent(id)}`);
  }
  const existing = cache.contactPromises.get(id);
  if (existing) return existing;
  const pending = hcnJobNimbus(`/contacts/${encodeURIComponent(id)}`);
  cache.contactPromises.set(id, pending);
  try {
    return await pending;
  } catch (error) {
    if (cache.contactPromises.get(id) === pending) {
      cache.contactPromises.delete(id);
    }
    throw error;
  }
}

function hcnContactIsExplicitlyActive(contact) {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) {
    return false;
  }
  const hasExplicitActive = ["is_active", "isActive", "active"]
    .some(
      (key) =>
        Object.prototype.hasOwnProperty.call(contact, key)
        && contact[key] === true
    );
  if (!hasExplicitActive) return false;
  if (
    ["is_active", "isActive", "active"]
      .some(
        (key) =>
          Object.prototype.hasOwnProperty.call(contact, key)
          && contact[key] === false
      )
  ) {
    return false;
  }
  return ![
    "is_archived",
    "isArchived",
    "archived",
    "is_closed",
    "isClosed",
    "closed"
  ].some((key) => contact[key] === true);
}

function hcnGmailDirection(message, file) {
  const clientEmail = String(file?.email || "").trim().toLowerCase();
  if (!clientEmail) return "unknown";
  const from = String(message?.from || "").toLowerCase();
  const destinations = [
    message?.to,
    message?.cc,
    message?.bcc
  ].map((value) => String(value || "").toLowerCase()).join("\n");
  if (from.includes(clientEmail)) return "inbound";
  if (destinations.includes(clientEmail)) return "outbound";
  return "unknown";
}

function hcnProviderFileId(value) {
  const id = String(value || "");
  if (
    !id
    || id.length > 512
    || /[\s\x00-\x1f\x7f]/.test(id)
  ) {
    const error = new Error("Exact HCN file scope is invalid.");
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function hcnFreshnessWindow(requestedAt) {
  const timestamp = new Date(String(requestedAt || ""));
  if (Number.isNaN(timestamp.getTime())) {
    const error = new Error("Fresh evidence timing is unavailable.");
    error.statusCode = 503;
    throw error;
  }
  const checkedAt = timestamp.toISOString();
  return {
    asOf: checkedAt,
    checkedAt,
    validUntil: new Date(
      timestamp.getTime() + 2 * 60 * 1000
    ).toISOString()
  };
}

async function listHcnResourceComplete(
  endpoint,
  {
    maxRecords,
    relatedContactId = ""
  } = {}
) {
  const maximum = Number(maxRecords);
  if (
    !Number.isSafeInteger(maximum)
    || maximum < 1
    || maximum > 5000
  ) {
    throw new Error("HCN provider read bound is unavailable.");
  }
  const relatedId = relatedContactId
    ? hcnProviderFileId(relatedContactId)
    : "";
  const filter = relatedId
    ? JSON.stringify({
        must: [{ term: { "related.id": relatedId } }]
      })
    : "";
  const rows = [];
  let offset = 0;
  let declaredTotal = null;
  while (offset < maximum) {
    const size = Math.min(500, maximum - offset);
    const payload = await hcnJobNimbus(
      hcnPagedEndpoint(endpoint, {
        size,
        offset,
        filter
      })
    );
    const batch = unwrapHcnList(
      payload,
      endpoint.replace(/^\//, "").split("?")[0]
    );
    if (batch.length > size) {
      throw new Error("JobNimbus pagination is unavailable.");
    }
    if (
      batch.some(
        (item) =>
          !item
          || typeof item !== "object"
          || Array.isArray(item)
      )
    ) {
      throw new Error("JobNimbus pagination is unavailable.");
    }
    if (
      endpoint.split("?", 1)[0] === "/contacts"
      && batch.some(
        (item) => {
          const id = String(item?.jnid || item?.id || "");
          return !id
            || id.length > 512
            || /[\s\x00-\x1f\x7f]/.test(id);
        }
      )
    ) {
      throw new Error("JobNimbus pagination is unavailable.");
    }
    if (
      relatedId
      && batch.some(
        (item) => !referencesContact(item, relatedId)
      )
    ) {
      throw new Error("JobNimbus exact-file pagination is unavailable.");
    }
    const pageTotalRaw = payload?.total ?? payload?.count ?? payload?.meta?.total;
    const hasPageTotal = pageTotalRaw !== undefined && pageTotalRaw !== null && pageTotalRaw !== "";
    if (hasPageTotal) {
      const pageTotal = Number(pageTotalRaw);
      if (
        !Number.isSafeInteger(pageTotal)
        || pageTotal < 0
        || offset + batch.length > pageTotal
        || (declaredTotal !== null && declaredTotal !== pageTotal)
      ) {
        throw new Error("JobNimbus pagination total is unavailable or inconsistent.");
      }
      declaredTotal = pageTotal;
    } else if (declaredTotal !== null) {
      throw new Error("JobNimbus pagination total disappeared before the inventory was complete.");
    }
    rows.push(...batch);
    if (declaredTotal !== null && offset + batch.length >= declaredTotal) {
      return {
        rows,
        complete: true
      };
    }
    if (!batch.length) {
      if (declaredTotal !== null) {
        throw new Error("JobNimbus pagination stopped before its declared total.");
      }
      return {
        rows,
        complete: true
      };
    }
    offset += batch.length;
  }

  if (declaredTotal !== null) {
    return {
      rows,
      complete: offset >= declaredTotal
    };
  }
  const probe = unwrapHcnList(
    await hcnJobNimbus(
      hcnPagedEndpoint(endpoint, {
        size: 1,
        offset,
        filter
      })
    ),
    endpoint.replace(/^\//, "").split("?")[0]
  );
  return {
    rows,
    complete: probe.length === 0
  };
}

function hcnPagedEndpoint(
  endpoint,
  {
    size,
    offset,
    filter
  }
) {
  const separator = endpoint.includes("?") ? "&" : "?";
  const query = new URLSearchParams({
    size: String(size),
    from: String(offset)
  });
  if (filter) query.set("filter", filter);
  return `${endpoint}${separator}${query.toString()}`;
}

function unwrapHcnList(payload, name) {
  if (Array.isArray(payload)) return payload;
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    throw new Error("JobNimbus pagination is unavailable.");
  }
  const candidates = [
    name,
    singular(name),
    "results",
    "data",
    "items",
    "contacts",
    "contact",
    "jobs",
    "job",
    "tasks",
    "task",
    "activities",
    "activity",
    "files",
    "file"
  ];
  const present = [...new Set(candidates)]
    .filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (
    present.length !== 1
    || !Array.isArray(payload[present[0]])
  ) {
    throw new Error("JobNimbus pagination is unavailable.");
  }
  return payload[present[0]];
}

async function listResourcePages(endpoint, maxPages = 10, options = {}) {
  const pageLimit = Number(maxPages);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 25) {
    throw new Error("JobNimbus pagination bound is unavailable.");
  }
  const maximum = Number(options.maxRecords ?? pageLimit * 1000);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 25000) {
    throw new Error("JobNimbus pagination bound is unavailable.");
  }
  const filter = String(options.filter || "").trim();
  const name = endpoint.replace(/^\//, "").split("?")[0];
  const rows = [];
  let offset = 0;
  let declaredTotal = null;
  const maxRequests = Math.min(maximum + 1, pageLimit * 20);
  let requestCount = 0;
  while (offset < maximum && requestCount < maxRequests) {
    const size = Math.min(1000, maximum - offset);
    const payload = await jobNimbus(hcnPagedEndpoint(endpoint, {
      size,
      offset,
      filter
    }));
    requestCount += 1;
    const batch = unwrapHcnList(payload, name);
    if (batch.length > size) {
      throw new Error("JobNimbus pagination is unavailable.");
    }
    const pageTotalRaw = payload?.total ?? payload?.count ?? payload?.meta?.total;
    const hasPageTotal = pageTotalRaw !== undefined
      && pageTotalRaw !== null
      && pageTotalRaw !== "";
    if (hasPageTotal) {
      const pageTotal = Number(pageTotalRaw);
      if (
        !Number.isSafeInteger(pageTotal)
        || pageTotal < 0
        || pageTotal > maximum
        || offset + batch.length > pageTotal
        || (declaredTotal !== null && declaredTotal !== pageTotal)
      ) {
        throw new Error("JobNimbus pagination total is unavailable or inconsistent.");
      }
      declaredTotal = pageTotal;
    } else if (declaredTotal !== null) {
      throw new Error("JobNimbus pagination total disappeared before the inventory was complete.");
    }
    rows.push(...batch);
    if (declaredTotal !== null && offset + batch.length >= declaredTotal) return rows;
    if (!batch.length) {
      if (declaredTotal !== null) {
        throw new Error("JobNimbus pagination stopped before its declared total.");
      }
      return rows;
    }
    offset += batch.length;
  }
  const probe = unwrapHcnList(await jobNimbus(hcnPagedEndpoint(endpoint, {
    size: 1,
    offset,
    filter
  })), name);
  if (probe.length) {
    throw new Error("JobNimbus pagination is incomplete at the reviewed bound.");
  }
  return rows;
}

async function listRelated(endpoint, contactId, limit) {
  const exactContactId = String(contactId || "").trim();
  const resultLimit = Number(limit);
  if (!exactContactId || !Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 5000) {
    throw new Error("JobNimbus exact-file pagination bound is unavailable.");
  }
  const filters = ["related.id", "primary.id"].map((field) => JSON.stringify({
    must: [{ term: { [field]: exactContactId } }]
  }));
  const inventories = await Promise.all(filters.map((filter) => listResourcePages(
    endpoint,
    5,
    { filter, maxRecords: 5000 }
  )));
  const records = new Map();
  for (const item of inventories.flat()) {
    if (!referencesContact(item, exactContactId)) {
      throw new Error("JobNimbus exact-file pagination returned another file's record.");
    }
    const id = String(item?.jnid || item?.id || "").trim();
    if (!id) {
      throw new Error("JobNimbus exact-file pagination returned a record without an id.");
    }
    if (!records.has(id)) records.set(id, item);
  }
  return [...records.values()].slice(0, resultLimit);
}

function unwrapList(payload, name) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    name,
    singular(name),
    "results",
    "data",
    "items",
    "contacts",
    "contact",
    "jobs",
    "job",
    "tasks",
    "task",
    "activities",
    "activity",
    "files",
    "file"
  ];
  for (const key of candidates) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function singular(name) {
  if (name === "activities") return "activity";
  if (name === "files") return "files";
  if (name.endsWith("s")) return name.slice(0, -1);
  return name;
}

function referencesContact(item, contactId) {
  const ids = [];
  for (const key of ["primary", "related", "customer", "contact", "parent"]) {
    collectIds(item?.[key], ids);
  }
  return ids.includes(contactId);
}

function selectDocument(documents, documentQuery) {
  if (!documents.length) return null;
  if (!documentQuery) return documents[0];
  const needle = String(documentQuery).trim().toLowerCase();
  const normalizedNeedle = normalizeCompare(documentQuery);
  return documents.find((doc) => String(doc.jnid || doc.id || "").toLowerCase() === needle)
    || documents.find((doc) => normalizeCompare(doc.name || doc.filename || doc.file_name) === normalizedNeedle)
    || documents.find((doc) => documentMatches(doc, needle))
    || null;
}

function normalizeDocumentPurpose(value) {
  const purpose = String(value || "").trim().toLowerCase();
  if (!purpose) return "";
  const supported = new Set([
    "insurance_policy",
    "tdi_form",
    "estimate_scope",
    "carrier_claim_document",
    "appraisal_document",
    "representation_contract"
  ]);
  if (!supported.has(purpose)) badRequest(`Unsupported documentPurpose: ${purpose}`);
  return purpose;
}

function selectDocumentByPurpose(documents, purpose) {
  const patterns = {
    insurance_policy: /\b(?:insurance|policy|declarations?|dec\s*page)\b/i,
    tdi_form: /\btdi\b|texas department of insurance/i,
    estimate_scope: /\b(?:estimate|scope|final draft|xactimate)\b|\.esx$/i,
    carrier_claim_document: /\b(?:carrier estimate|scope of loss|claim letter|coverage letter|settlement)\b/i,
    appraisal_document: /\b(?:appraisal|appraiser|umpire|award)\b/i,
    representation_contract: /\b(?:fin\s*535|pa contract|public adjuster contract|letter of representation|lor)\b/i
  };
  const excludeForPolicy = /\b(?:tdi|part b|fin\s*535|w-?9|estimate|scope|esx|photo|appraisal|dcw)\b/i;
  const pattern = patterns[purpose];
  const matches = documents.filter(isOperationalDocumentMetadata).filter((doc) => {
    const name = compactDocument(doc).name;
    if (!pattern.test(name)) return false;
    return purpose !== "insurance_policy" || !excludeForPolicy.test(name);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const choices = matches.slice(0, 20)
      .map((doc) => `${doc.jnid || doc.id || "unknown-id"}: ${compactDocument(doc).name}`)
      .join("; ");
    badRequest(`Multiple ${purpose} documents matched. Retry with one exact document id. Matches: ${choices}`);
  }
  return null;
}

function selectDocumentForChat(documents, documentQuery) {
  if (!documents.length) badRequest("No documents are attached to this Chance file.");
  const needle = String(documentQuery || "").trim().toLowerCase();
  if (!needle) badRequest("documentQuery is required so the bridge never returns the wrong client document.");

  const exactIdMatches = documents.filter((doc) => String(doc.jnid || doc.id || "").toLowerCase() === needle);
  if (exactIdMatches.length === 1) return exactIdMatches[0];

  const exactNameMatches = documents.filter((doc) => {
    const name = doc.name || doc.filename || doc.file_name || "";
    return normalizeCompare(name) === normalizeCompare(documentQuery);
  });
  if (exactNameMatches.length === 1) return exactNameMatches[0];

  const partialMatches = documents.filter((doc) => documentMatches(doc, needle));
  if (partialMatches.length === 1) return partialMatches[0];

  const candidates = (partialMatches.length ? partialMatches : documents)
    .map((doc) => `${doc.jnid || doc.id || "unknown-id"}: ${compactDocument(doc).name || "unnamed document"}`)
    .slice(0, 12)
    .join("; ");
  if (partialMatches.length > 1 || exactNameMatches.length > 1) {
    badRequest(`Document query is ambiguous. Retry with the exact JobNimbus document id. Matches: ${candidates}`);
  }
  badRequest(`No JobNimbus document matched ${documentQuery}. Available documents: ${candidates}`);
}

function documentMatches(doc, needle) {
  const searchable = [
    doc.jnid,
    doc.id,
    doc.name,
    doc.filename,
    doc.file_name,
    doc.description,
    doc.record_type_name,
    doc.type
  ].filter(Boolean).join(" ");
  return normalizeCompare(searchable).includes(normalizeCompare(needle));
}

async function downloadJobNimbusFile(doc) {
  const id = doc.jnid || doc.id;
  if (!id) badRequest("Selected document does not have a JobNimbus file id.");
  const response = await fetch(`${JOBNIMBUS_FILE_BASE_URL}/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${API_KEY}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = bytes.toString("utf8", 0, Math.min(bytes.length, 500));
    const error = new Error(`JobNimbus file download ${response.status}: ${text}`);
    error.statusCode = response.status;
    throw error;
  }
  return {
    bytes,
    contentType: response.headers.get("content-type") || "",
    filename: doc.name || doc.filename || doc.file_name || ""
  };
}

function chatgptDocumentMimeType(contentType, filename) {
  const normalized = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  const extension = path.extname(String(filename || "")).toLowerCase();
  const inferred = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".rtf": "application/rtf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  }[extension];
  const mimeType = inferred || normalized;
  if (!mimeType || mimeType === "application/octet-stream") {
    badRequest(`Cannot safely determine a supported document type for ${filename}.`);
  }
  if (/^(image|video|audio)\//.test(mimeType)) {
    badRequest("GPT Actions cannot return image, video, or audio files as conversation attachments. Use bridge OCR for those file types.");
  }
  const allowed = mimeType.startsWith("text/") || [
    "application/pdf",
    "application/json",
    "application/xml",
    "application/rtf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ].includes(mimeType);
  if (!allowed) badRequest(`Unsupported ChatGPT conversation document type: ${mimeType}.`);
  return mimeType;
}

function shouldAttachForNativeReview(extracted, review) {
  const text = String(extracted?.text || "").trim();
  return !hasUsefulExtractedText(text)
    || Boolean(extracted?.error)
    || Boolean(extracted?.truncated)
    || Boolean(review?.needsOcr);
}

function prepareChatgptDocumentAttachment(downloaded, document) {
  const filename = safeMimeFilename(
    downloaded.filename || compactDocument(document).name || `jobnimbus-document-${document.jnid || document.id || "file"}`
  );
  const mimeType = chatgptDocumentMimeType(downloaded.contentType, filename);
  const checked = validateEmailAttachment({ filename, contentType: mimeType, bytes: downloaded.bytes });
  if (checked.bytes.length > MAX_CHATGPT_FILE_BYTES) {
    badRequest(
      `Document ${checked.filename} is ${checked.bytes.length} bytes. The ChatGPT conversation-file limit for this bridge is ${MAX_CHATGPT_FILE_BYTES} bytes.`
    );
  }
  return {
    bytes: checked.bytes.length,
    contentType: mimeType,
    openaiFileResponse: [{
      name: checked.filename,
      mime_type: mimeType,
      content: checked.bytes.toString("base64")
    }]
  };
}

async function extractDocumentText(downloaded, doc, maxChars, options = {}) {
  const filename = String(downloaded.filename || doc.name || doc.filename || doc.file_name || "").toLowerCase();
  const contentType = String(downloaded.contentType || "").toLowerCase();
  const looksPdf = contentType.includes("pdf") || filename.endsWith(".pdf");
  const looksImage = contentType.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(filename);
  const looksText = contentType.startsWith("text/") || /\.(txt|csv|json|xml|html|md)$/i.test(filename);

  if (looksPdf) {
    let pdfText = "";
    let pageCount = null;
    let pdfError = "";
    try {
      const pdfParseModule = await import("pdf-parse");
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const parsed = await pdfParse(downloaded.bytes);
      pdfText = cleanExtractedText(parsed.text || "");
      pageCount = parsed.numpages || parsed.numrender || null;
      if (!options.forceOcr && hasUsefulExtractedText(pdfText)) {
        return {
          extraction: "pdf-parse",
          pageCount,
          truncated: pdfText.length > maxChars,
          ocrAttempted: false,
          text: pdfText.slice(0, maxChars)
        };
      }
    } catch (error) {
      pdfError = error.message;
    }

    const ocr = await ocrPdf(downloaded.bytes, {
      filename,
      maxPages: options.maxOcrPages || 5,
      maxChars
    });
    const combinedText = cleanExtractedText([pdfText, ocr.text].filter(Boolean).join("\n\n"));
    if (combinedText) {
      return {
        extraction: pdfText ? "pdf-parse+ocr" : "ocr",
        pageCount,
        truncated: combinedText.length > maxChars || Boolean(ocr.truncated),
        ocrAttempted: true,
        ocrPages: ocr.pages,
        ocrErrors: ocr.errors,
        text: combinedText.slice(0, maxChars),
        error: pdfError && !ocr.text ? `PDF extraction failed: ${pdfError}` : ""
      };
    }

    return {
      extraction: "failed",
      pageCount,
      truncated: false,
      ocrAttempted: true,
      ocrPages: ocr.pages,
      ocrErrors: ocr.errors,
      error: `No usable text extracted. PDF error: ${pdfError || "none"}. OCR error: ${ocr.errors.join("; ") || "no text returned"}.`,
      text: ""
    };
  }

  if (looksImage) {
    const ocr = await ocrImage(downloaded.bytes, { filename, maxChars });
    return {
      extraction: ocr.text ? "ocr" : "failed",
      truncated: Boolean(ocr.truncated),
      ocrAttempted: true,
      ocrPages: ocr.pages,
      ocrErrors: ocr.errors,
      error: ocr.text ? "" : `OCR returned no usable text. ${ocr.errors.join("; ")}`,
      text: ocr.text.slice(0, maxChars)
    };
  }

  if (looksText) {
    const raw = downloaded.bytes.toString("utf8");
    return {
      extraction: "plain-text",
      truncated: raw.length > maxChars,
      ocrAttempted: false,
      text: cleanExtractedText(raw).slice(0, maxChars)
    };
  }

  return {
    extraction: "unsupported",
    error: "This file type is not currently text-extractable by the bridge. Use Drive/file tools or download metadata only.",
    text: ""
  };
}

function hasUsefulExtractedText(text) {
  return text.split(/\s+/).filter(Boolean).length >= 25;
}

async function ocrPdf(bytes, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "jn-ocr-"));
  const inputPath = path.join(dir, sanitizeFilename(options.filename || "document.pdf", ".pdf"));
  const prefix = path.join(dir, "page");
  const errors = [];
  try {
    await writeFile(inputPath, bytes);
    const convert = await runCommand("pdftoppm", [
      "-png",
      "-r",
      "200",
      "-f",
      "1",
      "-l",
      String(options.maxPages || 5),
      inputPath,
      prefix
    ]);
    if (convert.stderr) errors.push(convert.stderr.trim());
    const files = (await readdir(dir))
      .filter((file) => /^page-\d+\.png$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const pageTexts = [];
    for (const file of files) {
      const imagePath = path.join(dir, file);
      const result = await runCommand("tesseract", [imagePath, "stdout", "--psm", "6"]);
      if (result.stderr) errors.push(`${file}: ${result.stderr.trim()}`);
      pageTexts.push(result.stdout);
      if (cleanExtractedText(pageTexts.join("\n\n")).length >= options.maxChars) break;
    }
    const text = cleanExtractedText(pageTexts.join("\n\n"));
    return {
      text: text.slice(0, options.maxChars),
      truncated: text.length > options.maxChars,
      pages: files.length,
      errors: errors.filter(Boolean)
    };
  } catch (error) {
    return { text: "", truncated: false, pages: 0, errors: [error.message] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ocrImage(bytes, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "jn-ocr-"));
  const inputPath = path.join(dir, sanitizeFilename(options.filename || "image.png", ".png"));
  try {
    await writeFile(inputPath, bytes);
    const result = await runCommand("tesseract", [inputPath, "stdout", "--psm", "6"]);
    const text = cleanExtractedText(result.stdout);
    return {
      text: text.slice(0, options.maxChars),
      truncated: text.length > options.maxChars,
      pages: text ? 1 : 0,
      errors: result.stderr ? [result.stderr.trim()] : []
    };
  } catch (error) {
    return { text: "", truncated: false, pages: 0, errors: [error.message] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sanitizeFilename(name, fallbackExt) {
  const safe = String(name || "document")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : `${safe}${fallbackExt}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function cleanExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function reviewExtractedDocument(text, document, file) {
  const normalized = cleanExtractedText(text);
  const documentName = compactDocument(document).name;
  const type = classifyDocument(documentName, normalized);
  const extractedFields = extractCommonClaimFields(normalized);
  const estimate = extractEstimateFields(normalized);
  const coverage = extractCoverageFields(normalized);
  const conflicts = findFieldConflicts(file, extractedFields);
  const textQuality = assessTextQuality(normalized);
  const suggestedUses = suggestDocumentUses(type, extractedFields, estimate, coverage, textQuality);
  return {
    documentType: type,
    textQuality,
    extractedFields,
    estimate,
    coverage,
    conflictsWithJobNimbus: conflicts,
    suggestedUses,
    needsOcr: textQuality.needsOcr,
    notes: buildDocumentReviewNotes(type, textQuality, conflicts)
  };
}

function classifyDocument(name, text) {
  const haystack = `${name}\n${text}`.toLowerCase();
  if (/\b(declarations?|dec page|policy)\b/.test(haystack)) return "policy_or_declarations";
  if (/\btdi\b|texas department of insurance|property insurance notice/.test(haystack)) return "tdi_or_notice_form";
  if (/\bxactimate\b|estimate|replacement cost value|actual cash value|depreciation/.test(haystack)) return "estimate_or_scope";
  if (/\bappraisal\b|umpire|appraiser|demand/.test(haystack)) return "appraisal_document";
  if (/\bclaim number|claim #|loss date|date of loss|adjuster\b/.test(haystack)) return "carrier_claim_document";
  if (!text.trim()) return "unreadable_or_image_only";
  return "unknown_text_document";
}

function extractCommonClaimFields(text) {
  return cleanObject({
    carrier: firstMatch(text, [
      /(?:insurance company|insurer|company)\s*[:#-]?\s*([A-Z][A-Za-z0-9&.,' -]{2,70})/i,
      /\b(State Farm|Allstate|Travelers|Liberty Mutual|USAA|Texas Farm Bureau|Farmers|Nationwide|Progressive|Chubb|Safeco|National Summit)\b/i
    ]),
    policyNumber: normalizePolicy(firstMatch(text, [
      /(?:policy(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{4,40})/i,
      /\bpolicy\s+([A-Z0-9][A-Z0-9 -]{4,40})/i
    ])),
    claimNumber: normalizePolicy(firstMatch(text, [
      /(?:claim(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{4,40})/i,
      /\bclaim\s+([A-Z0-9][A-Z0-9 -]{4,40})/i
    ])),
    dateOfLoss: firstDate(text, [
      /(?:date of loss|loss date|dol)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    effectiveDate: firstDate(text, [
      /(?:effective date|policy period|coverage period)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    expirationDate: firstDate(text, [
      /(?:expiration date|expires|to)\s*[:#-]?\s*([A-Za-z0-9,/-]{6,24})/i
    ]),
    namedInsured: firstMatch(text, [
      /(?:named insured|insured name|insured)\s*[:#-]?\s*([A-Z][A-Za-z.,' -]{3,80})/i
    ]),
    propertyAddress: extractAddress(text),
    adjusterName: firstMatch(text, [
      /(?:adjuster|claims representative|claim representative)\s*[:#-]?\s*([A-Z][A-Za-z.' -]{3,60})/i
    ]),
    adjusterPhone: firstMatch(text, [
      /(?:adjuster|claims representative|phone|tel|mobile)[^\n]{0,40}?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i
    ]),
    adjusterEmail: firstMatch(text, [
      /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
    ])
  });
}

function extractEstimateFields(text) {
  return cleanObject({
    rcv: firstMoney(text, [
      /(?:replacement cost value|rcv|total rcv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    acv: firstMoney(text, [
      /(?:actual cash value|acv|total acv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    depreciation: firstMoney(text, [
      /(?:depreciation|recoverable depreciation)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    deductible: firstMoney(text, [
      /(?:deductible)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ]),
    netClaim: firstMoney(text, [
      /(?:net claim|net actual cash value|net acv)\s*[:#-]?\s*\$?\s*([\d,]+\.\d{2})/i
    ])
  });
}

function extractCoverageFields(text) {
  return cleanObject({
    dwellingLimit: firstMoney(text, [
      /(?:dwelling|coverage a|cov a)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    otherStructuresLimit: firstMoney(text, [
      /(?:other structures|coverage b|cov b)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    personalPropertyLimit: firstMoney(text, [
      /(?:personal property|coverage c|cov c)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    lossOfUseLimit: firstMoney(text, [
      /(?:loss of use|coverage d|cov d)[^\n$]{0,50}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    windHailDeductible: firstMoney(text, [
      /(?:wind\/hail|wind and hail|hail|wind)[^\n$]{0,80}(?:deductible)[^\n$]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ]),
    allOtherPerilsDeductible: firstMoney(text, [
      /(?:all other perils|aop)[^\n$]{0,80}(?:deductible)[^\n$]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i
    ])
  });
}

function assessTextQuality(text) {
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasUsefulText = words >= 25;
  return {
    chars,
    words,
    hasUsefulText,
    needsOcr: !hasUsefulText,
    confidence: hasUsefulText ? (words > 200 ? "high" : "medium") : "low"
  };
}

function suggestDocumentUses(type, fields, estimate, coverage, quality) {
  const uses = [];
  if (quality.needsOcr) uses.push("Needs OCR/visual review before relying on this document.");
  if (fields.policyNumber) uses.push("Can support updating/confirming JobNimbus policy number.");
  if (fields.claimNumber) uses.push("Can support updating/confirming JobNimbus claim number.");
  if (fields.dateOfLoss) uses.push("Can support date-of-loss confirmation.");
  if (fields.adjusterEmail || fields.adjusterPhone) uses.push("Can support adjuster contact cleanup.");
  if (Object.keys(estimate).length) uses.push("Can support estimate/payment/appraisal gap review.");
  if (Object.keys(coverage).length) uses.push("Can support coverage/deductible review.");
  if (type === "policy_or_declarations") uses.push("Use to verify active coverage period, named insured, policy number, and deductibles.");
  if (type === "estimate_or_scope") uses.push("Use to summarize scope totals and compare against carrier/payment.");
  return uses;
}

function buildDocumentReviewNotes(type, quality, conflicts) {
  const notes = [];
  if (quality.needsOcr) notes.push("No reliable text was extracted. This is probably scanned/photo-based or image-only.");
  if (conflicts.length) notes.push("Some extracted values conflict with existing JobNimbus fields; do not update without approval.");
  if (type === "unknown_text_document") notes.push("Document type was not confidently classified; review text preview before acting.");
  return notes;
}

function findFieldConflicts(file, fields) {
  const checks = [
    ["policyNumber", "policyNumber", "policy #"],
    ["claimNumber", "claimNumber", "claim #"],
    ["dateOfLoss", "dateOfLoss", "DOL"],
    ["carrier", "carrier", "carrier"]
  ];
  const conflicts = [];
  for (const [fileKey, fieldKey, label] of checks) {
    if (!file[fileKey] || !fields[fieldKey]) continue;
    if (normalizeCompare(file[fileKey]) !== normalizeCompare(fields[fieldKey])) {
      conflicts.push({ field: label, jobNimbus: file[fileKey], document: fields[fieldKey] });
    }
  }
  return conflicts;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/\s{2,}/g, " ");
  }
  return "";
}

function firstMoney(text, patterns) {
  const value = firstMatch(text, patterns);
  return value ? `$${value.replace(/[^\d.,]/g, "")}` : "";
}

function firstDate(text, patterns) {
  const value = firstMatch(text, patterns);
  return value ? value.replace(/\s{2,}/g, " ").trim() : "";
}

function normalizePolicy(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeCompare(value) {
  return stripDiacritics(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeContactLookupQuery(value) {
  const text = String(value || "").trim();
  const labeledNumber = text.match(/^(?:jobnimbus|job|file)(?:\s*(?:number|no\.?|#))?\s*#?\s*(\d+)$/i);
  if (labeledNumber) return labeledNumber[1];
  const hashNumber = text.match(/^#\s*(\d+)$/);
  return hashNumber ? hashNumber[1] : text;
}

function normalizeNameWords(value) {
  return stripDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueDocumentFilenameCandidates(value) {
  const original = String(value || "").trim();
  const ascii = stripDiacritics(original);
  const withoutExtensionSpace = original.replace(/\s+(\.[a-z0-9]+)$/i, "$1");
  const asciiWithoutExtensionSpace = ascii.replace(/\s+(\.[a-z0-9]+)$/i, "$1");
  return [...new Set([original, ascii, withoutExtensionSpace, asciiWithoutExtensionSpace].filter(Boolean))];
}

function extractAddress(text) {
  const match = text.match(/\b\d{2,6}\s+[A-Za-z0-9 .'-]+(?:st|street|rd|road|dr|drive|ave|avenue|ln|lane|ct|court|cir|circle|way|blvd|boulevard|trl|trail|pkwy|parkway)\b[^\n,]*(?:,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s*\d{5})?/i);
  return match ? match[0].trim().replace(/\s{2,}/g, " ") : "";
}

function isInsuranceFile(contact) {
  return String(contact.record_type_name || "").toLowerCase() === "insurance";
}

function assignedTo(contact, ownerId) {
  return (Array.isArray(contact.owners) ? contact.owners : []).some((owner) => String(owner?.id || owner?.jnid || owner) === ownerId);
}

function operatorActionOwnerId(contact) {
  if (!operatorCompanyScopeActive()) return CHANCE_OWNER_ID;
  const ownerId = (Array.isArray(contact?.owners) ? contact.owners : [])
    .map((owner) => String(owner?.id || owner?.jnid || owner || "").trim())
    .find(Boolean);
  if (!ownerId) {
    conflictError(
      "The explicit company file has no verified JobNimbus owner. Assign an owner in JobNimbus before creating a task or calendar event."
    );
  }
  return ownerId;
}

function isOpenActive(contact) {
  const status = String(contact?.status_name || "").trim();
  return !providerFlagFalse(contact?.is_active)
    && !providerFlagTrue(contact?.is_archived)
    && !providerFlagTrue(contact?.is_closed)
    && !providerFlagTrue(contact?.is_deleted)
    && !/\b(closed|cancelled|canceled|archived|dead)\b/i.test(status);
}

function isExplicitlyOpenActive(contact) {
  return providerFlagTrue(contact?.is_active) && isOpenActive(contact);
}

function fileSort(a, b) {
  return Number(b.date_updated || 0) - Number(a.date_updated || 0);
}

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = String(keyFn(row) || "Unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function collectIds(value, ids) {
  if (!value) return;
  if (typeof value === "string") ids.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectIds(v, ids));
  else if (typeof value === "object") {
    if (value.id) ids.push(value.id);
    if (value.jnid) ids.push(value.jnid);
  }
}

function normalizeHandoffPayload(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {
    text: String(input.text || input.summary || input.message || "").trim()
  };
  const source = String(input.source || payload.source || "regular-chat").trim();
  const client = String(input.client || input.query || payload.client || payload.file || payload.name || "").trim();
  if (!client && !JSON.stringify(payload).trim()) badRequest("client or payload is required");
  return { source, client, payload };
}

function buildHandoffAssistantRead({ source, client, payload }) {
  const summary = String(payload.summary || payload.text || payload.message || "").trim();
  const recommendedActions = Array.isArray(payload.recommendedActions)
    ? payload.recommendedActions
    : Array.isArray(payload.recommended_actions)
      ? payload.recommended_actions
      : [];
  const sources = Array.isArray(payload.sources) ? payload.sources : Array.isArray(payload.source) ? payload.source : [source];
  const lines = [
    `Handoff source: ${sources.filter(Boolean).join(", ") || source}`,
    `Client/file: ${client || "unspecified"}`,
    summary ? `Summary: ${summary}` : "",
    payload.issue || payload.bottleneck ? `Issue/bottleneck: ${payload.issue || payload.bottleneck}` : "",
    recommendedActions.length ? `Recommended actions:\n${recommendedActions.map((item, index) => `${index + 1}. ${String(item)}`).join("\n")}` : "",
    payload.needsApproval !== undefined ? `Needs approval: ${Boolean(payload.needsApproval || payload.needs_approval)}` : "",
    `Raw payload: ${JSON.stringify(payload, null, 2)}`
  ].filter(Boolean);
  return lines.join("\n");
}

async function readHandoffStore() {
  try {
    const raw = await readFile(HANDOFF_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeHandoffStore(handoffs) {
  await mkdir(path.dirname(HANDOFF_STORE_PATH), { recursive: true });
  await writeFile(HANDOFF_STORE_PATH, JSON.stringify(handoffs.slice(0, 500), null, 2));
}

async function readArtifactStore() {
  try {
    const raw = await readFile(ARTIFACT_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeArtifactStore(artifacts) {
  await mkdir(path.dirname(ARTIFACT_STORE_PATH), { recursive: true });
  await writeFile(ARTIFACT_STORE_PATH, JSON.stringify(artifacts.slice(0, 200), null, 2));
}

async function pruneExpiredArtifacts() {
  const artifacts = await readArtifactStore();
  const now = Date.now();
  const active = [];
  let changed = false;
  for (const artifact of artifacts) {
    const expiresAt = Date.parse(artifact.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      changed = true;
      await rm(artifactFilePath(artifact.id), { force: true });
    } else {
      active.push(artifact);
    }
  }
  if (changed) await writeArtifactStore(active);
  return active;
}

function artifactFilePath(id) {
  return path.join(ARTIFACT_FILE_DIR, `${normalizeArtifactId(id)}.patch`);
}

function normalizeArtifactId(value) {
  const id = String(value || "").trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) badRequest("artifact id must be a UUID");
  return id;
}

function normalizeArtifactFilename(value) {
  const filename = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,120}\.(patch|diff)$/i.test(filename)) {
    badRequest("filename must be a simple .patch or .diff filename");
  }
  return filename;
}

function normalizeCommitSha(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(sha)) badRequest("baseCommit must be a 7-40 character Git SHA");
  return sha;
}

function normalizeSha256(value) {
  const sha = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) badRequest("sha256 must be a 64-character lowercase SHA-256 digest");
  return sha;
}

function artifactPolicyViolations(content) {
  const violations = new Set();
  const pathPatterns = [
    /^\.env(?:\.|$)/i,
    /^data\//i,
    /^reports\//i,
    /^work\//i,
    /(^|\/)client_secret[^/]*\.json$/i,
    /\.(pem|p12|pfx|key)$/i
  ];
  const patchPaths = [];
  for (const line of content.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffMatch) patchPaths.push(diffMatch[1], diffMatch[2]);
    const fileMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);
    if (fileMatch) patchPaths.push(fileMatch[1]);
  }
  for (const filePath of patchPaths) {
    if (pathPatterns.some((pattern) => pattern.test(filePath))) {
      violations.add(`forbidden path in patch: ${filePath}`);
    }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) violations.add("private key material detected");
  if (/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{20,}\b/.test(content)) {
    violations.add("probable access token detected");
  }
  return [...violations];
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function preparedActionFile(prepared, index = 0) {
  const file = prepared?.plan?.file
    || prepared?.plan?.plan?.fileScope
    || prepared?.plan?.fileScope
    || {};
  const id = String(file.id || "").trim();
  if (!id) {
    badRequest(`The Codex operator could not bind action ${index + 1} to one exact ${operatorFileDescription()}.`);
  }
  return {
    id,
    number: file.number || "",
    name: file.name || ""
  };
}

async function operatorBatchScope(operations, plans, options = {}) {
  if (!isRestrictedEffectRequest()) {
    return {
      mode: "unrestricted_legacy_v1",
      fileCount: 0,
      maxFiles: 0,
      files: [],
      operationFiles: operations.map(() => ({ id: "", number: "", name: "" }))
    };
  }

  const operationFiles = plans.map((prepared, index) => preparedActionFile(prepared, index));
  const orderedFiles = [];
  const filesById = new Map();
  for (const [index, file] of operationFiles.entries()) {
    let entry = filesById.get(file.id);
    if (!entry) {
      entry = {
        ...file,
        operationIndexes: [],
        operationTypes: []
      };
      filesById.set(file.id, entry);
      orderedFiles.push(entry);
    }
    entry.operationIndexes.push(index);
    entry.operationTypes.push(operations[index].type);
  }

  const uniqueFileCount = orderedFiles.length;
  const runPolicy = options.runPolicy || null;
  if (runPolicy?.enforced) {
    for (const file of orderedFiles) {
      if (runPolicy.excludedFileNumbers.includes(String(file.number || "").replace(/^#/, ""))) {
        badRequest(`JobNimbus file #${file.number} is excluded from the ${runPolicy.id} Chance work-file run.`);
      }
      if (!chanceManifestFileBinding(runPolicy.manifest, file.number, file.id)) {
        badRequest(`JobNimbus file #${file.number || file.id} is not bound to the current ${runPolicy.id} 58-file manifest.`);
      }
    }
    for (const [index, operation] of operations.entries()) {
      const requestedFileNumber = String(
        operation.payload?.query || operation.payload?.fileQuery || ""
      ).trim().replace(/^#/, "");
      const resolvedFileNumber = String(operationFiles[index]?.number || "")
        .trim()
        .replace(/^#/, "");
      if (requestedFileNumber !== resolvedFileNumber) {
        badRequest(
          `operations[${index}] query must equal the resolved JobNimbus file number under ${runPolicy.id}; numeric claim or policy lookups are not accepted.`
        );
      }
      if (operation.type !== "jobnimbus.update_contact") continue;
      const fields = plans[index]?.plan?.plan?.fields || {};
      const unsupported = Object.keys(fields).filter((key) => (
        !runPolicy.allowedContactFields.includes(key)
      ));
      if (unsupported.length) {
        badRequest(`The locked Chance run does not allow contact field(s): ${unsupported.join(", ")}.`);
      }
    }
  }
  const macAssignedBatch = isMacCodexOperatorRequest()
    && !operatorCompanyScopeActive()
    && !isHcnRestrictedEffectRequest();
  const maxFiles = macAssignedBatch
    ? CODEX_MAC_ASSIGNED_BATCH_MAX_FILES
    : 1;
  if (uniqueFileCount > maxFiles) {
    if (maxFiles === 1) {
      badRequest(`A Codex operator action batch may contain operations for only one exact ${operatorFileDescription()}.`);
    }
    badRequest(
      `A Mac Codex operator action batch may contain operations for at most ${maxFiles} exact Chance-assigned files.`
    );
  }

  if (uniqueFileCount > 1) {
    for (const [index, operation] of operations.entries()) {
      if (!CODEX_MAC_ASSIGNED_MULTI_FILE_ACTION_TYPES.has(operation.type)) {
        badRequest(
          `Multi-file Mac batches allow only contact corrections, forward stage moves, and current-control tasks; operations[${index}] is ${operation.type}.`
        );
      }
      if (!/^#?\d+$/.test(String(operation.payload?.query || "").trim())) {
        badRequest(`operations[${index}].payload.query must be the exact JobNimbus file number in a multi-file batch.`);
      }
    }

    const closedFileIds = new Set();
    let previousFileId = "";
    for (const file of operationFiles) {
      if (file.id !== previousFileId) {
        if (closedFileIds.has(file.id)) {
          badRequest("Operations for each file must be contiguous in a multi-file batch; A/B/A ordering is not allowed.");
        }
        if (previousFileId) closedFileIds.add(previousFileId);
        previousFileId = file.id;
      }
    }

    for (const file of orderedFiles) {
      const current = await jobNimbus(`/contacts/${encodeURIComponent(file.id)}`);
      assertOperatorContactScope(current);
      if (!isExplicitlyOpenActive(current)) {
        badRequest(`JobNimbus file ${file.number || file.id} is inactive, archived, or closed and cannot enter a multi-file batch.`);
      }
    }
  }

  if (uniqueFileCount > 1 || runPolicy?.enforced) {
    for (const file of orderedFiles) {
      const typeCounts = file.operationTypes.reduce((counts, type) => {
        counts[type] = (counts[type] || 0) + 1;
        return counts;
      }, {});
      if (
        Number(typeCounts["jobnimbus.update_contact"] || 0) > 1
        || Number(typeCounts["jobnimbus.update_status"] || 0) > 1
        || Number(typeCounts["jobnimbus.ensure_current_task"] || 0) > 1
      ) {
        badRequest("A batch may contain at most one contact update, one status update, and one current-control task per file.");
      }
      const actionOrder = {
        "jobnimbus.update_contact": 1,
        "jobnimbus.update_status": 2,
        "jobnimbus.ensure_current_task": 3
      };
      for (let index = 1; index < file.operationTypes.length; index += 1) {
        if (actionOrder[file.operationTypes[index]] < actionOrder[file.operationTypes[index - 1]]) {
          badRequest("Per-file multi-file operations must be ordered contact update, status move, then current-control task.");
        }
      }
    }
  }

  return {
    mode: uniqueFileCount > 1
      ? "assigned_multi_v1"
      : operatorCompanyScopeActive()
        ? "company_single_file_v1"
        : "assigned_single_file_v2",
    fileCount: uniqueFileCount,
    maxFiles,
    runPolicyId: runPolicy?.id || "",
    runPolicySha256: runPolicy?.sha256 || "",
    runPolicyExpiresAt: runPolicy?.expiresAt || "",
    files: orderedFiles,
    operationFiles
  };
}

async function readSecurityLedger(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    const unavailable = new Error(`${label} is unavailable. Stop and review before retrying.`);
    unavailable.statusCode = 503;
    throw unavailable;
  }
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    const corrupt = new Error(`${label} is corrupted. Stop and review before retrying.`);
    corrupt.statusCode = 503;
    throw corrupt;
  }
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    const invalid = new Error(`${label} has an invalid structure. Stop and review before retrying.`);
    invalid.statusCode = 503;
    throw invalid;
  }
  return rows;
}

async function writeSecurityLedger(filePath, rows) {
  if (!Array.isArray(rows)) throw new TypeError("Security ledger rows must be an array.");
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function actionBatchOperationDescriptors(row) {
  const operationCount = Number(row?.operationCount || 0);
  if (!Number.isSafeInteger(operationCount) || operationCount < 1 || operationCount > 15) return null;
  const descriptors = Array.from({ length: operationCount }, (_, index) => ({ index }));
  for (const file of Array.isArray(row?.files) ? row.files : []) {
    const indexes = Array.isArray(file?.operationIndexes) ? file.operationIndexes : [];
    const types = Array.isArray(file?.operationTypes) ? file.operationTypes : [];
    if (indexes.length !== types.length) return null;
    for (let offset = 0; offset < indexes.length; offset += 1) {
      const index = Number(indexes[offset]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= operationCount) return null;
      if (descriptors[index].type) return null;
      descriptors[index] = {
        index,
        type: String(types[offset] || ""),
        fileId: String(file.id || ""),
        fileNumber: String(file.number || "")
      };
    }
  }
  return descriptors.every((descriptor) => descriptor.type && descriptor.fileId)
    ? descriptors
    : null;
}

function validatedActionBatchFileScope(row) {
  const files = Array.isArray(row?.files) ? row.files : [];
  if (!files.length) return [];
  const seenIds = new Set();
  const seenNumbers = new Set();
  const normalized = [];
  for (const file of files) {
    const id = String(file?.id || "").trim();
    const number = String(file?.number || "").trim().replace(/^#/, "");
    if (
      !/^[a-zA-Z0-9_-]{8,100}$/.test(id)
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(number)
      || seenIds.has(id)
      || seenNumbers.has(number)
    ) return [];
    seenIds.add(id);
    seenNumbers.add(number);
    normalized.push({ id, number });
  }
  return normalized;
}

function validatedQuarantineFileScope(row) {
  const normalized = validatedActionBatchFileScope(row);
  if (
    CHANCE_OPERATOR_RUN_MANIFEST
    && normalized.some(
      (file) => !chanceManifestFileBinding(
        CHANCE_OPERATOR_RUN_MANIFEST,
        file.number,
        file.id
      )
    )
  ) return [];
  return normalized;
}

function actionBatchResourceLockScope(row) {
  const files = validatedActionBatchFileScope(row);
  if (!files.length) return { global: true, files: [] };

  const runPolicyId = String(row?.runPolicyId || "").trim();
  const runPolicySha256 = String(row?.runPolicySha256 || "").trim().toLowerCase();
  if (runPolicyId || runPolicySha256) {
    if (
      !CHANCE_OPERATOR_RUN_MANIFEST
      || runPolicyId !== CHANCE_OPERATOR_RUN_MANIFEST.id
      || runPolicySha256 !== CHANCE_OPERATOR_RUN_MANIFEST.sha256
      || files.some(
        (file) => !chanceManifestFileBinding(
          CHANCE_OPERATOR_RUN_MANIFEST,
          file.number,
          file.id
        )
      )
    ) return { global: true, files: [] };
  }

  const status = String(row?.status || "");
  if (
    ["manual_quarantined", "legacy_quarantined"].includes(status)
    && row?.recovery?.fileScopedQuarantine !== true
  ) return { global: true, files: [] };

  if (status === "manual_quarantined") {
    const manualIds = [...new Set(
      (Array.isArray(row?.manualQuarantine?.fileIds)
        ? row.manualQuarantine.fileIds
        : [row?.manualQuarantine?.fileId || ""])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    const byId = new Map(files.map((file) => [file.id, file]));
    if (!manualIds.length || manualIds.some((id) => !byId.has(id))) {
      return { global: true, files: [] };
    }
    return { global: false, files: manualIds.map((id) => byId.get(id)) };
  }

  return { global: false, files };
}

function actionBatchTerminalStatus(completed = []) {
  return completed.some((item) => item?.receipt?.manualVerificationRequired === true)
    ? "completed_pending_verification"
    : "completed";
}

function recoveredNotAttempted(descriptors, completedIndexes, currentIndex = -1) {
  return descriptors
    .filter((descriptor) => !completedIndexes.has(descriptor.index) && descriptor.index !== currentIndex)
    .map((descriptor) => ({ ...descriptor, status: "not_attempted" }));
}

function validActionBatchIntent(row, descriptor) {
  if (!descriptor) return null;
  const intent = (Array.isArray(row?.intents) ? row.intents : []).find((item) => (
    Number(item?.index) === Number(descriptor.index)
  ));
  if (
    !intent
    || String(intent.type || "") !== String(descriptor.type || "")
    || String(intent.fileId || "") !== String(descriptor.fileId || "")
    || String(intent.fileNumber || "") !== String(descriptor.fileNumber || "")
    || !intent.reconciliation
    || typeof intent.reconciliation !== "object"
    || Array.isArray(intent.reconciliation)
  ) return null;
  const stable = {
    index: Number(intent.index),
    type: String(intent.type),
    fileId: String(intent.fileId),
    fileNumber: String(intent.fileNumber),
    reconciliation: intent.reconciliation
  };
  return digest({ version: 1, stable }) === String(intent.intentDigest || "")
    ? intent
    : null;
}

async function initializeOperatorReceiptBoundary() {
  const recoveredAt = new Date().toISOString();
  try {
    const approvals = await readSecurityLedger(ACTION_APPROVAL_STORE_PATH, "Action approval ledger");
    const batches = await readSecurityLedger(ACTION_BATCH_STORE_PATH, "Action batch ledger");
    const outbound = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
    let approvalsChanged = false;
    let batchesChanged = false;
    let outboundChanged = false;
    const now = Date.now();

    for (const row of approvals) {
      if (row.status !== "active") continue;
      if (Number(row.expiresAtMs || 0) <= now) {
        row.status = "expired";
        row.expiredAt = recoveredAt;
      } else {
        row.status = "revoked";
        row.revokedAt = recoveredAt;
        row.revokedReason = "bridge_restart";
      }
      approvalsChanged = true;
    }

    for (const row of batches) {
      if (row.status !== "in_progress" && !row.current) continue;
      row.bootIdRecoveredFrom = String(row.bootId || "");
      row.recoveredAt = recoveredAt;
      row.updatedAt = recoveredAt;
      if (!validActionBatchPrincipalHash(row.principalHash)) {
        row.status = "legacy_quarantined";
        delete row.current;
        row.recovery = {
          interrupted: true,
          phase: "legacy_principal_unbound",
          reasonCode: "legacy_principal_unbound",
          fileScopedQuarantine: false,
          quarantinedFileIds: [],
          automaticRetryAllowed: false,
          freshApprovalRequired: true,
          recoveredAt
        };
        batchesChanged = true;
        continue;
      }
      const descriptors = actionBatchOperationDescriptors(row);
      const completed = Array.isArray(row.completed) ? row.completed : [];
      const completedIndexes = new Set(completed.map((item) => Number(item?.index)));
      const validCompleted = descriptors
        && completed.every((item) => (
          Number.isSafeInteger(Number(item?.index))
          && descriptors[Number(item.index)]?.type === String(item.type || "")
        ))
        && completedIndexes.size === completed.length;
      if (!descriptors || !validCompleted) {
        const quarantinedFiles = validatedQuarantineFileScope(row);
        row.status = "legacy_quarantined";
        delete row.current;
        row.recovery = {
          interrupted: true,
          phase: "invalid_or_legacy_manifest",
          reasonCode: "legacy_manifest_incomplete",
          fileScopedQuarantine: quarantinedFiles.length > 0,
          quarantinedFileIds: quarantinedFiles.map((file) => file.id),
          automaticRetryAllowed: false,
          freshApprovalRequired: true,
          recoveredAt
        };
      } else if (row.current) {
        const currentIndex = Number(row.current.index);
        const currentDescriptor = descriptors[currentIndex];
        const currentIntent = validActionBatchIntent(row, currentDescriptor);
        if (!currentIntent) {
          const quarantinedFiles = validatedQuarantineFileScope(row);
          row.status = "legacy_quarantined";
          row.notAttempted = recoveredNotAttempted(descriptors, completedIndexes, currentIndex);
          row.recovery = {
            interrupted: true,
            phase: "provider_window_missing_immutable_intent",
            reasonCode: "legacy_intent_unavailable",
            fileScopedQuarantine: quarantinedFiles.length > 0,
            quarantinedFileIds: quarantinedFiles.map((file) => file.id),
            automaticRetryAllowed: false,
            freshApprovalRequired: true,
            recoveredAt
          };
          delete row.current;
        } else {
          row.status = "reconciliation_required";
          row.current = {
            ...currentDescriptor,
            ...row.current,
            status: "reconciliation_required",
            reasonCode: "bridge_restart_during_provider_window",
            reason: "The bridge restarted after this operation entered its provider window. Fresh-read this exact file before any retry."
          };
          row.notAttempted = recoveredNotAttempted(descriptors, completedIndexes, currentIndex);
          row.recovery = {
            interrupted: true,
            phase: "provider_window",
            unknownOperationIndexes: [currentIndex],
            automaticRetryAllowed: false,
            freshApprovalRequired: true,
            recoveredAt
          };
        }
      } else if (completed.length === descriptors.length) {
        row.status = actionBatchTerminalStatus(completed);
        row.notAttempted = [];
        row.completedAt = row.completedAt || recoveredAt;
        row.recovery = {
          interrupted: true,
          phase: "after_final_receipt",
          unknownOperationIndexes: [],
          automaticRetryAllowed: false,
          freshApprovalRequired: false,
          recoveredAt
        };
      } else {
        row.status = "partial_failure";
        row.notAttempted = recoveredNotAttempted(descriptors, completedIndexes);
        row.recovery = {
          interrupted: true,
          phase: completed.length ? "between_operations" : "before_first_operation",
          unknownOperationIndexes: [],
          automaticRetryAllowed: false,
          freshApprovalRequired: true,
          recoveredAt
        };
      }
      batchesChanged = true;
    }

    for (const row of outbound) {
      if (row.status !== "in_progress") continue;
      row.status = "reconciliation_required";
      row.reasonCode = "bridge_restart_during_provider_window";
      row.updatedAt = recoveredAt;
      row.recoveredAt = recoveredAt;
      outboundChanged = true;
    }

    if (approvalsChanged) await writeSecurityLedger(ACTION_APPROVAL_STORE_PATH, approvals);
    if (batchesChanged) await writeActionBatchLedger(batches);
    if (outboundChanged) await writeSecurityLedger(OUTBOUND_SEND_STORE_PATH, outbound);
    ACTION_RECEIPT_RECOVERY_STATE.status = "ready";
    ACTION_RECEIPT_RECOVERY_STATE.lastStartupRecoveryAt = recoveredAt;
    ACTION_RECEIPT_RECOVERY_STATE.error = "";
  } catch (error) {
    ACTION_RECEIPT_RECOVERY_STATE.status = "blocked";
    ACTION_RECEIPT_RECOVERY_STATE.lastStartupRecoveryAt = recoveredAt;
    ACTION_RECEIPT_RECOVERY_STATE.error = redactSensitiveText(error?.message || String(error));
  }
}

function assertOperatorReceiptBoundaryReady() {
  if (ACTION_RECEIPT_RECOVERY_STATE.status === "ready") return;
  const error = new Error("The operator receipt recovery boundary is not ready. Read-only file review remains available; no action may be planned or executed.");
  error.statusCode = 503;
  throw error;
}

function normalizeUploadId(value) {
  const uploadId = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(uploadId)) badRequest("uploadId may only contain letters, numbers, underscore, or hyphen");
  return uploadId;
}

async function findHandoffById(id) {
  const handoffs = await readHandoffStore();
  const handoff = handoffs.find((row) => row.id === id);
  if (!handoff) badRequest(`No handoff found for id: ${id}`);
  return handoff;
}

function extractHandoffJobNimbusUpdate(handoff, input = {}) {
  const payload = handoff?.payload && typeof handoff.payload === "object" ? handoff.payload : {};
  const update = payload.jobNimbusUpdate || payload.jobNimbus_update || payload.jobnimbusUpdate;
  const directUpdate = payload.query || payload.fields || payload.status || payload.note
    ? {
        query: payload.query,
        fields: payload.fields,
        status: payload.status,
        note: payload.note,
        execute: payload.execute
      }
    : null;
  const selected = update && typeof update === "object" ? update : directUpdate;
  if (!selected) return null;
  return cleanObject({
    ...selected,
    query: input.query || selected.query || selected.job || selected.client || handoff.client,
    fields: input.fields || selected.fields,
    status: input.status || input.statusName || input.workflowStatus || selected.status || selected.statusName || selected.workflowStatus,
    note: input.note || input.internalNote || selected.note || selected.internalNote,
    execute: input.execute === true || selected.execute === true
  });
}

async function markHandoffComplete(id, completionNote = "") {
  const handoffs = await readHandoffStore();
  const handoff = handoffs.find((row) => row.id === id);
  if (!handoff) badRequest(`No handoff found for id: ${id}`);
  handoff.status = "completed";
  handoff.completedAt = new Date().toISOString();
  handoff.updatedAt = handoff.completedAt;
  handoff.completionNote = completionNote;
  await writeHandoffStore(handoffs);
  return handoff;
}

async function hcnJobNimbus(endpoint, options = {}) {
  if (!API_KEY) {
    const error = new Error("Fresh JobNimbus evidence is unavailable.");
    error.statusCode = 503;
    throw error;
  }
  return fetchBoundedJson(
    fetch,
    `${API_BASE}${endpoint}`,
    {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    },
    {
      timeoutMs: 15_000,
      maxBytes: 16 * 1024 * 1024,
      errorCode: "HCN_JOBNIMBUS_READ_FAILED"
    }
  );
}

async function hcnGmailApi(endpoint, options = {}) {
  if (!googleAccessConfiguredForRequest()) {
    throw new Error("Gmail evidence is unavailable.");
  }
  const token = await getGoogleAccessToken();
  return fetchBoundedJson(
    fetch,
    `${GMAIL_API_BASE_URL}${endpoint}`,
    {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    },
    {
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
      errorCode: "HCN_GMAIL_READ_FAILED"
    }
  );
}

async function jobNimbus(endpoint, options = {}) {
  if (!API_KEY) badRequest("JOBNIMBUS_API_KEY is not configured.");
  if (isHcnRestrictedEffectRequest()) {
    return fetchBoundedJson(
      fetch,
      `${API_BASE}${endpoint}`,
      {
        method: options.method || "GET",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      },
      {
        timeoutMs: 15_000,
        maxBytes: 16 * 1024 * 1024,
        errorCode: "HCN_JOBNIMBUS_EFFECT_FAILED"
      }
    );
  }
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    const error = new Error(`JobNimbus API ${response.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function jobNimbusFileApi(endpoint, options = {}) {
  if (!API_KEY) badRequest("JOBNIMBUS_API_KEY is not configured.");
  const response = await fetch(`https://api.jobnimbus.com${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    const error = new Error(`JobNimbus Files API ${response.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function gmailApi(endpoint, options = {}) {
  if (!googleAccessConfiguredForRequest()) {
    badRequest("Gmail is not configured for the signed-in employee or the legacy Chance connection.");
  }
  const token = await getGoogleAccessToken();
  const response = await fetch(`${GMAIL_API_BASE_URL}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!response.ok) {
    const error = new Error(`Gmail API ${response.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    error.statusCode = response.status;
    throw error;
  }
  return json;
}

async function getGoogleAccessToken() {
  const userToken = requestGoogleAccessToken();
  if (userToken) return userToken;
  const result = await fetchBoundedProviderJson(
    fetch,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token"
      })
    }
  );
  const response = result.response;
  const json = result.payload;
  if (!response.ok || !json.access_token) {
    const error = new Error(
      `Google OAuth token refresh failed with HTTP ${response.status}.`
    );
    error.statusCode = response.status;
    throw error;
  }
  return json.access_token;
}

function compactGmailMessage(message) {
  const headers = gmailHeaders(message);
  return {
    id: message.id || "",
    threadId: message.threadId || "",
    historyId: message.historyId || "",
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.map((label) => String(label || "")).filter(Boolean)
      : [],
    internalDate: message.internalDate || "",
    date: headers.date || "",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    subject: headers.subject || "",
    snippet: message.snippet || ""
  };
}

function compactGmailFullMessage(message) {
  return {
    ...compactGmailMessage(message),
    plainText: extractGmailBody(message.payload, "text/plain").slice(0, 12000),
    htmlText: stripHtml(extractGmailBody(message.payload, "text/html")).slice(0, 6000),
    attachments: listGmailAttachments(message.payload)
  };
}

function compactGmailDraft(draft) {
  return {
    id: draft.id || "",
    message: draft.message ? compactGmailMessage(draft.message) : null
  };
}

function gmailHeaders(message) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const out = {};
  for (const header of headers) {
    const key = String(header.name || "").toLowerCase();
    if (["from", "to", "cc", "bcc", "subject", "date"].includes(key)) out[key] = header.value || "";
  }
  return out;
}

function gmailDeliveryHeaders(message) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const relevant = new Set(["from", "sender", "reply-to", "to", "cc", "bcc", "subject"]);
  const values = new Map();
  for (const header of headers) {
    const key = String(header.name || "").trim().toLowerCase();
    if (key.startsWith("resent-")) {
      badRequest(`Gmail draft contains unsupported delivery header: ${key}.`);
    }
    if (!relevant.has(key)) continue;
    const rows = values.get(key) || [];
    rows.push(String(header.value || ""));
    values.set(key, rows);
  }
  for (const [key, rows] of values) {
    if (rows.length > 1) badRequest(`Gmail draft contains duplicate delivery header: ${key}.`);
  }
  const value = (key) => values.get(key)?.[0] || "";
  return {
    from: validateEmailAddressList(value("from"), "From"),
    sender: validateEmailAddressList(value("sender"), "Sender"),
    "reply-to": validateEmailAddressList(value("reply-to"), "Reply-To"),
    to: validateEmailAddressList(value("to"), "To", { required: true }),
    cc: validateEmailAddressList(value("cc"), "Cc"),
    bcc: validateEmailAddressList(value("bcc"), "Bcc"),
    subject: validateEmailHeaderValue(value("subject"), "Subject")
  };
}

function groupGmailMessagesByThread(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!map.has(message.threadId)) {
      map.set(message.threadId, {
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        date: message.date,
        latestSnippet: message.snippet,
        messageIds: []
      });
    }
    map.get(message.threadId).messageIds.push(message.id);
  }
  return [...map.values()];
}

function buildGmailAssistantRead(messages) {
  const latest = messages[messages.length - 1] || {};
  const combined = messages
    .map((message) => `From: ${message.from}\nDate: ${message.date}\nSubject: ${message.subject}\n${message.plainText || message.htmlText || message.snippet}`)
    .join("\n\n---\n\n");
  return {
    latestFrom: latest.from || "",
    latestDate: latest.date || "",
    latestSubject: latest.subject || "",
    possibleClaimNumbers: uniqueMatches(combined, /\b(?:claim(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*)?([A-Z0-9]{2,4}[- ]?[A-Z0-9]{3,6}[- ]?[A-Z0-9]{2,6})\b/gi, 1).slice(0, 10),
    possiblePolicyNumbers: uniqueMatches(combined, /\b(?:policy(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*)?([A-Z0-9][A-Z0-9 -]{5,40})\b/gi, 1).slice(0, 10),
    emails: uniqueMatches(combined, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, 1).slice(0, 20),
    phones: uniqueMatches(combined, /(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g, 1).slice(0, 20),
    attachmentCount: messages.reduce((sum, message) => sum + message.attachments.length, 0)
  };
}

function extractGmailBody(part, mimeType) {
  if (!part) return "";
  const chunks = [];
  walkGmailParts(part, (item) => {
    if (item.mimeType === mimeType && item.body?.data) chunks.push(base64UrlDecode(item.body.data));
  });
  return cleanExtractedText(chunks.join("\n\n"));
}

function listGmailAttachments(part) {
  const attachments = [];
  walkGmailParts(part, (item) => {
    if (item.filename && item.body?.attachmentId) {
      attachments.push({
        filename: item.filename,
        mimeType: item.mimeType || "",
        attachmentId: item.body.attachmentId,
        size: item.body.size || 0
      });
    }
  });
  return attachments;
}

function walkGmailParts(part, visitor) {
  visitor(part);
  for (const child of Array.isArray(part.parts) ? part.parts : []) walkGmailParts(child, visitor);
}

async function loadEmailAttachments(input = {}) {
  const specs = Array.isArray(input.attachments) ? input.attachments : [];
  if (specs.length > 8) badRequest("A Gmail message may include at most 8 attachments through this bridge.");
  const isOperator = currentRequestIdentity()?.type === "codex_operator_token";
  const operatorFile = input?.[INTERNAL_GMAIL_ACTION_SCOPE]?.file || null;
  if (isOperator && !operatorFile?.id) {
    operatorScopeError("The Codex operator requires an internally verified top-level file before loading Gmail attachments.");
  }
  const attachments = [];
  for (const [index, spec] of specs.entries()) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) badRequest(`attachments[${index}] must be an object`);
    const source = String(spec.source || (spec.contentBase64 ? "base64" : "jobnimbus")).trim().toLowerCase();
    if (source === "jobnimbus") {
      const query = required(spec.query || input.query || input.fileQuery, `attachments[${index}].query`);
      const { contact } = await findChanceContact(query);
      const sourceFile = compactContact(contact);
      assertOperatorAttachmentFile(operatorFile, sourceFile, index);
      const documents = await listRelated("/files", contact.jnid, 1000);
      const documentQuery = String(spec.documentQuery || spec.documentId || "").trim();
      const document = isOperator
        ? selectDocumentForChat(documents, documentQuery)
        : selectDocument(documents, documentQuery);
      if (!document) badRequest(`No matching JobNimbus document found for attachment ${index + 1}.`);
      const downloaded = await downloadJobNimbusFile(document);
      attachments.push(validateEmailAttachment({
        filename: spec.filename || compactDocument(document).name || `attachment-${index + 1}`,
        contentType: spec.contentType || downloaded.contentType || "application/octet-stream",
        bytes: downloaded.bytes,
        source,
        sourceId: document.jnid || document.id || "",
        sourceFileId: sourceFile.id,
        sourceFileNumber: sourceFile.number,
        sourceFileName: sourceFile.name
      }));
      continue;
    }
    if (source === "generated_lor") {
      const query = required(spec.query || input.query || input.fileQuery, `attachments[${index}].query`);
      const { contact } = await findChanceContact(query);
      const file = compactContact(contact);
      assertOperatorAttachmentFile(operatorFile, file, index);
      const insured = String(spec.insuredName || file.name || "").trim();
      const carrier = String(spec.carrier || file.carrier || "").trim();
      const claimNumber = String(spec.claimNumber || file.claimNumber || input.subject || "").trim();
      const dateOfLoss = formatLorDate(spec.dateOfLoss || file.dateOfLoss);
      const letterDate = formatLorDate(spec.letterDate || new Date().toISOString().slice(0, 10));
      const addressLine1 = String(contact.address_line1 || "").trim();
      const addressLine2 = [contact.city, contact.state_text, contact.zip].filter(Boolean).join(", ").replace(/, (\d{5}(?:-\d{4})?)$/, " $1");
      const bytes = await createLorPdf({
        insured,
        carrier,
        addressLine1,
        addressLine2,
        dateOfLoss,
        claimNumber,
        letterDate
      });
      attachments.push(validateEmailAttachment({
        filename: spec.filename || `${filenameToken(insured)}_LOR_${filenameToken(claimNumber)}.pdf`,
        contentType: "application/pdf",
        bytes,
        source,
        insuredName: insured,
        carrier,
        claimNumber,
        dateOfLoss,
        letterDate,
        sourceFileId: file.id,
        sourceFileNumber: file.number,
        sourceFileName: file.name
      }));
      continue;
    }
    if (source === "standard_w9") {
      const attachment = await loadStandardW9Attachment();
      attachments.push(validateEmailAttachment({
        ...attachment,
        filename: spec.filename || attachment.filename,
        source,
        sourceLabel: "Verified Wave company W-9"
      }));
      continue;
    }
    if (source === "base64") {
      if (isOperator) {
        badRequest("The Codex operator cannot attach arbitrary base64 content. Use an exact JobNimbus document, generated LOR, or verified standard W-9.");
      }
      const contentBase64 = required(spec.contentBase64, `attachments[${index}].contentBase64`).replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) badRequest(`attachments[${index}].contentBase64 is not valid base64`);
      attachments.push(validateEmailAttachment({
        filename: required(spec.filename, `attachments[${index}].filename`),
        contentType: spec.contentType || "application/octet-stream",
        bytes: Buffer.from(contentBase64, "base64"),
        source
      }));
      continue;
    }
    badRequest(`Unsupported Gmail attachment source: ${source}`);
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0);
  if (totalBytes > 20 * 1024 * 1024) badRequest("Verified Gmail attachments exceed the bridge's 20 MB total limit.");
  return attachments;
}

function assertOperatorAttachmentFile(operatorFile, sourceFile, index) {
  if (!operatorFile) return;
  if (String(sourceFile?.id || "") !== String(operatorFile.id || "")) {
    operatorScopeError(`Gmail attachment ${index + 1} resolves to a different ${operatorShortFileDescription()} than the approved top-level query.`);
  }
}

async function loadStandardW9Attachment() {
  if (
    !STANDARD_W9_GMAIL_MESSAGE_ID
    || !STANDARD_W9_GMAIL_ATTACHMENT_ID
    || !/^[a-f0-9]{64}$/.test(STANDARD_W9_SHA256)
  ) {
    badRequest("The standard Wave W-9 is not pinned. Configure its exact Gmail message id, attachment id, and SHA-256 before using source=standard_w9.");
  }
  const message = await gmailApi(
    `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(STANDARD_W9_GMAIL_MESSAGE_ID)}?format=full`
  );
  const match = listGmailAttachments(message?.payload).find((attachment) => (
    String(attachment.attachmentId || "") === STANDARD_W9_GMAIL_ATTACHMENT_ID
  ));
  if (!match) {
    badRequest("The pinned standard Wave W-9 attachment id is not present in its configured Gmail message.");
  }
  const payload = await gmailApi(
    `/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(STANDARD_W9_GMAIL_MESSAGE_ID)}/attachments/${encodeURIComponent(STANDARD_W9_GMAIL_ATTACHMENT_ID)}`
  );
  const bytes = base64UrlToBuffer(payload?.data || "");
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== STANDARD_W9_SHA256) {
    const error = new Error("The pinned standard Wave W-9 SHA-256 does not match. Nothing was drafted or sent; re-verify the company document through an approved credential-safe process.");
    error.statusCode = 409;
    throw error;
  }
  return {
    filename: "Wave_W-9.pdf",
    contentType: match.mimeType || "application/pdf",
    bytes,
    sha256: actualSha256,
    sourceId: `${STANDARD_W9_GMAIL_MESSAGE_ID}:${STANDARD_W9_GMAIL_ATTACHMENT_ID}`
  };
}

function formatLorDate(value) {
  const iso = isoDateFromClaimValue(value);
  if (!iso) return String(value || "").trim();
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function filenameToken(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "document";
}

function validateEmailHeaderValue(value, label) {
  const text = String(value || "").trim();
  if (!text) badRequest(`${label} is required`);
  if (/[\r\n\x00-\x1F\x7F]/.test(text)) {
    badRequest(`${label} contains a prohibited email-header control character.`);
  }
  if (text.length > 998) badRequest(`${label} is too long.`);
  return text;
}

function validateEmailAddressList(value, label, options = {}) {
  const text = String(value || "").trim();
  if (!text) {
    if (options.required) badRequest(`${label} is required`);
    return "";
  }
  validateEmailHeaderValue(text, label);
  const entries = text.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) badRequest(`${label} contains an empty recipient.`);
  const canonical = [];
  for (const entry of entries) {
    const angleMatch = /^([\p{L}\p{N}][\p{L}\p{N} .'-]{0,199})\s*<([^<>\s]+)>$/u.exec(entry);
    const addrSpec = angleMatch ? angleMatch[2] : entry;
    if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*$/i.test(addrSpec)) {
      badRequest(`${label} contains an invalid email address.`);
    }
    canonical.push(angleMatch
      ? `${angleMatch[1].replace(/\s+/g, " ").trim()} <${addrSpec}>`
      : addrSpec);
  }
  return canonical.join(", ");
}

function validateEmailAttachment(attachment) {
  const filename = safeMimeFilename(attachment.filename);
  const bytes = Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes || []);
  if (!bytes.length) badRequest(`Attachment ${filename} is empty; refusing to draft or send.`);
  const contentType = String(attachment.contentType || "application/octet-stream").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
    badRequest(`Attachment ${filename} has an invalid content type.`);
  }
  const isPdf = contentType === "application/pdf" || /\.pdf$/i.test(filename);
  if (isPdf) {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      badRequest(`Attachment ${filename} is labeled as a PDF but has no PDF header.`);
    }
    const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
    if (!tail.includes("%%EOF")) {
      badRequest(`Attachment ${filename} is missing the PDF end marker; refusing a possibly truncated document.`);
    }
  }
  return { ...attachment, filename, contentType, bytes };
}

function emailAttachmentDescriptor(attachment, source = "") {
  return cleanObject({
    filename: attachment.filename,
    contentType: attachment.contentType,
    bytes: attachment.bytes.length,
    sha256: createHash("sha256").update(attachment.bytes).digest("hex"),
    source,
    sourceId: attachment.sourceId || "",
    sourceFileId: attachment.sourceFileId || "",
    sourceFile: attachment.sourceFileId ? {
      id: attachment.sourceFileId,
      number: attachment.sourceFileNumber || "",
      name: attachment.sourceFileName || ""
    } : undefined,
    sourceLabel: attachment.sourceLabel || "",
    generatedFacts: attachment.source === "generated_lor" || source === "generated_lor" ? {
      insuredName: attachment.insuredName || "",
      carrier: attachment.carrier || "",
      claimNumber: attachment.claimNumber || "",
      dateOfLoss: attachment.dateOfLoss || "",
      letterDate: attachment.letterDate || ""
    } : undefined
  });
}

function buildRawEmail({ from = "", sender = "", replyTo = "", to, cc, bcc, subject, body, attachments = [] }) {
  if (attachments.length) {
    return buildMultipartRawEmail({ from, sender, replyTo, to, cc, bcc, subject, body, attachments });
  }
  const headers = [
    from ? `From: ${from}` : "",
    sender ? `Sender: ${sender}` : "",
    replyTo ? `Reply-To: ${replyTo}` : "",
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ].filter(Boolean);
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function buildMultipartRawEmail({ from = "", sender = "", replyTo = "", to, cc, bcc, subject, body, attachments }) {
  const checked = attachments.map(validateEmailAttachment);
  const boundary = `wave_mixed_${Date.now()}_${randomUUID().replace(/-/g, "")}`;
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body
  ];
  for (const attachment of checked) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      wrapBase64(attachment.bytes)
    );
  }
  parts.push(`--${boundary}--`, "");
  const headers = [
    from ? `From: ${from}` : "",
    sender ? `Sender: ${sender}` : "",
    replyTo ? `Reply-To: ${replyTo}` : "",
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].filter(Boolean);
  const rawText = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  for (const attachment of checked) {
    if (!rawText.includes(`filename="${attachment.filename}"`) || !rawText.includes(wrapBase64(attachment.bytes))) {
      badRequest(`MIME verification failed for attachment ${attachment.filename}.`);
    }
  }
  return base64UrlEncode(rawText);
}

function wrapBase64(bytes) {
  return Buffer.from(bytes).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function safeMimeFilename(value) {
  const clean = path.basename(String(value || "attachment"))
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return clean || "attachment";
}

function encodeHeaderWord(value) {
  const text = String(value || "");
  return /^[\x00-\x7F]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function base64UrlToBuffer(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function uniqueMatches(text, pattern, group = 0) {
  const seen = new Set();
  const out = [];
  for (const match of String(text || "").matchAll(pattern)) {
    const value = String(match[group] || "").trim();
    const key = normalizeCompare(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function contactMatches(contact, query) {
  const haystack = [
    contact.jnid,
    contact.id,
    contact.number,
    contact.recid,
    contact.display_name,
    contact.name,
    contact.description,
    contact.first_name,
    contact.last_name,
    contact.email,
    contact.home_phone,
    contact.mobile_phone,
    contact.work_phone,
    contact.address_line1,
    contact.city,
    contact.state_text,
    contact.zip,
    contact.cf_string_1,
    contact.cf_string_2,
    contact.cf_string_4,
    contact["Insurance Company"],
    contact["Claim #"],
    contact["Policy #"]
  ].filter(Boolean).join(" ").toLowerCase();
  const fullRecord = safeStringify(contact).toLowerCase();
  return haystack.includes(query) || fullRecord.includes(query);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

function fieldValue(record, names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== "") return record[name];
  }
  const lowerMap = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lowerMap.get(String(name).toLowerCase());
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function compactContact(contact) {
  return {
    id: contact.jnid || contact.id,
    number: contact.number || String(contact.recid || ""),
    name: contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    status: contact.status_name || "",
    address: [contact.address_line1, contact.city, contact.state_text, contact.zip].filter(Boolean).join(", "),
    phone: contact.mobile_phone || contact.home_phone || contact.work_phone || "",
    email: contact.email || "",
    carrier: fieldValue(contact, ["Insurance Company", "Carrier", "insurance_company", "cf_string_1"]),
    claimNumber: fieldValue(contact, ["Claim #", "Claim Number", "claim_number", "cf_string_10", "cf_string_2"]),
    policyNumber: fieldValue(contact, ["Policy #", "Policy Number", "policy_number", "cf_string_4", "cf_string_3"]),
    typeOfLoss: fieldValue(contact, ["Type Of Loss", "Type of Loss", "Cause of Loss", "cf_string_5"]),
    dateOfLoss: fieldValue(contact, ["Date of Loss", "DOL", "cf_date_1"]),
    adjusterName: fieldValue(contact, ["Carrier DA", "Carrier Adjuster", "Adjuster", "cf_string_7"]),
    adjusterPhone: fieldValue(contact, ["Carrier DA Contact #", "Adjuster Phone", "cf_string_8"]),
    adjusterEmail: fieldValue(contact, ["Carrier DA Email", "Adjuster Email", "cf_string_9"])
  };
}

function chanceOperatorContactAllowed(contact) {
  if (!isMacCodexOperatorRequest() || operatorCompanyScopeActive()) return true;
  const number = String(contact?.number || contact?.recid || "").trim().replace(/^#/, "");
  if (CHANCE_OPERATOR_EXCLUDED_FILES.has(number)) return false;
  if (CHANCE_OPERATOR_RUN_MANIFEST) {
    return Boolean(chanceManifestFileBinding(
      CHANCE_OPERATOR_RUN_MANIFEST,
      number,
      contact?.jnid || contact?.id
    ));
  }
  return !REQUIRE_CHANCE_RUN_POLICY;
}

const HCN_CONTACT_PHONE_KEYS = new Set([
  "adjusterphone",
  "carrierdacontact",
  "cellphone",
  "cfstring8",
  "homephone",
  "mobilephone",
  "phone",
  "phone1",
  "phone2",
  "phone3",
  "phonenumber",
  "primaryphone",
  "telephone",
  "workphone"
]);
const HCN_CONTACT_EMAIL_KEYS = new Set([
  "adjusteremail",
  "carrierdaemail",
  "cfstring9",
  "email",
  "primaryemail"
]);
const HCN_CONTACT_CLAIM_KEYS = new Set([
  "cfstring10",
  "cfstring2",
  "claim",
  "claimnumber"
]);

function hcnGlobalScalarCorrelation(
  contacts,
  expectedValue,
  acceptedKeys,
  normalizeValue
) {
  if (
    !Array.isArray(contacts)
    || !expectedValue
    || !(acceptedKeys instanceof Set)
    || typeof normalizeValue !== "function"
  ) {
    return { complete: false, matches: [] };
  }
  const matches = [];
  for (const contact of contacts) {
    const inventory = hcnContactScalarInventory(
      contact,
      acceptedKeys,
      normalizeValue
    );
    if (!inventory.complete) {
      return { complete: false, matches: [] };
    }
    if (inventory.values.has(expectedValue)) matches.push(contact);
  }
  return { complete: true, matches };
}

function hcnContactScalarInventory(
  contact,
  acceptedKeys,
  normalizeValue
) {
  if (
    !contact
    || typeof contact !== "object"
    || Array.isArray(contact)
  ) {
    return { complete: false, values: new Set() };
  }
  const values = new Set();
  for (const [key, rawValue] of Object.entries(contact)) {
    const normalizedKey = hcnCorrelationKey(key);
    if (!acceptedKeys.has(normalizedKey)) continue;
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      continue;
    }
    if (
      typeof rawValue !== "string"
      && typeof rawValue !== "number"
    ) {
      return { complete: false, values: new Set() };
    }
    const value = normalizeValue(rawValue);
    if (!value) {
      return { complete: false, values: new Set() };
    }
    values.add(value);
  }
  return { complete: true, values };
}

function hcnNormalizeCorrelationEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (
    !email
    || Buffer.byteLength(email, "utf8") > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return "";
  }
  return email;
}

function hcnNormalizeCorrelationClaim(value) {
  const claimNumber = normalizeCompare(value);
  return claimNumber && claimNumber.length <= 160
    ? claimNumber
    : "";
}

function hcnCorrelationKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function hcnGlobalPhoneCorrelation(contacts, expectedPhone) {
  if (
    !Array.isArray(contacts)
    || !/^\+[1-9]\d{7,14}$/.test(String(expectedPhone || ""))
  ) {
    return { complete: false, matches: [] };
  }
  const matches = [];
  for (const contact of contacts) {
    const inventory = hcnContactPhoneInventory(contact);
    if (!inventory.complete) {
      return { complete: false, matches: [] };
    }
    if (inventory.phones.has(expectedPhone)) matches.push(contact);
  }
  return { complete: true, matches };
}

function hcnContactPhoneInventory(contact) {
  if (
    !contact
    || typeof contact !== "object"
    || Array.isArray(contact)
  ) {
    return { complete: false, phones: new Set() };
  }
  const phones = new Set();
  for (const [key, rawValue] of Object.entries(contact)) {
    const normalizedKey = hcnCorrelationKey(key);
    if (!HCN_CONTACT_PHONE_KEYS.has(normalizedKey)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      if (
        typeof value !== "string"
        && typeof value !== "number"
      ) {
        return { complete: false, phones: new Set() };
      }
      const phone = normalizePhone(value);
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        return { complete: false, phones: new Set() };
      }
      phones.add(phone);
    }
  }
  return { complete: true, phones };
}

function compactActivity(activity) {
  return {
    id: activity.jnid || activity.id,
    dateCreated: activity.date_created || "",
    type: activity.record_type_name || activity.type || "",
    note: activity.note || activity.description || ""
  };
}

function compactTask(task) {
  return {
    id: task.jnid || task.id,
    title: task.title || task.subject || "",
    description: task.description || task.note || "",
    createdAt: task.date_created || "",
    dateStart: task.date_start || "",
    dateEnd: task.date_end || "",
    dueDate: task.date_start || task.date_end || "",
    completed: Boolean(task.is_completed)
  };
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function normalizeDateFields(fields) {
  const body = { ...fields };
  for (const [inputKey, outputKey] of [
    ["dateStart", "date_start"],
    ["start", "date_start"],
    ["dueDate", "date_start"],
    ["dateEnd", "date_end"],
    ["end", "date_end"]
  ]) {
    if (body[inputKey] !== undefined) {
      body[outputKey] = toUnixSeconds(body[inputKey]);
      delete body[inputKey];
    }
  }
  return cleanObject(body);
}

function normalizeTaskUpdateFields(input) {
  const source = input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
    ? { ...input.fields }
    : {};
  for (const alias of ["completed", "isCompleted"]) {
    if (source[alias] !== undefined && source.is_completed === undefined) {
      source.is_completed = Boolean(source[alias]);
    }
    delete source[alias];
  }
  for (const alias of ["completed", "isCompleted", "is_completed"]) {
    if (input[alias] !== undefined && source.is_completed === undefined) {
      source.is_completed = Boolean(input[alias]);
    }
  }
  return cleanObject(source);
}

const CODEX_OPERATOR_CONTACT_FIELDS = new Set([
  "first_name",
  "last_name",
  "display_name",
  "email",
  "mobile_phone",
  "home_phone",
  "work_phone",
  "address_line1",
  "address_line2",
  "city",
  "state_text",
  "zip"
]);

const CODEX_OPERATOR_TASK_FIELDS = new Set([
  "title",
  "subject",
  "description",
  "note",
  "date_start",
  "date_end",
  "is_completed"
]);

const CODEX_OPERATOR_EVENT_FIELDS = new Set([
  "title",
  "subject",
  "description",
  "note",
  "date_start",
  "date_end"
]);

function assertCodexOperatorFields(fields, allowed, label, options = {}) {
  if (!isRestrictedEffectRequest()) return;
  if (isHcnRestrictedEffectRequest() && label === "contact") {
    const unsupportedHcnField = Object.keys(fields).find(
      (key) => key !== "cf_date_1"
    );
    if (unsupportedHcnField) {
      badRequest(
        `The HCN console cannot change contact field: ${unsupportedHcnField}.`
      );
    }
  }
  for (const key of Object.keys(fields)) {
    const isContactCustomField = options.allowContactCustomFields === true
      && /^cf_(?:string|text|date|number|integer|decimal|currency|bool|boolean)_\d+$/i.test(key);
    const isResolvedStatus = options.allowResolvedStatus === true && key === "status_name";
    if (!allowed.has(key) && !isContactCustomField && !isResolvedStatus) {
      badRequest(`The Codex operator cannot change ${label} field: ${key}.`);
    }
  }
}

function assertOperatorContactScope(contact) {
  if (!isRestrictedEffectRequest()) return;
  const companyScope = operatorCompanyScopeActive();
  if (
    !isInsuranceFile(contact)
    || (!companyScope && !assignedTo(contact, CHANCE_OWNER_ID))
    || (!companyScope && !chanceOperatorContactAllowed(contact))
    || (!companyScope && isMacCodexOperatorRequest() && !isExplicitlyOpenActive(contact))
    || (
      isHcnRestrictedEffectRequest()
      && !hcnContactIsExplicitlyActive(contact)
    )
  ) {
    conflictError(`The refreshed JobNimbus record is no longer an authorized ${operatorFileDescription()}.`);
  }
}

function isAmbiguousTaskUpdateError(error) {
  return Number(error?.statusCode) === 400 && /jnLog is not a function/i.test(String(error?.message || ""));
}

function recordMatchesFields(record, fields) {
  if (!record || typeof record !== "object") return false;
  return Object.entries(fields).every(([key, expected]) => {
    const actual = record[key];
    if (typeof expected === "boolean") {
      return expected ? providerFlagTrue(actual) : providerFlagFalse(actual);
    }
    if (typeof expected === "number") return Number(actual) === expected;
    return String(actual ?? "") === String(expected ?? "");
  });
}

function normalizeContactFields(fields) {
  const body = canonicalizeContactFieldAliases(fields);
  for (const key of Object.keys(body)) {
    if (/^cf_date_\d+$/i.test(key)) body[key] = toUnixSeconds(body[key]);
  }
  return cleanObject(body);
}

function toUnixSeconds(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return toUnixSeconds(Number(text));

  // JobNimbus renders date custom fields through the viewer's local timezone.
  // Anchor date-only values at noon UTC so the calendar day remains stable in
  // U.S. timezones instead of shifting backward from midnight UTC.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const isOffsetDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text);
  if (!isDateOnly && !isOffsetDateTime) {
    badRequest(
      `Invalid date/time: ${value}. Appointment times require ISO 8601 with an explicit offset, for example 2026-07-15T14:00:00-05:00.`
    );
  }
  const parsed = Date.parse(isDateOnly ? `${text}T12:00:00Z` : text);
  if (Number.isNaN(parsed)) badRequest(`Invalid date/time: ${value}`);
  return Math.floor(parsed / 1000);
}

function validateDateRange(dateStart, dateEnd) {
  if (dateStart !== undefined && dateEnd !== undefined && dateEnd < dateStart) {
    badRequest("dateEnd must be at or after dateStart.");
  }
}

function centralSchedulePreview(dateStart, dateEnd) {
  if (dateStart === undefined && dateEnd === undefined) return undefined;
  return cleanObject({
    timeZone: OPERATIONS_TIME_ZONE,
    start: formatCentralUnix(dateStart),
    end: formatCentralUnix(dateEnd)
  });
}

function formatCentralUnix(value) {
  if (value === undefined) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONS_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(value * 1000));
}

function compactDocument(doc) {
  return {
    id: doc.jnid || doc.id,
    name: doc.name || doc.filename || doc.file_name || "",
    type: doc.record_type_name || doc.type || ""
  };
}

function buildAssistantRead(contact, activities, tasks, documents) {
  const file = compactContact(contact);
  const missing = [];
  if (!file.carrier) missing.push("carrier");
  if (!file.policyNumber) missing.push("policy number");
  if (!file.claimNumber) missing.push("claim number");
  if (!file.dateOfLoss) missing.push("date of loss");
  if (!file.adjusterName && !file.adjusterPhone && !file.adjusterEmail) missing.push("adjuster contact");
  return {
    missingInfo: missing,
    likelyStage: file.status || "unknown",
    nextAction: missing.includes("claim number") ? "Prepare or confirm claim filing." : "Review recent activity and push the next carrier/appraisal step.",
    documentNames: documents.slice(0, 20).map((doc) => compactDocument(doc).name),
    recentNoteCount: activities.length,
    openTaskCount: tasks.filter((task) => !task.is_completed).length
  };
}

function isOperationalDocumentMetadata(document) {
  const compact = compactDocument(document);
  const name = String(compact.name || "").toLowerCase();
  const contentType = String(document.content_type || document.contentType || document.mime_type || "").toLowerCase();
  if (contentType.startsWith("image/")) return false;
  if (/\.(?:jpe?g|png|gif|heic|webp|tiff?)$/i.test(name)) return false;
  if (/\b(?:photo report|photo file|roof photos?|site photos?|damage photos?|image report)\b/i.test(name)) return false;
  return true;
}

function buildFileGmailQuery(file, requestedDays) {
  const days = clamp(Number(requestedDays || 365), 1, 3650);
  const addressLine = String(file.address || "").split(",")[0].trim();
  const terms = [...new Set([
    file.claimNumber,
    file.policyNumber,
    file.email,
    file.name,
    addressLine,
    file.number ? `#${file.number}` : ""
  ].map((value) => String(value || "").trim()).filter((value) => value.length >= 4))].slice(0, 6);
  if (!terms.length) return `newer_than:${days}d`;
  const group = terms.map((term) => `"${term.replace(/["{}]/g, " ")}"`).join(" ");
  return `{${group}} newer_than:${days}d`;
}

function compactGmailEvidenceThread(thread) {
  const messages = (Array.isArray(thread.messages) ? thread.messages : []).slice(-5).map((message) => ({
    id: message.id,
    date: message.date,
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: String(message.plainText || message.htmlText || message.snippet || "").slice(0, 1800),
    attachments: message.attachments
  }));
  return {
    id: thread.id,
    messageCount: thread.messageCount,
    messages,
    assistantRead: thread.assistantRead
  };
}

function buildFactualSignals(file, activities, openTasks, documents, gmail, quo) {
  const latestActivity = activities[0]?.date_created || "";
  const latestActivityDate = toIsoTimestamp(latestActivity);
  const daysSinceActivity = latestActivityDate
    ? Math.max(0, Math.floor((Date.now() - Date.parse(latestActivityDate)) / 86400000))
    : null;
  const missing = [];
  if (!file.carrier) missing.push("carrier");
  if (!file.policyNumber) missing.push("policy number");
  if (!file.claimNumber) missing.push("claim number");
  if (!file.dateOfLoss) missing.push("date of loss");
  if (!file.adjusterName && !file.adjusterPhone && !file.adjusterEmail) missing.push("adjuster contact");
  return {
    status: file.status,
    missingJobNimbusFields: missing,
    latestJobNimbusActivityAt: latestActivityDate,
    daysSinceJobNimbusActivity: daysSinceActivity,
    openTaskCount: openTasks.length,
    operationalDocumentCount: documents.length,
    gmailMessageCount: Array.isArray(gmail.messages) ? gmail.messages.length : 0,
    quoTimelineItemCount: Array.isArray(quo.timeline) ? quo.timeline.length : 0
  };
}

function toIsoTimestamp(value) {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    const millis = number > 9999999999 ? number : number * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function providerTimeMs(value) {
  const timestamp = toIsoTimestamp(value);
  return timestamp ? Date.parse(timestamp) : 0;
}

function normalizeActionOperations(value) {
  if (!Array.isArray(value) || !value.length) badRequest("operations must be a non-empty array");
  const maxActions = isMacCodexOperatorRequest()
    && !operatorCompanyScopeActive()
    && !isHcnRestrictedEffectRequest()
    ? 15
    : 12;
  if (value.length > maxActions) badRequest(`An approval batch may contain at most ${maxActions} actions.`);
  return value.map((operation, index) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) badRequest(`operations[${index}] must be an object`);
    const unsupportedOperationField = Object.keys(operation).find((key) => !["type", "payload"].includes(key));
    if (unsupportedOperationField) badRequest(`operations[${index}] contains unsupported field: ${unsupportedOperationField}`);
    const type = String(operation.type || "").trim().toLowerCase();
    if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
      badRequest(`operations[${index}].payload must be an object`);
    }
    const payload = { ...operation.payload };
    for (const forbidden of ["execute", "approvalDigest", "approvalChallenge"]) {
      if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
        badRequest(`operations[${index}].payload must not include ${forbidden}`);
      }
    }
    if (isRestrictedEffectRequest()) {
      if (type === "jobnimbus.process_update") {
        badRequest("The Codex operator must use separate contact/status and note operations so each completed mutation has its own durable batch receipt.");
      }
      const freeFormMemoryField = Object.keys(payload).find((key) => (
        ["followups", "learning", "episode"].includes(key.toLowerCase())
      ));
      if (freeFormMemoryField) {
        badRequest(`operations[${index}].payload cannot persist free-form ${freeFormMemoryField} through the Codex operator.`);
      }
    }
    if (
      isHcnRestrictedEffectRequest()
      && !HCN_BROWSER_ACTION_TYPES.includes(type)
    ) {
      badRequest(`Unsupported HCN action type: ${type}`);
    }
    if (!ACTION_OPERATION_TYPES.has(type)) badRequest(`Unsupported action type: ${type}`);
    return { type, payload };
  });
}

const ACTION_OPERATION_TYPES = new Set([
  "jobnimbus.update_contact",
  "jobnimbus.update_status",
  "jobnimbus.process_update",
  "jobnimbus.create_note",
  "jobnimbus.create_task",
  "jobnimbus.update_task",
  "jobnimbus.ensure_current_task",
  "jobnimbus.create_calendar_event",
  "jobnimbus.update_calendar_event",
  "gmail.create_draft",
  "gmail.send",
  "gmail.send_existing_draft",
  "quo.send_text"
]);

async function prepareActionOperation(operation, options = {}) {
  const input = { ...operation.payload, execute: false };
  let plan;
  switch (operation.type) {
    case "jobnimbus.update_contact": plan = await updateContact(input); break;
    case "jobnimbus.update_status": plan = await updateStatus({
      ...input,
      enforceThresher: options.runPolicy?.enforced === true
    }); break;
    case "jobnimbus.process_update": plan = await processUpdate(input); break;
    case "jobnimbus.create_note": plan = await createNote(input); break;
    case "jobnimbus.create_task": plan = await createTask(input); break;
    case "jobnimbus.update_task": plan = await updateTask(input); break;
    case "jobnimbus.ensure_current_task": plan = await ensureCurrentTask(input); break;
    case "jobnimbus.create_calendar_event": plan = await createCalendarEvent(input); break;
    case "jobnimbus.update_calendar_event": plan = await updateCalendarEvent(input); break;
    case "gmail.create_draft": plan = await gmailDraft(input); break;
    case "gmail.send": plan = await gmailSend(input); break;
    case "gmail.send_existing_draft": plan = await gmailSend(input, {
      operatorExistingDraftLane: true
    }); break;
    case "quo.send_text": plan = await quoSend(input); break;
    default: badRequest(`Unsupported action type: ${operation.type}`);
  }
  return { type: operation.type, plan };
}

async function executeActionOperation(operation, prepared) {
  const input = { ...operation.payload, execute: true };
  switch (operation.type) {
    case "jobnimbus.update_contact": return updateContact({
      ...input,
      expectedFileId: preparedActionFile(prepared).id,
      expectedBeforeFields: prepared.plan.plan.before
    });
    case "jobnimbus.update_status": return updateStatus({
      ...input,
      expectedFileId: preparedActionFile(prepared).id,
      expectedBeforeStatus: prepared.plan.plan.before?.status_name,
      enforceThresher: prepared.plan.plan.thresherTransition !== undefined,
      expectedThresherTransition: prepared.plan.plan.thresherTransition
    });
    case "jobnimbus.process_update": return processUpdate(input);
    case "jobnimbus.create_note": return createNote(input);
    case "jobnimbus.create_task": return createTask(input);
    case "jobnimbus.update_task": return updateTask(input);
    case "jobnimbus.ensure_current_task": return ensureCurrentTask({
      ...input,
      expectedFileId: preparedActionFile(prepared).id,
      expectedPlan: prepared.plan.plan
    });
    case "jobnimbus.create_calendar_event": return createCalendarEvent(input);
    case "jobnimbus.update_calendar_event": return updateCalendarEvent(input);
    case "gmail.create_draft": return gmailDraft({ ...input, approvalDigest: prepared.plan.approvalDigest });
    case "gmail.send": return gmailSend({ ...input, approvalDigest: prepared.plan.approvalDigest });
    case "gmail.send_existing_draft": return gmailSend(
      { ...input, approvalDigest: prepared.plan.approvalDigest },
      { operatorExistingDraftLane: true }
    );
    case "quo.send_text": return quoSend({ ...input, approvalDigest: prepared.plan.approvalDigest });
    default: badRequest(`Unsupported action type: ${operation.type}`);
  }
}

function withActionApprovalMutation(callback) {
  const run = actionApprovalMutationQueue.then(callback);
  actionApprovalMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function withClaimCallMutation(callback) {
  const run = claimCallMutationQueue.then(callback);
  claimCallMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function actionApprovalIdentityHash() {
  if (isHcnRestrictedEffectRequest()) {
    const sessionId = String(
      currentRequestAuthentication()?.hcnSessionId || ""
    );
    if (!sessionId) {
      const error = new Error(
        "No authenticated HCN session is available for this approval."
      );
      error.statusCode = 401;
      throw error;
    }
    return createHash("sha256")
      .update("hcn-console:action-approval-identity:v1", "utf8")
      .update("\0", "utf8")
      .update(sessionId, "utf8")
      .digest("hex");
  }
  const identity = currentRequestIdentity();
  if (!identity) {
    const error = new Error("No authenticated identity is available for this approval.");
    error.statusCode = 401;
    throw error;
  }
  return createHash("sha256")
    .update([
      String(identity.type || ""),
      String(identity.subject || ""),
      String(identity.email || "").toLowerCase(),
      String(identity.role || "")
    ].join("|"), "utf8")
    .digest("hex");
}

function validActionBatchPrincipalHash(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

async function issueActionApprovalChallenge(
  approvalDigest,
  operationCount,
  batchScope = {},
  approvalKind = "action_batch",
  ttlSeconds = ACTION_APPROVAL_TTL_SECONDS
) {
  return withActionApprovalMutation(async () => {
    const ledger = await readSecurityLedger(ACTION_APPROVAL_STORE_PATH, "Action approval ledger");
    const identityHash = actionApprovalIdentityHash();
    const now = Date.now();
    for (const row of ledger) {
      if (row.status === "active" && Number(row.expiresAtMs || 0) <= now) {
        row.status = "expired";
        row.expiredAt = new Date(now).toISOString();
      } else if (row.status === "active" && row.identityHash === identityHash) {
        row.status = "superseded";
        row.supersededAt = new Date(now).toISOString();
      }
    }
    const challenge = randomBytes(32).toString("base64url");
    const normalizedKind = String(approvalKind || "").trim();
    if (!["action_batch", "claim_filing_call"].includes(normalizedKind)) {
      throw new TypeError("Unsupported approval challenge kind.");
    }
    const normalizedTtl = Math.max(1, Math.min(Number(ttlSeconds || 0), 3600));
    const expiresAtMs = now + normalizedTtl * 1000;
    const row = {
      id: randomUUID(),
      challengeHash: createHash("sha256").update(challenge, "utf8").digest("hex"),
      bootId: BRIDGE_BOOT_ID,
      identityHash,
      approvalDigest,
      approvalKind: normalizedKind,
      operationCount,
      batchMode: batchScope.mode || "",
      runPolicyId: batchScope.runPolicyId || "",
      runPolicySha256: batchScope.runPolicySha256 || "",
      runPolicyExpiresAt: batchScope.runPolicyExpiresAt || "",
      fileCount: Number(batchScope.fileCount || 0),
      fileManifestHash: digest(stableApprovalBatchScope(batchScope)),
      status: "active",
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs
    };
    ledger.push(row);
    await writeSecurityLedger(ACTION_APPROVAL_STORE_PATH, ledger);
    return { id: row.id, challenge, expiresAt: row.expiresAt };
  });
}

async function revokeActionApprovalChallenge(approvalId) {
  return withActionApprovalMutation(async () => {
    const ledger = await readSecurityLedger(
      ACTION_APPROVAL_STORE_PATH,
      "Action approval ledger"
    );
    const row = ledger.find((item) => item.id === approvalId);
    if (!row || row.status !== "active") return false;
    row.status = "revoked";
    row.revokedAt = new Date().toISOString();
    await writeSecurityLedger(ACTION_APPROVAL_STORE_PATH, ledger);
    return true;
  });
}

async function consumeActionApprovalChallenge(
  value,
  approvalDigest,
  approvalKind = "action_batch",
  expectedScope = null
) {
  const challenge = String(value || "").trim();
  const normalizedKind = String(approvalKind || "").trim();
  const label = normalizedKind === "claim_filing_call"
    ? "Retell claim-call execution"
    : "Action batch execution";
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(challenge)) {
    badRequest(`${label} requires the single-use approvalChallenge from its exact dry run.`);
  }
  return withActionApprovalMutation(async () => {
    const ledger = await readSecurityLedger(ACTION_APPROVAL_STORE_PATH, "Action approval ledger");
    const challengeHash = createHash("sha256").update(challenge, "utf8").digest("hex");
    const row = ledger.find((item) => item.challengeHash === challengeHash);
    const identityHash = actionApprovalIdentityHash();
    const rowKind = String(row?.approvalKind || "action_batch");
    const expectedScopeHash = expectedScope
      ? digest(stableApprovalBatchScope(expectedScope))
      : "";
    if (
      !row
      || row.bootId !== BRIDGE_BOOT_ID
      || row.identityHash !== identityHash
      || row.approvalDigest !== approvalDigest
      || rowKind !== normalizedKind
      || (expectedScopeHash && row.fileManifestHash !== expectedScopeHash)
    ) {
      const error = new Error("The approval challenge does not match this bridge boot, identity, action kind, run policy, file scope, and exact plan. Nothing was executed; prepare and approve a fresh dry run.");
      error.statusCode = 409;
      throw error;
    }
    const now = Date.now();
    if (row.status !== "active" || Number(row.expiresAtMs || 0) <= now) {
      if (row.status === "active") {
        row.status = "expired";
        row.expiredAt = new Date(now).toISOString();
        await writeSecurityLedger(ACTION_APPROVAL_STORE_PATH, ledger);
      }
      const error = new Error(`The approval challenge is ${row.status || "unavailable"}. Nothing was executed; prepare and approve a fresh dry run.`);
      error.statusCode = 409;
      throw error;
    }
    row.status = "consumed";
    row.consumedAt = new Date(now).toISOString();
    await writeSecurityLedger(ACTION_APPROVAL_STORE_PATH, ledger);
    return { id: row.id, approvalDigest: row.approvalDigest };
  });
}

function withActionBatchMutation(callback) {
  const run = actionBatchMutationQueue.then(callback);
  actionBatchMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function actionBatchIntent(operation, prepared, file, index) {
  const plan = prepared?.plan?.plan || {};
  let reconciliation = null;
  if (operation.type === "jobnimbus.update_contact") {
    reconciliation = { before: plan.before || {}, after: plan.fields || {} };
  } else if (operation.type === "jobnimbus.update_status") {
    reconciliation = { before: plan.before || {}, after: plan.body || {} };
  } else if (operation.type === "jobnimbus.ensure_current_task") {
    reconciliation = {
      decision: plan.decision || "",
      selectedTaskId: plan.selectedTaskId || null,
      before: plan.before || null,
      after: plan.after || {},
      controlInventoryDigest: plan.controlInventoryDigest || ""
    };
  } else if (operation.type === "gmail.create_draft") {
    const subject = String(plan.subject || "").trim();
    reconciliation = {
      subject,
      subjectHash: createHash("sha256").update(subject, "utf8").digest("hex"),
      sourceKeyHash: createHash("sha256")
        .update(`claim-draft:${String(file?.id || "")}:${subject}`, "utf8")
        .digest("hex"),
      channelApprovalDigest: String(prepared?.plan?.approvalDigest || ""),
      threadId: String(plan.threadId || "").trim(),
      contentDigest: gmailDraftReconciliationDigest(plan)
    };
  } else if (operation.type === "gmail.send_existing_draft") {
    const subject = String(plan.subject || "").trim();
    reconciliation = {
      draftId: String(plan.draftId || "").trim(),
      subject,
      subjectHash: createHash("sha256").update(subject, "utf8").digest("hex"),
      sourceKeyHash: createHash("sha256")
        .update(`gmail-draft:${String(plan.draftId || "").trim()}`, "utf8")
        .digest("hex"),
      channelApprovalDigest: String(prepared?.plan?.approvalDigest || ""),
      threadId: String(plan.threadId || "").trim(),
      contentDigest: gmailImmutableSendDigest(plan),
      sourceDraftContentDigest: String(plan.contentDigest || "").trim()
    };
  }
  const stable = {
    index,
    type: operation.type,
    fileId: String(file?.id || ""),
    fileNumber: String(file?.number || ""),
    reconciliation
  };
  return { ...stable, intentDigest: digest({ version: 1, stable }) };
}

async function reserveActionBatch(
  approvalId,
  approvalDigest,
  operationCount,
  batchScope = {},
  operations = [],
  plans = []
) {
  return withActionBatchMutation(async () => {
    const ledger = await readActionBatchLedger();
    const legacyIsolation = resolveChanceLegacyHistoricalIsolation(ledger);
    const allowLegacyIsolation = legacyIsolationAppliesToBatch(batchScope);
    if (allowLegacyIsolation && legacyIsolation.configured && !legacyIsolation.valid) {
      conflictError("The exact historical receipt isolation no longer attests. No action may execute until its six fingerprints, runtime gates, and run policy match again.");
    }
    const existing = ledger.find((row) => (
      row.approvalId === approvalId || row.approvalDigest === approvalDigest
    ));
    if (existing) return { existing };
    const blocking = findUnresolvedBatchOverlap(ledger, batchScope, { allowLegacyIsolation });
    if (blocking) throwUnresolvedBatchOverlap(blocking);

    const batch = {
      schemaVersion: 2,
      id: randomUUID(),
      approvalId,
      approvalDigest,
      principalHash: actionApprovalIdentityHash(),
      operatorScope: currentOperatorScope(),
      bootId: BRIDGE_BOOT_ID,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      operationCount,
      batchMode: batchScope.mode || "",
      runPolicyId: batchScope.runPolicyId || "",
      runPolicySha256: batchScope.runPolicySha256 || "",
      runPolicyExpiresAt: batchScope.runPolicyExpiresAt || "",
      fileCount: Number(batchScope.fileCount || 0),
      files: (batchScope.files || []).map((file) => ({
        id: file.id,
        number: file.number,
        operationIndexes: file.operationIndexes,
        operationTypes: file.operationTypes
      })),
      intents: operations.map((operation, index) => actionBatchIntent(
        operation,
        plans[index],
        batchScope.operationFiles?.[index],
        index
      )),
      completed: []
    };
    ledger.push(batch);
    await writeActionBatchLedger(ledger);
    return { batch };
  });
}

async function updateActionBatch(batch) {
  return withActionBatchMutation(async () => {
    const ledger = await readActionBatchLedger();
    const index = ledger.findIndex((row) => row.id === batch.id);
    if (index === -1) {
      const error = new Error("The reserved action batch receipt is missing. Stop and review before retrying.");
      error.statusCode = 409;
      throw error;
    }
    ledger[index] = JSON.parse(JSON.stringify(batch));
    await writeActionBatchLedger(ledger);
  });
}

async function readActionBatchLedger() {
  return readSecurityLedger(ACTION_BATCH_STORE_PATH, "Action batch ledger");
}

async function writeActionBatchLedger(rows) {
  actionBatchLedgerWriteCount += 1;
  if (
    ACTION_BATCH_LEDGER_TEST_FAIL_AT > 0
    && actionBatchLedgerWriteCount === ACTION_BATCH_LEDGER_TEST_FAIL_AT
  ) {
    const error = new Error("Injected action-batch ledger write failure for tests.");
    error.statusCode = 503;
    throw error;
  }
  await writeSecurityLedger(ACTION_BATCH_STORE_PATH, rows);
}

async function reserveOutboundSend(channel, approvalDigest, metadata = {}) {
  return withOutboundSendMutation(async () => {
    const ledger = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
    const sourceKeyHash = metadata.sourceKey
      ? createHash("sha256").update(String(metadata.sourceKey), "utf8").digest("hex")
      : "";
    const existing = ledger.find((row) => (
      row.channel === channel
      && row.status !== "verified_not_applied"
      && (
        row.approvalDigest === approvalDigest
        || (sourceKeyHash && row.sourceKeyHash === sourceKeyHash)
      )
    ));
    if (existing) {
      const error = new Error(`This exact approved ${channel} send is already ${existing.status}. Review its receipt before any retry.`);
      error.statusCode = 409;
      throw error;
    }
    const row = {
      id: randomUUID(),
      channel,
      approvalDigest,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      destinationHash: metadata.to ? createHash("sha256").update(String(metadata.to)).digest("hex") : "",
      subjectHash: metadata.subject ? createHash("sha256").update(String(metadata.subject), "utf8").digest("hex") : "",
      sourceKeyHash
    };
    ledger.push(row);
    await writeOutboundSendLedger(ledger);
    return row;
  });
}

async function assertOutboundSourceAvailable(channel, sourceKey) {
  const sourceKeyHash = createHash("sha256").update(String(sourceKey), "utf8").digest("hex");
  const ledger = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
  const existing = ledger.find((row) => row.channel === channel && row.sourceKeyHash === sourceKeyHash);
  if (existing) {
    const error = new Error(`This ${channel} source was already used by an outbound attempt that is ${existing.status}. Create and approve a new source draft for any intentional resend.`);
    error.statusCode = 409;
    throw error;
  }
}

async function completeOutboundSend(id, status, externalId = "", error = "") {
  return withOutboundSendMutation(async () => {
    const ledger = await readSecurityLedger(OUTBOUND_SEND_STORE_PATH, "Outbound send ledger");
    const row = ledger.find((item) => item.id === id);
    if (!row) return;
    row.status = status;
    row.externalId = String(externalId || "").slice(0, 300);
    row.error = redactSensitiveText(String(error || "")).slice(0, 500);
    row.updatedAt = new Date().toISOString();
    await writeOutboundSendLedger(ledger);
  });
}

function withOutboundSendMutation(callback) {
  const run = outboundSendMutationQueue.then(callback);
  outboundSendMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeOutboundSendLedger(rows) {
  await writeSecurityLedger(OUTBOUND_SEND_STORE_PATH, rows);
}

function summarizeOperationResult(result) {
  const deliveryStatus = String(result?.delivery?.status || "");
  const deliveryConfirmed = result?.delivery?.confirmed === true;
  const deliveryFailed = result?.delivery?.failed === true;
  const hcnManualVerificationRequired = isHcnRestrictedEffectRequest()
    && result?.mode === "executed"
    && result?.verifiedByReadback !== true
    && !deliveryStatus;
  return cleanObject({
    mode: result?.mode || "executed",
    fileId: result?.file?.id || "",
    fileNumber: result?.file?.number || "",
    externalId: resultId(result?.message || result?.draft || result?.result || result?.results || result),
    verifiedByReadback: result?.verifiedByReadback,
    deliveryStatus,
    deliveryConfirmed: deliveryStatus ? deliveryConfirmed : undefined,
    manualVerificationRequired: deliveryStatus
      ? !deliveryConfirmed && !deliveryFailed
      : hcnManualVerificationRequired || undefined,
    sourceDraftId: result?.sourceDraftId || "",
    sourceDraftRetention: result?.sourceDraftRetention?.status || "",
    memoryReceiptId: result?.memoryCloseout?.receipt?.id || "",
    clientSnapshotRefreshed: result?.memoryCloseout?.clientMemoryRefresh?.refreshed === true
  });
}

function resultId(result) {
  if (!result || typeof result !== "object") return "";
  return String(
    result.id || result.jnid || result.message?.id || result.data?.id || result.data?.jnid ||
    result.note?.jnid || result.contact?.jnid || result.activity?.jnid || ""
  );
}

async function closeoutJobNimbusAction(file, action, result, summary) {
  if (isRestrictedEffectRequest()) {
    return {
      ...operatorMemoryCloseoutBoundary(),
      clientMemoryRefresh: {
        refreshed: false,
        reason: "operator_privacy_boundary"
      }
    };
  }
  const externalId = resultId(result);
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
    channel: "jobnimbus",
    action,
    subjectKey: file.id,
    fileLabel: `${file.number || ""} ${file.name || ""}`.trim(),
    summary,
    externalId,
    evidence: externalId ? [`jobnimbus:${externalId}`] : []
  });
  const clientMemoryRefresh = await safeRefreshClientSnapshot(file.id);
  return { ...memoryCloseout, clientMemoryRefresh };
}

async function safeRefreshClientSnapshot(subjectKey) {
  if (isRestrictedEffectRequest()) {
    return { refreshed: false, reason: "operator_privacy_boundary" };
  }
  if (!ALLOW_LEGACY_CLIENT_MEMORY_WRITES) {
    return { refreshed: false, reason: "legacy_client_memory_writes_disabled" };
  }
  const id = String(subjectKey || "").trim();
  if (!id) return { refreshed: false, reason: "missing_subject_key" };
  try {
    const contact = await jobNimbus(`/contacts/${encodeURIComponent(id)}`);
    const packet = await buildChanceEvidencePacket(contact, { includeGmail: false, includeQuo: false });
    return {
      refreshed: true,
      at: packet.clientMemory?.snapshot?.refreshedAt || new Date().toISOString(),
      snapshot: packet.clientMemory?.snapshot || null,
      authority: "The snapshot refresh records current file state but does not authorize another action."
    };
  } catch (error) {
    return {
      refreshed: false,
      error: redactSensitiveText(error.message || String(error)),
      authority: "The approved action succeeded, but snapshot refresh failed. Re-run an exact-file review before the next decision."
    };
  }
}

async function optionalChanceFile(query) {
  if (!query) return null;
  return compactContact((await findChanceContact(query)).contact);
}

function closeoutGmailAction(input, file, action, externalId, summary, status = "executed") {
  if (isRestrictedEffectRequest()) return operatorMemoryCloseoutBoundary();
  return safeCloseoutAction(MEMORY_CONFIG, {
    channel: "gmail",
    action,
    status,
    subjectKey: file?.id || String(input.subjectKey || ""),
    fileLabel: file ? `${file.number || ""} ${file.name || ""}`.trim() : String(input.fileLabel || ""),
    summary,
    externalId: String(externalId || ""),
    followUps: input.followUps || [],
    evidence: externalId ? [`gmail:${externalId}`] : []
  });
}

function requireApprovalDigest(provided, expected, label) {
  const value = String(provided || "").trim();
  if (!value) badRequest(`${label} requires the approvalDigest from its exact dry run.`);
  if (value !== expected) {
    const error = new Error(`${label} approval digest no longer matches the current plan. Nothing was sent or executed; review a fresh dry run.`);
    error.statusCode = 409;
    throw error;
  }
}

function redactSensitiveText(value) {
  let text = String(value || "");
  for (const secret of [API_KEY, BRIDGE_TOKEN, CODEX_OPERATOR_TOKEN, CODEX_MAC_OPERATOR_TOKEN, RETELL_GUARDED_END_CALL_TOKEN, RETELL_INBOUND_WEBHOOK_TOKEN, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, OPENAI_API_KEY, ZAI_API_KEY, TWILIO_AUTH_TOKEN, RETELL_API_KEY, QUO_API_KEY].filter((item) => item && item.length >= 8)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

function authorized(req) {
  if (!BRIDGE_TOKEN) return false;
  return req.headers.authorization === `Bearer ${BRIDGE_TOKEN}`;
}

async function authenticateRequest(req) {
  const authorizationHeader = String(req.headers.authorization || "").trim();
  const hcnSessionId = readHcnCookie(
    req.headers.cookie,
    HCN_SESSION_COOKIE_NAME
  );
  if (authorizationHeader && hcnSessionId) {
    const error = new Error("Ambiguous authentication is not allowed.");
    error.statusCode = 400;
    throw error;
  }
  if (hcnSessionId) {
    if (!hcnConsoleAuthConfigured()) return null;
    const session = HCN_CONSOLE_SESSION_STORE.touchSession(hcnSessionId);
    if (!session) return null;
    const approvedUser = WAVE_AUTH_USERS.get(
      String(session.subject || "").trim().toLowerCase()
    );
    if (
      !approvedUser
      || !hcnConsoleSessionMatchesApprovedUser(
        session,
        approvedUser
      )
    ) {
      HCN_CONSOLE_SESSION_STORE.revokeSession(hcnSessionId);
      return null;
    }
    return {
      identity: {
        type: "hcn_browser_session",
        subject: "",
        email: "",
        name: "",
        role: approvedUser.role,
        hostedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
        scopes: [],
        googleAccessToken: "",
        jobNimbusOwnerId: "",
        jobNimbusScope: "none",
        quoLineId: "",
        enabled: true
      },
      authenticationMethod: "hcn_cookie",
      hcnSession: session,
      hcnSessionId
    };
  }

  const identity = await authenticateBearerRequest(req);
  return identity
    ? {
        identity,
        authenticationMethod: "bearer",
        hcnSession: null,
        hcnSessionId: ""
      }
    : null;
}

async function authenticateBearerRequest(req) {
  const token = bearerToken(req);
  if (!token) return null;
  if (RETELL_GUARDED_END_CALL_TOKEN && secureEqual(token, RETELL_GUARDED_END_CALL_TOKEN)) {
    return {
      type: "retell_guarded_end_token",
      subject: "retell-claim-agent",
      email: "",
      name: "Retell Claim Agent",
      role: "retell_guarded_end",
      hostedDomain: "",
      scopes: ["retell_claim_call:guarded_end_only"],
      googleAccessToken: "",
      jobNimbusOwnerId: "",
      jobNimbusScope: "none",
      quoLineId: ""
    };
  }
  if (BRIDGE_TOKEN && token === BRIDGE_TOKEN) {
    return {
      type: "bridge_token",
      subject: "legacy-chance-bridge",
      email: process.env.CHANCE_GOOGLE_EMAIL || "cpearson@wavepa.com",
      name: "Chance Pearson",
      role: "chance",
      hostedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
      scopes: [],
      googleAccessToken: "",
      jobNimbusOwnerId: CHANCE_OWNER_ID,
      jobNimbusScope: "assigned",
      quoLineId: ""
    };
  }
  if (CODEX_OPERATOR_TOKEN && secureEqual(token, CODEX_OPERATOR_TOKEN)) {
    return {
      type: "codex_operator_token",
      subject: "codex-hp-operator",
      email: "",
      name: "Codex Operator",
      role: "codex_operator",
      hostedDomain: "",
      scopes: ["client_evidence:read", "approval_batches:prepare_execute"],
      googleAccessToken: "",
      jobNimbusOwnerId: CHANCE_OWNER_ID,
      jobNimbusScope: "assigned",
      quoLineId: QUO_DEFAULT_FROM_NUMBER
    };
  }
  if (CODEX_MAC_OPERATOR_TOKEN && secureEqual(token, CODEX_MAC_OPERATOR_TOKEN)) {
    return {
      type: "codex_operator_token",
      subject: "codex-mac-operator",
      email: "",
      name: "Codex Mac Operator",
      role: "codex_operator",
      hostedDomain: "",
      scopes: [
        "client_evidence:read",
        "company_exact_file:read",
        "approval_batches:prepare_execute",
        "retell_claim_filing:prepare_execute_review"
      ],
      googleAccessToken: "",
      jobNimbusOwnerId: CHANCE_OWNER_ID,
      jobNimbusScope: "assigned",
      quoLineId: QUO_DEFAULT_FROM_NUMBER
    };
  }
  if (!ALLOW_GOOGLE_USER_AUTH) return null;

  if (OAUTH_SESSION_SECRET) {
    try {
      const broker = openOAuthPayload(token);
      if (broker.kind === "access_token" && Number(broker.exp || 0) > Date.now() && broker.googleAccessToken) {
        return effectiveEmployeeIdentity({
          ...approvedIdentityFromPayload(broker.identity),
          type: "google_oauth",
          googleAccessToken: broker.googleAccessToken
        });
      }
    } catch {
      // The bearer may be a direct Google token used by a trusted non-GPT client.
    }
  }

  const cacheKey = createHash("sha256").update(token).digest("hex");
  const cached = GOOGLE_IDENTITY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return effectiveEmployeeIdentity({ ...cached.identity, googleAccessToken: token });
  }
  const identity = await authenticateGoogleAccessToken({
    token,
    clientId: GOOGLE_CLIENT_ID,
    tokenInfoUrl: GOOGLE_TOKENINFO_URL,
    userInfoUrl: GOOGLE_USERINFO_URL,
    allowedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
    users: WAVE_AUTH_USERS,
    resolveUser: resolveFirstUseWaveUser,
    allowTestProviderEndpoints:
      ALLOW_TEST_GOOGLE_PROVIDER_ENDPOINTS
  });
  GOOGLE_IDENTITY_CACHE.set(cacheKey, {
    identity: { ...identity, googleAccessToken: "" },
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  if (GOOGLE_IDENTITY_CACHE.size > 200) {
    for (const [key, row] of GOOGLE_IDENTITY_CACHE) {
      if (row.expiresAt <= Date.now()) GOOGLE_IDENTITY_CACHE.delete(key);
    }
  }
  return effectiveEmployeeIdentity(identity);
}

function oauthIdentityPayload(identity) {
  return {
    subject: String(identity.subject || ""),
    email: String(identity.email || "").toLowerCase(),
    name: String(identity.name || ""),
    hostedDomain: String(identity.hostedDomain || "").toLowerCase()
  };
}

function approvedIdentityFromPayload(payload = {}) {
  const email = String(payload.email || "").toLowerCase();
  const user = WAVE_AUTH_USERS.get(email);
  if (!user || user.enabled === false) throw oauthError("access_denied", "This Google account is not approved for the Wave Ops bridge.", 403);
  if (String(payload.hostedDomain || "").toLowerCase() !== GOOGLE_OAUTH_ALLOWED_DOMAIN.toLowerCase()) {
    throw oauthError("access_denied", "Google account is outside the approved Workspace domain.", 403);
  }
  return {
    type: "google_oauth",
    subject: String(payload.subject || ""),
    email,
    name: user.name || payload.name || email,
    role: user.role,
    hostedDomain: String(payload.hostedDomain || "").toLowerCase(),
    scopes: GOOGLE_OAUTH_SCOPES,
    googleAccessToken: "",
    jobNimbusOwnerId: user.jobNimbusOwnerId,
    jobNimbusScope: user.jobNimbusScope,
    quoLineId: user.quoLineId,
    enabled: true
  };
}

async function hydrateAutoEnrolledWaveUsers() {
  if (!AUTO_ENROLL_WAVE_USERS) return;
  const rows = await readJsonFile(AUTO_ENROLLED_USER_STORE_PATH, []);
  for (const row of Array.isArray(rows) ? rows : []) {
    const email = String(row?.email || "").trim().toLowerCase();
    if (!email || WAVE_AUTH_USERS.has(email) || row?.enabled === false) continue;
    WAVE_AUTH_USERS.set(email, {
      email,
      name: String(row.name || email).trim(),
      role: "onboarding",
      enabled: true,
      jobNimbusOwnerId: String(row.jobNimbusOwnerId || "").trim(),
      jobNimbusScope: "company",
      quoLineId: ""
    });
  }
}

async function resolveFirstUseWaveUser({ email, name }) {
  if (!AUTO_ENROLL_WAVE_USERS) return null;
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const domain = normalizedEmail.split("@")[1] || "";
  if (!normalizedEmail || domain !== GOOGLE_OAUTH_ALLOWED_DOMAIN.toLowerCase()) return null;

  const jobNimbusUser = await findActiveJobNimbusUser(normalizedEmail);
  if (!jobNimbusUser) {
    const error = new Error("No active JobNimbus employee account matched this Wave email address.");
    error.statusCode = 403;
    throw error;
  }
  const user = {
    email: normalizedEmail,
    name: String(jobNimbusUser.name || name || normalizedEmail).trim(),
    role: "onboarding",
    enabled: true,
    jobNimbusOwnerId: String(jobNimbusUser.id || "").trim(),
    jobNimbusScope: "company",
    quoLineId: ""
  };
  WAVE_AUTH_USERS.set(normalizedEmail, user);
  await persistAutoEnrolledWaveUsers();
  return user;
}

async function findActiveJobNimbusUser(email) {
  const key = String(email || "").trim().toLowerCase();
  const cached = JOBNIMBUS_USER_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  let payload;
  try {
    payload = await jobNimbus("/account/users?size=1000&from=0");
  } catch (error) {
    const wrapped = new Error("JobNimbus employee verification is unavailable; access was not granted.");
    wrapped.statusCode = Number(error?.statusCode) || 503;
    throw wrapped;
  }
  const rows = unwrapList(payload, "users");
  const match = rows.find((row) => {
    const candidateEmail = String(row.email || row.email_address || row.username || row.login || "").trim().toLowerCase();
    const inactive = row.is_active === false || row.active === false || row.enabled === false || row.is_disabled === true || row.is_archived === true || row.deleted === true;
    return candidateEmail === key && !inactive;
  });
  const user = match ? {
    id: String(match.jnid || match.id || match.user_id || "").trim(),
    name: String(match.display_name || match.name || [match.first_name, match.last_name].filter(Boolean).join(" ") || key).trim()
  } : null;
  if (user && !user.id) return null;
  JOBNIMBUS_USER_CACHE.set(key, { user, expiresAt: Date.now() + 10 * 60 * 1000 });
  return user;
}

async function persistAutoEnrolledWaveUsers() {
  if (!AUTO_ENROLL_WAVE_USERS) return;
  const rows = [...WAVE_AUTH_USERS.values()]
    .filter((user) => user.role === "onboarding")
    .map((user) => ({
      email: user.email,
      name: user.name,
      enabled: user.enabled !== false,
      jobNimbusOwnerId: user.jobNimbusOwnerId,
      jobNimbusScope: "company"
    }));
  await writePrivateJsonFile(AUTO_ENROLLED_USER_STORE_PATH, rows);
}

async function effectiveEmployeeIdentity(identity) {
  if (!identity || identity.role !== "onboarding") return identity;
  const line = await authorizedQuoLine(identity);
  if (!line.number) return identity;
  return {
    ...identity,
    role: "employee",
    jobNimbusScope: "company"
  };
}

function sealOAuthPayload(payload) {
  if (!OAUTH_SESSION_SECRET) throw oauthError("temporarily_unavailable", "OAuth session encryption is not configured.", 503);
  const key = createHash("sha256").update(OAUTH_SESSION_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function openOAuthPayload(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || !OAUTH_SESSION_SECRET) throw oauthError("invalid_grant", "OAuth token is invalid.");
  try {
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
    const key = createHash("sha256").update(OAUTH_SESSION_SECRET).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
  } catch {
    throw oauthError("invalid_grant", "OAuth token is invalid.");
  }
}

function approvedChatGptRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["chat.openai.com", "chatgpt.com"].includes(url.hostname)
      && /^\/aip\/[^/]+\/oauth\/callback\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function oauthClientCredentials(req, form) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    const [clientId = "", clientSecret = ""] = Buffer.from(match[1], "base64").toString("utf8").split(":", 2);
    return { clientId, clientSecret };
  }
  return { clientId: String(form.client_id || ""), clientSecret: String(form.client_secret || "") };
}

function verifyPkce(payload, verifier) {
  if (!payload.codeChallenge) return;
  if (!verifier) throw oauthError("invalid_grant", "PKCE code verifier is required.");
  const calculated = payload.codeChallengeMethod === "S256"
    ? createHash("sha256").update(verifier).digest("base64url")
    : verifier;
  if (!secureEqual(calculated, payload.codeChallenge)) throw oauthError("invalid_grant", "PKCE verification failed.");
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanupUsedOAuthCodes() {
  const now = Date.now();
  for (const [key, expiresAt] of USED_OAUTH_CODES) if (expiresAt <= now) USED_OAUTH_CODES.delete(key);
}

function oauthError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.oauthCode = code;
  error.statusCode = statusCode;
  return error;
}

function sendOAuthError(res, status, error, description) {
  return send(res, status, { error, error_description: description });
}

function sendHcnOAuthError(res, error, setCookies = []) {
  return send(
    res,
    error?.statusCode || 400,
    {
      error: error?.code || error?.oauthCode || "invalid_request",
      error_description: error?.message || "HCN console sign-in failed."
    },
    {
      ...hcnNoStoreSecurityHeaders(),
      vary: "Cookie, Authorization",
      ...(setCookies.length ? { "set-cookie": setCookies } : {})
    }
  );
}

function redirectOAuthError(res, redirectUri, state, error) {
  const destination = new URL(redirectUri);
  destination.searchParams.set("error", error || "access_denied");
  if (state) destination.searchParams.set("state", state);
  res.writeHead(302, { location: destination.toString(), "cache-control": "no-store" });
  res.end();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function resolveCodexOperatorRequestScope(
  identity,
  method,
  pathname,
  body = {}
) {
  if (identity?.type !== "codex_operator_token") return "identity";
  const topLevelScope = body.operatorScope === undefined
    ? ""
    : String(body.operatorScope || "").trim().toLowerCase();
  if (topLevelScope && !["assigned", "company"].includes(topLevelScope)) {
    const error = new Error("operatorScope must be assigned or company.");
    error.statusCode = 400;
    throw error;
  }
  const scope = topLevelScope || "assigned";
  if (pathname === "/ops/action-batch") {
    for (const [index, operation] of (Array.isArray(body.operations) ? body.operations : []).entries()) {
      if (operation?.payload?.operatorScope !== undefined) {
        const operationScope = String(operation.payload.operatorScope || "").trim().toLowerCase();
        if (!["assigned", "company"].includes(operationScope)) {
          const error = new Error("operatorScope must be assigned or company.");
          error.statusCode = 400;
          throw error;
        }
        if (operationScope !== scope) {
          const error = new Error(
            `operations[${index}].payload.operatorScope must match the request operatorScope (${scope}).`
          );
          error.statusCode = 400;
          throw error;
        }
      }
    }
  }
  if (
    scope === "company"
    && identity.subject !== "codex-mac-operator"
  ) {
    const error = new Error(
      "Company exact-file scope is available only to the dedicated Mac operator."
    );
    error.statusCode = 403;
    throw error;
  }
  if (scope === "company") {
    assertCompanyOperatorRequestShape(method, pathname, body);
  }
  return scope;
}

function assertCompanyOperatorRequestShape(method, pathname, body = {}) {
  const supportedRoutes = new Set([
    "POST /jobnimbus/search",
    "POST /jobnimbus/review-file",
    "POST /ops/review-chance-files",
    "POST /jobnimbus/document-text",
    "POST /jobnimbus/document-review",
    "POST /jobnimbus/document-file",
    "POST /gmail/search",
    "POST /gmail/thread",
    "POST /gmail/attachment-review",
    "POST /quo/history",
    "POST /quo/transcript",
    "POST /ops/action-batch"
  ]);
  const route = `${String(method || "").toUpperCase()} ${pathname}`;
  if (!supportedRoutes.has(route)) {
    const error = new Error(
      "Company scope is limited to explicit exact-file review and approval-batch routes."
    );
    error.statusCode = 403;
    throw error;
  }
  if (pathname === "/ops/action-batch") {
    const operations = Array.isArray(body.operations) ? body.operations : [];
    if (!operations.length) return;
    for (const [index, operation] of operations.entries()) {
      if (
        String(operation?.payload?.operatorScope || "")
          .trim()
          .toLowerCase() !== "company"
      ) {
        const error = new Error(
          `operations[${index}].payload.operatorScope must be company for a company action batch.`
        );
        error.statusCode = 400;
        throw error;
      }
      if (
        !String(
          operation?.payload?.query
          || operation?.payload?.fileQuery
          || ""
        ).trim()
      ) {
        const error = new Error(
          `operations[${index}] requires an exact file query for company scope.`
        );
        error.statusCode = 400;
        throw error;
      }
    }
    return;
  }
  const query = [
    "/gmail/search",
    "/gmail/thread",
    "/gmail/attachment-review"
  ].includes(pathname)
    ? body.fileQuery
    : body.query;
  if (!String(query || "").trim()) {
    const error = new Error(
      "Company scope requires an exact JobNimbus number, claim number, full client name, or exact address."
    );
    error.statusCode = 400;
    throw error;
  }
}

function assertIdentityRequestScope(
  identity,
  method,
  pathname,
  body = {},
  operatorScope = "assigned"
) {
  if (
    pathname === "/retell/guarded-end-call"
    && identity?.type !== "retell_guarded_end_token"
  ) {
    const error = new Error("The guarded Retell end-call route accepts only its dedicated one-route credential.");
    error.statusCode = 403;
    throw error;
  }
  const claimFilingRoute = [
    "/claim-filing/configuration",
    "/claim-filing/prepare",
    "/claim-filing/call",
    "/claim-filing/result",
    "/claim-filing/callbacks"
  ].includes(pathname);
  if (
    claimFilingRoute
    && !(
      identity?.type === "codex_operator_token"
      && identity.subject === "codex-mac-operator"
    )
  ) {
    const error = new Error("Retell claim filing is available only to the dedicated Mac operator approval lane.");
    error.statusCode = 403;
    throw error;
  }
  if (identity?.type !== "codex_operator_token") return;
  if (["/claim-filing/prepare", "/claim-filing/call"].includes(pathname)) {
    if (!String(body.query || "").trim()) {
      const error = new Error("The Retell claim-filing operator requires one exact Chance-file query.");
      error.statusCode = 400;
      throw error;
    }
    if (body.includeCarrierBatch === true) {
      const error = new Error("The Retell claim-filing operator is single-file only; includeCarrierBatch cannot be true.");
      error.statusCode = 400;
      throw error;
    }
    if (!["file_new_claim", "find_existing_claim"].includes(String(body.goal || "file_new_claim").trim())) {
      const error = new Error("The Retell claim-filing operator supports only file_new_claim or find_existing_claim.");
      error.statusCode = 400;
      throw error;
    }
  }
  if (body.includeBrainAdvisory === true) {
    const error = new Error("The Codex operator cannot send client evidence to an operational advisory model.");
    error.statusCode = 403;
    throw error;
  }
  if (
    pathname === "/jobnimbus/document-text"
    && !String(body.documentQuery || "").trim()
  ) {
    const error = new Error("The Codex operator requires an exact documentQuery for document text review.");
    error.statusCode = 400;
    throw error;
  }
  if (
    String(method || "").toUpperCase() === "POST"
    && pathname === "/gmail/attachment-review"
    && body.uploadToJobNimbus === true
  ) {
    const error = new Error("The Codex operator may review Gmail attachments but cannot upload them directly to JobNimbus. Use an authorized human workflow for the upload.");
    error.statusCode = 403;
    throw error;
  }
  if (
    pathname === "/ops/start-session"
    && String(body.focus || "").trim().toLowerCase() === "communications"
  ) {
    const error = new Error("The Codex operator cannot run a broad unmatched communications sweep. Review one exact file instead.");
    error.statusCode = 403;
    throw error;
  }
  if (pathname === "/ops/review-chance-files" && !String(body.query || "").trim()) {
    if (body.indexOnly !== true) {
      const error = new Error("The Codex operator requires an exact-file query unless indexOnly:true is explicitly requested.");
      error.statusCode = 400;
      throw error;
    }
    if (body.includeGmail === true || body.includeQuo === true || body.includeQuoTranscripts === true) {
      const error = new Error("A query-less Codex operator index cannot include Gmail, Quo, or transcripts.");
      error.statusCode = 400;
      throw error;
    }
  }
  if (
    ["/gmail/search", "/gmail/thread", "/gmail/attachment-review"].includes(pathname)
    && !String(body.fileQuery || "").trim()
  ) {
    const error = new Error(
      `The Codex operator requires an exact ${
        operatorScope === "company" ? "company" : "Chance-assigned"
      } fileQuery for every Gmail read.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (
    ["/quo/history", "/quo/transcript"].includes(pathname)
    && !String(body.query || "").trim()
  ) {
    const error = new Error(
      `The Codex operator requires an exact ${
        operatorScope === "company" ? "company" : "Chance-assigned"
      } file query for every Quo read.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (pathname === "/quo/history" && String(body.phone || "").trim()) {
    const error = new Error("The Codex operator cannot query an arbitrary Quo phone number.");
    error.statusCode = 400;
    throw error;
  }
}

function assertHcnCookieRequestSafety(req, authentication) {
  if (authentication?.authenticationMethod !== "hcn_cookie") return;
  const method = String(req.method || "").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  if (!validateExactHcnOrigin(req.headers.origin, HCN_CONSOLE_ORIGIN)) {
    const error = new Error("HCN browser request origin is invalid.");
    error.statusCode = 403;
    throw error;
  }
  if (!HCN_CONSOLE_SESSION_STORE.validateSessionCsrf(
    authentication.hcnSessionId,
    req.headers["x-hcn-csrf"]
  )) {
    const error = new Error("HCN browser request CSRF token is invalid.");
    error.statusCode = 403;
    throw error;
  }
  const contentType = String(req.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("HCN browser unsafe requests require application/json.");
    error.statusCode = 415;
    throw error;
  }
}

function currentRequestIdentity() {
  return REQUEST_CONTEXT.getStore()?.identity || null;
}

function currentRequestAuthentication() {
  return REQUEST_CONTEXT.getStore() || null;
}

function requestGoogleAccessToken() {
  const identity = currentRequestIdentity();
  return identity?.type === "google_oauth" ? String(identity.googleAccessToken || "") : "";
}

function googleAccessConfiguredForRequest() {
  return Boolean(requestGoogleAccessToken() || (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN));
}

function isPublicRoute(method, pathname) {
  return (method === "GET" && ["/health", "/api/v1/meta", "/openapi.json", "/openapi-chatgpt.json", "/privacy", "/handoff", "/voice/twiml"].includes(pathname))
    || (method === "POST" && ["/handoff", "/handoff/chunk"].includes(pathname));
}

function bridgeTwilioToOpenAI(twilioSocket, req) {
  let streamSid = "";
  let callSid = "";
  const callId = voiceCallId(req);
  const log = ensureVoiceCallLog(callId, {
    goal: voiceContext(req).goal,
    prompt: voiceContext(req).prompt,
    voice: voiceContext(req).voice
  });
  let assistantTranscript = "";
  let openAiReady = false;
  let twilioStarted = false;
  let greetingSent = false;
  let assistantSpeaking = false;
  let closed = false;

  if (!OPENAI_API_KEY) {
    twilioSocket.close(1011, "OPENAI_API_KEY is not configured");
    return;
  }

  const openAiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: openAiRealtimeHeaders()
    }
  );

  openAiSocket.on("open", () => {
    sendOpenAI(openAiSocket, {
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: voiceInstructions(req),
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: OPENAI_INPUT_TRANSCRIPTION_MODEL
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: voiceContext(req).voice
          }
        }
      }
    });
  });

  openAiSocket.on("message", (raw) => {
    const event = parseSocketJson(raw);
    if (!event) return;

    if (event.type === "session.updated") {
      openAiReady = true;
      maybeSendGreeting();
      return;
    }

    if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
      if (!streamSid || !event.delta) return;
      assistantSpeaking = true;
      sendTwilio(twilioSocket, {
        event: "media",
        streamSid,
        media: { payload: event.delta }
      });
      return;
    }

    if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
      if (event.delta) assistantTranscript += event.delta;
      return;
    }

    if (event.type === "response.done") {
      assistantSpeaking = false;
      if (assistantTranscript.trim()) {
        appendVoiceTurn(log, "assistant", assistantTranscript.trim());
        assistantTranscript = "";
      }
      console.log(JSON.stringify({
        type: "openai_response_done",
        status: event.response?.status || null
      }));
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      appendVoiceTurn(log, "caller", event.transcript.trim());
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      if (assistantSpeaking && streamSid) {
        sendTwilio(twilioSocket, { event: "clear", streamSid });
        sendOpenAI(openAiSocket, { type: "response.cancel" });
      }
      return;
    }

    if (event.type === "error") {
      console.log(JSON.stringify({
        type: "openai_realtime_error",
        message: event.error?.message || "unknown error",
        code: event.error?.code || null
      }));
    }
  });

  openAiSocket.on("error", (error) => {
    console.log(JSON.stringify({ type: "openai_socket_error", message: error.message }));
  });
  openAiSocket.on("close", (code, reason) => {
    console.log(JSON.stringify({
      type: "openai_socket_closed",
      code,
      reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "")
    }));
    cleanup();
  });

  twilioSocket.on("message", (raw) => {
    const event = parseSocketJson(raw);
    if (!event) return;

    if (event.event === "start") {
      streamSid = event.start?.streamSid || "";
      callSid = event.start?.callSid || "";
      log.twilioCallSid = callSid;
      log.streamSid = streamSid;
      log.status = "connected";
      log.updatedAt = new Date().toISOString();
      twilioStarted = true;
      console.log(JSON.stringify({ type: "twilio_stream_started", callSid, streamSid }));
      maybeSendGreeting();
      return;
    }

    if (event.event === "media") {
      if (!event.media?.payload) return;
      sendOpenAI(openAiSocket, {
        type: "input_audio_buffer.append",
        audio: event.media.payload
      });
      return;
    }

    if (event.event === "stop") {
      log.status = "stopped";
      log.updatedAt = new Date().toISOString();
      console.log(JSON.stringify({ type: "twilio_stream_stopped", callSid, streamSid }));
      cleanup();
    }
  });

  twilioSocket.on("error", (error) => {
    console.log(JSON.stringify({ type: "twilio_socket_error", message: error.message }));
  });
  twilioSocket.on("close", (code, reason) => {
    console.log(JSON.stringify({
      type: "twilio_socket_closed",
      callSid,
      streamSid,
      code,
      reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || "")
    }));
    cleanup();
  });

  function maybeSendGreeting() {
    if (greetingSent || !openAiReady || !twilioStarted) return;
    greetingSent = true;
    sendOpenAI(openAiSocket, {
      type: "response.create",
      response: {
        instructions: "Start the call now using the call context. Keep it short."
      }
    });
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    log.status = log.status === "connected" ? "closed" : log.status;
    log.updatedAt = new Date().toISOString();
    if (openAiSocket.readyState === WebSocket.OPEN || openAiSocket.readyState === WebSocket.CONNECTING) {
      openAiSocket.close();
    }
    if (twilioSocket.readyState === WebSocket.OPEN || twilioSocket.readyState === WebSocket.CONNECTING) {
      twilioSocket.close();
    }
  }
}

function openAiRealtimeHeaders() {
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };
  if (!/^gpt-realtime-2(?:$|-)/.test(OPENAI_REALTIME_MODEL)) {
    headers["OpenAI-Beta"] = "realtime=v1";
  }
  return headers;
}

function voiceContext(req) {
  const url = new URL(req.url || "/", "http://localhost");
  return {
    callId: url.searchParams.get("callId") || "",
    goal: url.searchParams.get("goal") || "general_call",
    prompt: url.searchParams.get("prompt") || "",
    voice: normalizeRealtimeVoice(url.searchParams.get("voice") || OPENAI_VOICE)
  };
}

function voiceCallId(req) {
  return voiceContext(req).callId || randomUUID();
}

function voiceInstructions(req) {
  const { goal, prompt } = voiceContext(req);
  const isTest = /^test(?:_|$)/i.test(goal);
  const operationalInstructions = [
    "You are Chance Pearson's live phone assistant for property insurance claim operations.",
    "You are calling on behalf of Chance Pearson, a public adjuster, to move the insurance claim forward.",
    "Your job is to complete the exact call objective in the call context, not to test the phone connection.",
    "Start the call by stating the specific purpose from the call context.",
    "If you reach an IVR/menu, listen to the full prompt before responding. Use short spoken answers like: claims, property claim, existing claim, new claim, representative, or agent.",
    "If the IVR requires keypad-only input, say that keypad input is required and wait; do not invent information.",
    "If speaking to a human, be concise and professional. Identify as assisting Chance Pearson and ask for the specific result from the call context.",
    "Use only verified facts included in the call context. If a required fact is missing, ask for the minimum needed to continue.",
    "Capture claim number, adjuster name, phone, email, inspection date/time, document submission email, and next steps when provided.",
    "Do not mention internal tools, APIs, tokens, implementation details, OpenAI, Twilio, or testing unless this is explicitly a test call.",
    "Do not claim to be the homeowner."
  ];
  const testInstructions = [
    "You are Chance Pearson's live voice assistant for a connection test.",
    "This is explicitly a test call.",
    "Start by saying: Hey Chance, the OpenAI voice connection is live. I can hear you when you speak.",
    "Ask one simple confirmation question, then stop."
  ];
  return [
    ...(isTest ? testInstructions : operationalInstructions),
    "Speak naturally in short sentences. Ask one question at a time. Do not ramble.",
    `Call goal: ${goal}`,
    prompt ? `Call context and instructions: ${prompt}` : "No detailed call context was provided. Ask what the call is about before proceeding."
  ].filter(Boolean).join("\n\n");
}

function voiceStreamUrl() {
  const base = VOICE_PUBLIC_BASE_URL || PUBLIC_BASE_URL;
  const url = `${base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}${VOICE_STREAM_PATH}`;
  if (!VOICE_STREAM_TOKEN) return url;
  return `${url}/${encodeURIComponent(VOICE_STREAM_TOKEN)}`;
}

function voiceStreamUrlWithContext({ goal, prompt, voice, callId }) {
  const parsed = new URL(voiceStreamUrl());
  if (callId) parsed.searchParams.set("callId", String(callId));
  if (goal) parsed.searchParams.set("goal", String(goal).slice(0, 160));
  if (prompt) parsed.searchParams.set("prompt", String(prompt).slice(0, 3000));
  if (voice) parsed.searchParams.set("voice", normalizeRealtimeVoice(voice));
  return parsed.toString();
}

function voiceStreamAuthorized(url) {
  if (!VOICE_STREAM_TOKEN) return true;
  const pathToken = url.pathname.startsWith(`${VOICE_STREAM_PATH}/`)
    ? decodeURIComponent(url.pathname.slice(`${VOICE_STREAM_PATH}/`.length))
    : "";
  return pathToken === VOICE_STREAM_TOKEN || url.searchParams.get("token") === VOICE_STREAM_TOKEN;
}

function normalizeRealtimeVoice(value) {
  const voice = String(value || "").trim().toLowerCase();
  return REALTIME_VOICES.has(voice) ? voice : OPENAI_VOICE;
}

function initVoiceCallLog(callId, context) {
  const log = ensureVoiceCallLog(callId, context);
  log.status = "created";
  log.updatedAt = new Date().toISOString();
  return log;
}

function ensureVoiceCallLog(callId, context = {}) {
  const id = callId || randomUUID();
  if (!voiceCallLogs.has(id)) {
    voiceCallLogs.set(id, {
      callId: id,
      twilioCallSid: "",
      streamSid: "",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      context: cleanObject({
        to: context.to,
        from: context.from,
        goal: context.goal,
        prompt: context.prompt ? "[set]" : "",
        voice: context.voice
      }),
      turns: []
    });
  }
  return voiceCallLogs.get(id);
}

function appendVoiceTurn(log, speaker, text) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleanText) return;
  log.turns.push({
    speaker,
    text: cleanText,
    at: new Date().toISOString()
  });
  log.updatedAt = new Date().toISOString();
}

function summarizeVoiceCallLog(log) {
  return {
    callId: log.callId,
    twilioCallSid: log.twilioCallSid,
    streamSid: log.streamSid,
    status: log.status,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
    context: log.context,
    turnCount: log.turns.length
  };
}

async function createTwilioRealtimeCall({ to, from, streamUrl }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls.json`;
  const body = new URLSearchParams({
    To: to,
    From: from,
    Twiml: [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Response>",
      "  <Connect>",
      `    <Stream url="${escapeXml(streamUrl)}" />`,
      "  </Connect>",
      "</Response>"
    ].join("")
  });

  if (TWILIO_STATUS_CALLBACK_URL) {
    body.set("StatusCallback", TWILIO_STATUS_CALLBACK_URL);
    body.set("StatusCallbackEvent", "initiated ringing answered completed");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!response.ok) {
    const error = new Error(json.message || `Twilio call failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return json;
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("+")) return `+${text.slice(1).replace(/\D/g, "")}`;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return text;
}

function normalizeCarrierExtension(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length > 10) {
    badRequest("extension must contain 1 to 10 verified digits");
  }
  return digits;
}

function sendOpenAI(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendTwilio(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function parseSocketJson(raw) {
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    return null;
  }
}

async function readJson(req, maximumBytes = MAX_JSON_BODY_BYTES) {
  return (await readJsonEnvelope(req, maximumBytes)).body;
}

async function readJsonEnvelope(req, maximumBytes = MAX_JSON_BODY_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    const error = new Error("Request body limit is unavailable.");
    error.statusCode = 503;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      const error = new Error(`Request body too large. Limit is ${maximumBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks);
  const raw = rawBody.toString("utf8");
  if (!raw.trim()) return { body: {}, rawBody };
  try {
    return { body: JSON.parse(raw), rawBody };
  } catch {
    badRequest("Request body must be valid JSON.");
  }
}

function hcnApiBodyLimit(pathname) {
  return pathname === "/hcn/api/v1/action-plans/prepare"
    ? HCN_ACTION_PREPARE_BODY_BYTES
    : HCN_CONSOLE_API_BODY_BYTES;
}

async function readForm(req) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      const error = new Error("OAuth form body is too large.");
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) badRequest(`${name} is required`);
  return text;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  throw error;
}

function httpResponse(status, body, headers = {}) {
  return {
    [HTTP_RESPONSE]: true,
    status,
    body,
    headers
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff"
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff"
  });
  res.end(html);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveHcnConsoleOrigin(value) {
  const candidate = stripTrailingSlash(String(value || "").trim());
  if (!candidate || !validateExactHcnOrigin(candidate, candidate)) return "";
  try {
    return new URL(candidate).origin;
  } catch {
    return "";
  }
}

function centralIsoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "JobNimbus ChatGPT Bridge", version: "0.1.0" },
  servers: [{ url: "https://jobnimbus-chatgpt-bridge.onrender.com" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      hcnBrowserSession: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-hcn_session"
      }
    },
    schemas: {
      PlatformBuildInfo: {
        type: "object",
        additionalProperties: false,
        properties: {
          service: { type: "string", const: "jobnimbus-chatgpt-bridge" },
          apiVersion: { type: "string", const: "v1" },
          schemaVersion: { type: "string", const: "0.1.0" },
          sourceCommit: {
            type: ["string", "null"],
            pattern: "^[a-f0-9]{7,64}$"
          },
          sourceCommitTrust: {
            type: "string",
            enum: ["provider_attested", "declared", "invalid", "unavailable"]
          },
          buildId: { type: ["string", "null"] },
          deployId: { type: ["string", "null"] },
          runtime: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", const: "node" },
              version: { type: "string" },
              platform: { type: "string" },
              architecture: { type: "string" }
            },
            required: ["name", "version", "platform", "architecture"]
          },
          attested: { type: "boolean" }
        },
        required: [
          "service",
          "apiVersion",
          "schemaVersion",
          "sourceCommit",
          "sourceCommitTrust",
          "buildId",
          "deployId",
          "runtime",
          "attested"
        ]
      },
      PlatformRuntimeStatus: {
        type: "object",
        additionalProperties: false,
        properties: {
          brain: {
            type: "object",
            additionalProperties: false,
            properties: {
              advisory: { type: "string", enum: ["configured", "unconfigured", "disabled", "unknown"] },
              availability: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              clientMemory: { type: "string", enum: ["disabled", "legacy_restricted", "hcn_v2_minimized", "unknown"] },
              execution: { $ref: "#/components/schemas/PlatformGateStatus" },
              fallback: { type: "string", enum: ["configured", "unconfigured", "disabled", "unknown"] },
              legacyClientMemoryWrites: { $ref: "#/components/schemas/PlatformGateStatus" },
              persistence: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              snapshotSafety: { type: "string", enum: ["migration_required", "current", "unknown"] }
            },
            required: [
              "advisory",
              "availability",
              "clientMemory",
              "execution",
              "fallback",
              "legacyClientMemoryWrites",
              "persistence",
              "snapshotSafety"
            ]
          },
          connectors: {
            type: "object",
            additionalProperties: false,
            properties: {
              carrierFollowUp: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              claimFiling: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              clientCoordinator: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              gmail: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              googleCalendar: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              googleOAuth: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              jobNimbus: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              quo: { $ref: "#/components/schemas/PlatformConfigurationStatus" },
              realtimeVoice: { $ref: "#/components/schemas/PlatformConfigurationStatus" }
            },
            required: [
              "carrierFollowUp",
              "claimFiling",
              "clientCoordinator",
              "gmail",
              "googleCalendar",
              "googleOAuth",
              "jobNimbus",
              "quo",
              "realtimeVoice"
            ]
          },
          controls: {
            type: "object",
            additionalProperties: false,
            properties: {
              actionBatchOnly: { $ref: "#/components/schemas/PlatformGateStatus" },
              automaticEmailOrTextSending: { $ref: "#/components/schemas/PlatformGateStatus" },
              changedPayloadInvalidatesApproval: { $ref: "#/components/schemas/PlatformGateStatus" },
              claimFilingApprovalLane: { $ref: "#/components/schemas/PlatformGateStatus" },
              directEffectRoutes: { $ref: "#/components/schemas/PlatformGateStatus" },
              exactDryRunDigestRequired: { $ref: "#/components/schemas/PlatformGateStatus" },
              explicitChanceApprovalRequired: { $ref: "#/components/schemas/PlatformGateStatus" },
              jobNimbusWritesActionBatchOnly: { $ref: "#/components/schemas/PlatformGateStatus" },
              modelCanExecute: { $ref: "#/components/schemas/PlatformGateStatus" },
              roleEnforcement: { $ref: "#/components/schemas/PlatformGateStatus" },
              schedulingFailClosed: { $ref: "#/components/schemas/PlatformGateStatus" },
              shortLivedSingleUseChallengeRequired: { $ref: "#/components/schemas/PlatformGateStatus" }
            },
            required: [
              "actionBatchOnly",
              "automaticEmailOrTextSending",
              "changedPayloadInvalidatesApproval",
              "claimFilingApprovalLane",
              "directEffectRoutes",
              "exactDryRunDigestRequired",
              "explicitChanceApprovalRequired",
              "jobNimbusWritesActionBatchOnly",
              "modelCanExecute",
              "roleEnforcement",
              "schedulingFailClosed",
              "shortLivedSingleUseChallengeRequired"
            ]
          },
          gates: {
            type: "object",
            additionalProperties: false,
            properties: {
              carrierFollowUpCalls: { $ref: "#/components/schemas/PlatformGateStatus" },
              claimFilingCalls: { $ref: "#/components/schemas/PlatformGateStatus" },
              clientCoordinatorAppointmentCalls: { $ref: "#/components/schemas/PlatformGateStatus" },
              clientCoordinatorExpandedCalls: { $ref: "#/components/schemas/PlatformGateStatus" },
              externalWrites: { $ref: "#/components/schemas/PlatformGateStatus" },
              gmailSend: { $ref: "#/components/schemas/PlatformGateStatus" },
              hcnActionExecution: { $ref: "#/components/schemas/PlatformGateStatus" },
              quoSend: { $ref: "#/components/schemas/PlatformGateStatus" },
              realtimeVoiceCalls: { $ref: "#/components/schemas/PlatformGateStatus" }
            },
            required: [
              "carrierFollowUpCalls",
              "claimFilingCalls",
              "clientCoordinatorAppointmentCalls",
              "clientCoordinatorExpandedCalls",
              "externalWrites",
              "gmailSend",
              "hcnActionExecution",
              "quoSend",
              "realtimeVoiceCalls"
            ]
          },
          configurationDrift: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope: { type: "string", const: "release_critical_effect_gates" },
              monitoredKeys: {
                type: "array",
                items: { $ref: "#/components/schemas/PlatformReleaseGateKey" },
                uniqueItems: true
              },
              status: { type: "string", enum: ["aligned", "detected", "unknown"] },
              differences: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    key: { $ref: "#/components/schemas/PlatformReleaseGateKey" },
                    checkedIn: { $ref: "#/components/schemas/PlatformGateStatus" },
                    runtime: { $ref: "#/components/schemas/PlatformGateStatus" }
                  },
                  required: ["key", "checkedIn", "runtime"]
                }
              },
              unknown: {
                type: "array",
                items: { $ref: "#/components/schemas/PlatformReleaseGateKey" },
                uniqueItems: true
              }
            },
            required: ["scope", "monitoredKeys", "status", "differences", "unknown"]
          }
        },
        required: ["brain", "connectors", "controls", "gates", "configurationDrift"]
      },
      PlatformConfigurationStatus: {
        type: "string",
        enum: ["configured", "unconfigured", "unknown"]
      },
      PlatformGateStatus: {
        type: "string",
        enum: ["enabled", "disabled", "unknown"]
      },
      PlatformReleaseGateKey: {
        type: "string",
        enum: [
          "ALLOW_CARRIER_FOLLOWUP_CALLS",
          "ALLOW_CLIENT_COORDINATOR_CALLS",
          "ALLOW_GMAIL_SEND",
          "ALLOW_LEGACY_CLIENT_MEMORY_WRITES",
          "ALLOW_QUO_SEND",
          "ALLOW_RETELL_CALLS",
          "ALLOW_RETELL_CLAIM_CALLS",
          "ALLOW_VOICE_CALLS",
          "BRIDGE_ALLOW_WRITES",
          "HCN_ACTION_EXECUTION_ENABLED"
        ]
      },
      PlatformMetadataResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          schemaVersion: { type: "string", const: "hcn.platform.meta.v1" },
          generatedAt: { type: "string", format: "date-time" },
          build: { $ref: "#/components/schemas/PlatformBuildInfo" },
          capabilityCatalog: {
            type: "object",
            additionalProperties: false,
            properties: {
              schema: { type: "string", const: "hcn.platform.capability-descriptor" },
              schemaVersion: { type: "string", const: "1.0.0" },
              capabilityVersion: { type: "string" },
              semantics: { type: "string", const: "route_authorization_only" },
              effectiveAvailability: { type: "string", const: "combine_with_runtime" }
            },
            required: [
              "schema",
              "schemaVersion",
              "capabilityVersion",
              "semantics",
              "effectiveAvailability"
            ]
          },
          runtime: { $ref: "#/components/schemas/PlatformRuntimeStatus" },
          boundaries: {
            type: "object",
            additionalProperties: false,
            properties: {
              chanceBrain: { type: "string", const: "legacy_read_only_non_operator_paths" },
              hcnV2ChanceBrainDataFlow: { type: "string", const: "disconnected" },
              jobrolo: { type: "string", const: "disconnected" },
              hcnOperationsBrain: { type: "string", const: "v2_foundation" },
              legacyClientMemory: { type: "string", const: "migration_required" }
            },
            required: [
              "chanceBrain",
              "hcnV2ChanceBrainDataFlow",
              "jobrolo",
              "hcnOperationsBrain",
              "legacyClientMemory"
            ]
          }
        },
        required: ["schemaVersion", "generatedAt", "build", "capabilityCatalog", "runtime", "boundaries"]
      },
      PlatformSessionResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          schemaVersion: { type: "string", const: "hcn.platform.session.v1" },
          generatedAt: { type: "string", format: "date-time" },
          authenticated: { type: "boolean" },
          build: { $ref: "#/components/schemas/PlatformBuildInfo" },
          identity: {
            type: "object",
            additionalProperties: false,
            properties: {
              authentication: { type: "string", enum: ["authenticated", "unsupported"] },
              type: { type: "string", enum: ["codex_operator", "google_oauth", "hcn_browser_session", "unsupported"] },
              role: {
                type: "string",
                enum: ["chance", "administrator", "employee", "onboarding", "client_coordinator", "manager", "codex_operator", "unsupported"]
              },
              jobNimbusScope: { type: "string", enum: ["assigned", "company", "none"] },
              gmailMode: {
                type: "string",
                enum: ["exact_assigned_file_evidence", "signed_in_employee_mailbox", "none"]
              }
            },
            required: ["authentication", "type", "role", "jobNimbusScope", "gmailMode"]
          },
          authorizedCapabilities: {
            type: "array",
            items: { type: "string", pattern: "^[a-z][a-z0-9_.]*$" },
            uniqueItems: true
          },
          runtime: { $ref: "#/components/schemas/PlatformRuntimeStatus" },
          descriptorHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
        },
        required: [
          "schemaVersion",
          "generatedAt",
          "authenticated",
          "build",
          "identity",
          "authorizedCapabilities",
          "runtime",
          "descriptorHash"
        ]
      },
      PlatformErrorResponse: {
        type: "object",
        additionalProperties: false,
        properties: {
          error: { type: "string" }
        },
        required: ["error"]
      },
      SearchRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address to search for." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Defaults to assigned. Company requires one strong exact-file match and never permits a broad company sweep." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"]
      },
      ReviewFileRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address for the file to review." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company scope must resolve one exact company insurance file." }
        },
        required: ["query"]
      },
      AssignedFilesRequest: {
        type: "object",
        properties: {
          ownerId: { type: "string", description: "JobNimbus owner/user id. Defaults to Chance Pearson." },
          activeOnly: { type: "boolean", default: true, description: "When true, excludes closed, archived, and inactive files." },
          limit: { type: "integer", minimum: 1, maximum: 250, default: 100 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 }
        }
      },
      AssignedCountsRequest: {
        type: "object",
        properties: {
          ownerId: { type: "string", description: "JobNimbus owner/user id. Defaults to Chance Pearson." },
          sampleLimit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 }
        }
      },
      SchedulingAvailabilityRequest: {
        type: "object",
        description: "Read-only unified availability check for Chance Pearson. Merges active Chance-assigned JobNimbus calendar tasks with Google Calendar and fails closed if either source is unavailable.",
        properties: {}
      },
      DocumentTextRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier. Chance-assigned files are preferred. An exact, unambiguous JobNimbus number, claim number, client name, or address may be used for an explicitly named company-file read; this never expands write access." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company scope remains exact-file and read-only on this route." },
          documentQuery: { type: "string", description: "Document id, name, or partial filename. If omitted, the first related document is used." },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 12000 },
          forceOcr: { type: "boolean", default: false, description: "When true, OCR is attempted even if PDF text extraction finds text." },
          maxOcrPages: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum PDF pages to OCR." }
        },
        required: ["query"]
      },
      DocumentReviewRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier. Chance-assigned files are preferred. An exact, unambiguous JobNimbus number, claim number, client name, or address may be used for an explicitly named company-file read; this never expands write access." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company scope remains exact-file and read-only on this route." },
          documentQuery: { type: "string", description: "Exact document id/name or a unique partial filename. Use this when a specific filename is known." },
          documentPurpose: {
            type: "string",
            enum: ["insurance_policy", "tdi_form", "estimate_scope", "carrier_claim_document", "appraisal_document", "representation_contract"],
            description: "Use this for natural-language requests such as review the insurance policy. The bridge selects one unique operational document and rejects ambiguity. Either documentQuery or documentPurpose is required."
          },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
          previewChars: { type: "integer", minimum: 500, maximum: 12000, default: 4000 },
          forceOcr: { type: "boolean", default: false, description: "When true, OCR is attempted even if PDF text extraction finds text." },
          maxOcrPages: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum PDF pages to OCR." }
        },
        required: ["query"]
      },
      DocumentReviewResponse: {
        type: "object",
        properties: {
          file: { type: "object", additionalProperties: true },
          readScope: { type: "string" },
          document: { type: "object", additionalProperties: true },
          contentType: { type: "string" },
          bytes: { type: "integer" },
          extraction: { type: "string" },
          pageCount: { type: ["integer", "null"] },
          truncated: { type: "boolean" },
          extractionError: { type: "string" },
          textPreview: { type: "string" },
          review: { type: "object", additionalProperties: true },
          nativeReviewRequired: { type: "boolean" },
          reviewInstruction: { type: "string" },
          openaiFileResponse: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { $ref: "#/components/schemas/ChatGPTFileReturn" }
          }
        },
        required: ["file", "readScope", "document", "contentType", "bytes", "extraction", "truncated", "extractionError", "textPreview", "review", "nativeReviewRequired"]
      },
      DocumentFileRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact file/client identifier, preferably JobNimbus number, claim number, exact client name, or exact address." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company scope remains exact-file and read-only on this route." },
          documentQuery: { type: "string", description: "Required exact document id/name or a unique partial filename. Ambiguous matches are rejected." },
          documentId: { type: "string", description: "Alias for documentQuery." }
        },
        required: ["query", "documentQuery"]
      },
      ChatGPTFileReturn: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename visible in the ChatGPT conversation." },
          mime_type: { type: "string", description: "Verified MIME type used by ChatGPT file tools." },
          content: { type: "string", format: "byte", description: "Original JobNimbus document bytes encoded as base64." }
        },
        required: ["name", "mime_type", "content"]
      },
      DocumentFileResponse: {
        type: "object",
        properties: {
          file: { type: "object", additionalProperties: true },
          readScope: {
            type: "string",
            enum: ["chance_assigned", "explicit_company_read", "explicit_company_file", "explicit_company_document_read"],
            description: "Shows whether the read resolved inside Chance's assigned files or through an exact, unambiguous company-file lookup. This does not grant write access."
          },
          document: { type: "object", additionalProperties: true },
          bytes: { type: "integer" },
          contentType: { type: "string" },
          reviewInstruction: { type: "string" },
          openaiFileResponse: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { $ref: "#/components/schemas/ChatGPTFileReturn" }
          }
        },
        required: ["file", "readScope", "document", "bytes", "contentType", "reviewInstruction", "openaiFileResponse"]
      },
      PhotoReviewRequest: {
        type: "object",
        description: "Read-only two-step photo workflow. Catalog mode returns small candidate batches without image bytes. Attach mode converts only one exact batch or up to six exact photo ids into a PDF for native visual review.",
        properties: {
          query: { type: "string", description: "Exact JobNimbus number, client name, claim number, or address. Chance-assigned files are preferred; exact company-file reads remain read-only." },
          mode: { type: "string", enum: ["catalog", "attach_batch"], default: "catalog" },
          catalogLimit: { type: "integer", minimum: 1, maximum: 25, default: 12, description: "Maximum candidate batches returned in catalog mode." },
          batchKey: { type: "string", description: "Exact batchKey returned by catalog mode. Required for attach_batch unless photoIds are supplied." },
          photoIds: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            items: { type: "string" },
            description: "One to six exact JobNimbus photo ids from catalog mode. Use when a batch needs narrower review."
          },
          offset: { type: "integer", minimum: 0, default: 0, description: "Batch offset for reviewing the next group without loading the entire photo set." },
          limit: { type: "integer", minimum: 1, maximum: 6, default: 6, description: "Maximum photos converted into the returned review PDF." }
        },
        required: ["query"]
      },
      PhotoReviewResponse: {
        type: "object",
        properties: {
          mode: { type: "string" },
          file: { type: "object", additionalProperties: true },
          readScope: { type: "string" },
          photoCount: { type: "integer" },
          batchCount: { type: "integer" },
          candidateBatches: { type: "array", items: { type: "object", additionalProperties: true } },
          omittedBatchCount: { type: "integer" },
          instruction: { type: "string" },
          selection: { type: "object", additionalProperties: true },
          reviewInstruction: { type: "string" },
          openaiFileResponse: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { $ref: "#/components/schemas/ChatGPTFileReturn" }
          }
        },
        required: ["mode", "file", "readScope"]
      },
      DateOfLossResearchRequest: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Exact JobNimbus number, claim number, client name, or address. Chance files are preferred; an explicitly named exact company file is read-only."
          },
          startDate: { type: "string", format: "date", description: "Optional search start in YYYY-MM-DD. Defaults to two years before endDate." },
          endDate: { type: "string", format: "date", description: "Optional search end in YYYY-MM-DD. Defaults to today in America/Chicago." },
          radiusMiles: { type: "number", minimum: 1, maximum: 100, default: 35 },
          minimumHailInches: { type: "number", minimum: 0.25, maximum: 6, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
        },
        required: ["query"]
      },
      JobNimbusUploadFileRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          filename: { type: "string", description: "Filename to store in JobNimbus, including the file extension." },
          description: { type: "string", description: "Optional short description for the JobNimbus document." },
          contentBase64: { type: "string", description: "Base64-encoded file content. Maximum decoded size is 8 MB." },
          isPrivate: { type: "boolean", default: false, description: "Whether JobNimbus should mark the document private." },
          execute: { type: "boolean", default: false, description: "When false, returns a dry-run plan. True requires bridge writes to be enabled." }
        },
        required: ["query", "filename", "contentBase64"]
      },
      UpdateContactRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          fields: { type: "object", additionalProperties: true, description: "Exact JobNimbus contact fields to update. For DOL, pass dateOfLoss, DOL, Date of Loss, or cf_date_1 with a YYYY-MM-DD value; the bridge normalizes it to JobNimbus cf_date_1. After changing DOL, read the file back and prepare any claim call again from fresh state." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "fields"]
      },
      UpdateStatusRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          status: { type: "string", description: "JobNimbus workflow/status name, such as Submitted Awaiting Confirmation or Awaiting 2 Key Confirmations." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "status"]
      },
      ProcessUpdateRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier. Can be name, JobNimbus number, claim number, policy number, phone, email, or address." },
          job: { type: "string", description: "Alias for query." },
          client: { type: "string", description: "Alias for query." },
          fields: {
            type: "object",
            additionalProperties: true,
            description: "Exact JobNimbus contact fields to update. For DOL, pass dateOfLoss, DOL, Date of Loss, or cf_date_1 with a YYYY-MM-DD value; the bridge normalizes it to JobNimbus cf_date_1. After changing DOL, read the file back and prepare any claim call again from fresh state."
          },
          status: { type: "string", description: "Optional JobNimbus workflow/status name to set." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          note: { type: "string", description: "Optional internal JobNimbus note to create." },
          internalNote: { type: "string", description: "Alias for note." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run plan only. True requires bridge writes to be enabled." }
        }
      },
      CreateNoteRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          note: { type: "string", description: "Short JobNimbus note text." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "note"]
      },
      CreateTaskRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          title: { type: "string", description: "Task title." },
          description: { type: "string", description: "Task details." },
          note: { type: "string", description: "Optional task note/details." },
          dueDate: { type: "string", description: "Date as YYYY-MM-DD, Unix timestamp, or ISO datetime with an explicit offset. Never send a timezone-free appointment time." },
          dateStart: { type: "string", description: "ISO datetime with an explicit offset, such as 2026-07-15T14:00:00-05:00, or a Unix timestamp." },
          dateEnd: { type: "string", description: "ISO datetime with an explicit offset, such as 2026-07-15T16:00:00-05:00, or a Unix timestamp." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "title"]
      },
      UpdateTaskRequest: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "JobNimbus task id." },
          fields: { type: "object", additionalProperties: true, description: "Task fields to update. dateStart/dateEnd timestamps must include an explicit UTC offset; YYYY-MM-DD and Unix timestamps are also accepted." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["taskId", "fields"]
      },
      CreateCalendarEventRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "File/client identifier." },
          title: { type: "string", description: "Calendar event title." },
          dateStart: { type: "string", description: "ISO datetime with an explicit offset, such as 2026-07-15T14:00:00-05:00, or a Unix timestamp. Timezone-free times are rejected." },
          dateEnd: { type: "string", description: "ISO datetime with an explicit offset, such as 2026-07-15T16:00:00-05:00, or a Unix timestamp. Timezone-free times are rejected." },
          location: { type: "string", description: "Event location. Defaults to the file property address." },
          description: { type: "string", description: "Event details." },
          note: { type: "string", description: "Optional event note/details." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["query", "title", "dateStart"]
      },
      UpdateCalendarEventRequest: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "JobNimbus activity/event id." },
          query: { type: "string", description: "Optional Chance file identifier so the update is ownership-verified and recorded on that file's private action history." },
          fields: { type: "object", additionalProperties: true, description: "Calendar event fields to update. dateStart/dateEnd timestamps must include an explicit UTC offset; timezone-free times are rejected." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." }
        },
        required: ["eventId", "fields"]
      },
      GmailSearchRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query. Use Gmail operators like from:, to:, subject:, newer_than:, older_than:, has:attachment, or plain client/claim terms." },
          fileQuery: { type: "string", description: "Exact Chance-assigned JobNimbus file identifier. Required for the Codex operator; its Gmail search is built server-side from current file facts." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires fileQuery and exact-file correlation." },
          communicationDays: { type: "integer", minimum: 1, maximum: 3650, default: 365 },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        anyOf: [
          { required: ["query"] },
          { required: ["fileQuery"] }
        ]
      },
      GmailThreadRequest: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Gmail thread id returned by searchGmail." },
          fileQuery: { type: "string", description: "Exact JobNimbus file identifier. Required for the Codex operator so the thread is strongly correlated before disclosure." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires exact-file correlation." }
        },
        required: ["threadId"]
      },
      GmailAttachmentReviewRequest: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Gmail message id containing the attachment." },
          attachmentId: { type: "string", description: "Gmail attachment id returned by readGmailThread." },
          filename: { type: "string" },
          contentType: { type: "string" },
          maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 20000 },
          previewChars: { type: "integer", minimum: 500, maximum: 12000, default: 8000 },
          forceOcr: { type: "boolean", default: false },
          maxOcrPages: { type: "integer", minimum: 1, maximum: 20, default: 5 },
          uploadToJobNimbus: { type: "boolean", default: false, description: "When true, also prepares an upload to the exact Chance file." },
          query: { type: "string", description: "Required when uploadToJobNimbus is true." },
          fileQuery: { type: "string", description: "Exact Chance-assigned JobNimbus file identifier. Required for Codex operator read scope." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires exact-file correlation and does not permit direct upload." },
          description: { type: "string" },
          isPrivate: { type: "boolean", default: false },
          execute: { type: "boolean", default: false, description: "Only affects the optional JobNimbus upload. Attachment review itself is read-only." }
        },
        required: ["messageId", "attachmentId", "filename"]
      },
      GmailAttachmentSpec: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["jobnimbus", "generated_lor", "standard_w9", "base64"], default: "jobnimbus", description: "Use generated_lor to build the standard one-page Wave LOR from the current Chance file, standard_w9 only for the exact pinned Gmail message/attachment/SHA-256, jobnimbus for TDI/FIN535 and other client documents, or base64 only for an already verified external file." },
          query: { type: "string", description: "Chance file identifier. May be inherited from the message-level query." },
          documentQuery: { type: "string", description: "JobNimbus document id or filename." },
          documentId: { type: "string", description: "Alias for documentQuery." },
          filename: { type: "string", description: "Optional safe output filename, or required for base64 attachments." },
          contentType: { type: "string" },
          contentBase64: { type: "string", description: "Only for source=base64. JobNimbus documents are fetched server-side." },
          insuredName: { type: "string", description: "For generated_lor only. Use when a signed TDI/FIN535 verifies a spelling that differs from the JobNimbus display name." },
          carrier: { type: "string", description: "Optional verified carrier override for generated_lor." },
          claimNumber: { type: "string", description: "Optional verified claim-number override for generated_lor when JobNimbus has not yet been updated." },
          dateOfLoss: { type: "string", description: "Optional verified DOL override for generated_lor." },
          letterDate: { type: "string", description: "Optional LOR date. Defaults to the current date." }
        }
      },
      GmailMessageRequest: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "Existing Gmail draft id. For send-after-review, provide this instead of rebuilding to/subject/body; Gmail sends and removes that exact draft." },
          to: { type: "string", description: "Recipient email address or comma-separated addresses." },
          cc: { type: "string", description: "Optional CC recipients." },
          bcc: { type: "string", description: "Optional BCC recipients." },
          subject: { type: "string", description: "Email subject. For insurance emails, use claim number only when applicable." },
          body: { type: "string", description: "Plain text email body. When the verified attachments contain LOR + FIN535/TDI + W-9, the bridge replaces this with Richard's standard payment-redirection template instead of allowing improvised wording." },
          template: { type: "string", enum: ["payment_redirection"], description: "Use payment_redirection for the standard LOR + FIN535/TDI + W-9 carrier packet. The bridge builds the approved body from the current JobNimbus policyholder and ignores improvised body text." },
          policyholderName: { type: "string", description: "Optional verified policyholder spelling for payment redirection. Prefer the signed TDI/FIN535 spelling when it conflicts with JobNimbus." },
          threadId: { type: "string", description: "Optional Gmail thread id to reply in an existing thread." },
          query: { type: "string", description: "Chance file identifier used for JobNimbus attachments, ownership validation, and the private action receipt." },
          fileQuery: { type: "string", description: "Alias for query." },
          attemptId: { type: "string", description: "Defaults to initial. After a failed/uncertain send, use a new explicit value only when Chance approves a fresh retry dry run." },
          attachments: { type: "array", maxItems: 8, items: { $ref: "#/components/schemas/GmailAttachmentSpec" }, description: "Verified attachments. Prefer source=jobnimbus so the bridge fetches and validates the exact document bytes." },
          approvalDigest: { type: "string", description: "Required for a live draft or send. Must exactly match the immediately preceding unchanged dry run." },
          execute: { type: "boolean", default: false, description: "False returns a dry run. A live draft or send additionally requires its server-side gate and the exact approvalDigest." }
        },
        anyOf: [
          { required: ["draftId"] },
          { required: ["to", "subject", "body"] },
          { required: ["to", "subject", "template", "query"] }
        ]
      },
      QuoHistoryRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact Chance file identifier. Required for the Codex operator; its current phone number is always used." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires an exact file query; arbitrary phone lookup remains blocked." },
          phone: { type: "string", description: "US phone number. Used when query is omitted or as an explicit override." },
          maxResults: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          includeTranscripts: { type: "boolean", default: false, description: "Try to include transcripts for up to the three most recent recorded calls." }
        }
      },
      QuoLineLinkRequest: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["status", "start", "verify"], default: "status", description: "Use status to inspect the current link, start to text a code to a company Quo number, or verify to submit the six-digit code." },
          phone: { type: "string", description: "Employee's company Quo business number. Required for mode=start." },
          number: { type: "string", description: "Alias for phone." },
          code: { type: "string", pattern: "^[0-9]{6}$", description: "Six-digit code received in Quo. Required for mode=verify." }
        },
        required: ["mode"]
      },
      QuoTranscriptRequest: {
        type: "object",
        properties: {
          callId: { type: "string" },
          query: { type: "string", description: "Exact JobNimbus file identifier. Required for the Codex operator so call membership is verified before transcript disclosure." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires exact-file call membership verification." }
        },
        required: ["callId"]
      },
      QuoSendRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact Chance file identifier. Required for ownership validation and private receipt." },
          to: { type: "string", description: "Destination override. Defaults to the current JobNimbus file phone." },
          content: { type: "string", maxLength: 1600, description: "Exact text Chance will approve." },
          message: { type: "string", maxLength: 1600, description: "Alias for content." },
          text: { type: "string", maxLength: 1600, description: "Alias for content. Accepted for compatibility with assistants that label an SMS body as text." },
          attemptId: { type: "string", description: "Defaults to initial. After a failed/uncertain send, use a new explicit value only when Chance approves a fresh retry dry run." },
          approvalDigest: { type: "string", description: "Required for a live send and must exactly match the immediately preceding dry run." },
          execute: { type: "boolean", default: false, description: "False returns a dry run. True also requires ALLOW_QUO_SEND=true and the exact approvalDigest." }
        },
        required: ["query"],
        anyOf: [
          { required: ["content"] },
          { required: ["message"] },
          { required: ["text"] }
        ]
      },
      MemoryFileActionsRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact Chance file identifier." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          maxPerSection: { type: "integer", minimum: 1, maximum: 25, default: 15 }
        },
        required: ["query"]
      },
      MemoryPersistenceCheckRequest: {
        type: "object",
        properties: {
          label: { type: "string", description: "Harmless probe label." },
          execute: { type: "boolean", default: false, description: "False reads prior probes. True records one approved local persistence probe only." }
        }
      },
      ChanceReviewRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional exact Chance file. Omit for a paginated Chance-only sweep." },
          operatorScope: { type: "string", enum: ["assigned", "company"], description: "Dedicated Mac operator only. Company requires query and always reviews exactly one file; queryless company indexes are blocked." },
          indexOnly: { type: "boolean", default: false, description: "Use true first for a lightweight current index of every active Chance file. Then deep-review one selected file using query and limit 1." },
          page: { type: "integer", minimum: 1, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Use 1 for full evidence reviews so JobNimbus, Gmail, Quo, documents, tasks, and receipts fit within connector response limits." },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 },
          activeOnly: { type: "boolean", default: true },
          includeGmail: { type: "boolean", default: true },
          includeQuo: { type: "boolean", default: true, description: "When true, reads matching homeowner/adjuster communications across every Quo team line, including other employees' lines, as evidence only." },
          includeQuoTranscripts: { type: "boolean", default: false },
          includeBrainAdvisory: { type: "boolean", default: false, description: "Requests one bounded no-tools model advisory over evidence-backed open loops. The result is a candidate and cannot execute or approve anything." },
          communicationDays: { type: "integer", minimum: 1, maximum: 3650, default: 365 },
          gmailLimit: { type: "integer", minimum: 1, maximum: 15, default: 8 },
          gmailThreadLimit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
          quoLimit: { type: "integer", minimum: 1, maximum: 50, default: 25 }
        }
      },
      ActionOperation: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "jobnimbus.update_contact", "jobnimbus.update_status", "jobnimbus.process_update",
              "jobnimbus.create_note", "jobnimbus.create_task", "jobnimbus.update_task",
              "jobnimbus.ensure_current_task",
              "jobnimbus.create_calendar_event", "jobnimbus.update_calendar_event",
              "gmail.create_draft", "gmail.send", "gmail.send_existing_draft", "quo.send_text"
            ]
          },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Exact payload. Do not include execute or approvalDigest. Examples: task {query:'JN',taskId:'ID',completed:true}; calendar update {query:'JN',eventId:'ID',fields:{...}}; note {query:'JN',note:'Exact'}; fields/status {query:'JN',fields:{...},status:'Exact'}; first Gmail draft with exact content. In the locked assigned-file lane, a reviewed bridge draft may be sent later only with gmail.send_existing_draft {query:'JN',draftId:'RETURNED_DRAFT_ID'}; never recreate or raw-send a second copy."
          }
        },
        required: ["type", "payload"]
      },
      ActionBatchRequest: {
        type: "object",
        properties: {
          operatorScope: {
            type: "string",
            enum: ["assigned", "company"],
            default: "assigned",
            description: "Dedicated Mac operator only. Defaults to assigned. Company batches require this top-level value plus matching company scope on every operation payload and remain limited to one exact company file."
          },
          runPolicy: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
            },
            required: ["id", "sha256"],
            description: "Pinned by the local Mac plugin. The model must not choose or alter this value."
          },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 15,
            items: { $ref: "#/components/schemas/ActionOperation" },
            description: "Every exact approved action. The dedicated Mac assigned-file lane may group contact corrections, forward stage moves, and one protected current-control task across at most five exact manifest files, ordered contact then status then task per file. Gmail draft creation and the later reviewed existing-draft send are separate sole-operation batches. Raw/direct sends, task completion, notes, calls, calendar writes, backward stages, company mutation scope, and every other effect are blocked by the locked run policy."
          },
          approvalDigest: { type: "string", description: "Required for execution. Must match the immediately preceding unchanged batch dry run." },
          approvalChallenge: { type: "string", description: "Single-use, short-lived server challenge returned by the immediately preceding dry run. The local operator wrapper retains and forwards it; do not copy it into chat." },
          execute: { type: "boolean", default: false, description: "False prepares the exact batch and issues a short-lived challenge. True consumes that challenge once after Chance approves the exact plan. Duplicate execution is blocked." }
        },
        required: ["operations"]
      },
      ActionBatchReceiptRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          batchId: { type: "string", format: "uuid" },
          fileNumber: { type: "string", pattern: "^#?\\d+$" },
          statuses: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 25 }
        }
      },
      ActionBatchReconcileRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          batchId: { type: "string", format: "uuid" }
        },
        required: ["batchId"]
      },
      ClaimFilingPrepareRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Chance Pearson JobNimbus file identifier. Prefer JobNimbus number, claim number, or exact address." },
          goal: { type: "string", enum: ["file_new_claim", "find_existing_claim", "status_follow_up", "lor_destination", "inspection_scheduling", "adjuster_assignment"], default: "file_new_claim" },
          to: { type: "string", description: "Optional carrier destination override in E.164 or US format." },
          carrierPhone: { type: "string", description: "Alias for an approved carrier filing phone override." },
          stormTime: { type: "string", description: "Optional Chance-approved or document-verified time. Omit vague guesses: the bridge automatically matches the confirmed JobNimbus DOL to nearby public NWS hail reports and adds a sourced approximate time when available." },
          occupancy: { type: "string" },
          damageDiscovered: { type: "string" },
          propertyStories: { type: "string", description: "Verified number of stories, for example 'One story'. Never guess." },
          roofAccessibility: { type: "string", description: "Verified roof access/steepness answer. Never guess." },
          damagedRooms: { type: "string", description: "Verified damaged interior rooms or areas." },
          damagedRoomCount: { type: "string", description: "Verified count of damaged rooms/areas." },
          contractorPhone: { type: "string", description: "Verified contractor phone number. Never guess." },
          injuries: { type: "string", description: "Per-file override; otherwise the approved company default is used." },
          homeLivable: { type: "string", description: "Per-file override; otherwise the approved company default is used." },
          temporaryRepairs: { type: "string", description: "Per-file override; otherwise the approved company default is used." },
          contractorHired: { type: "string", description: "Per-file override; otherwise the approved company default is used." },
          includeCarrierBatch: { type: "boolean", default: false, description: "Must be false for the dedicated Mac operator. Claim-call approvals are always one JobNimbus file at a time." },
          retryOfCallId: { type: "string", description: "Optional prior ended call id for a separately prepared and approved retry of this same file." },
          overrides: { type: "object", additionalProperties: true, description: "Approved per-call overrides. If DOL must also be saved to JobNimbus, execute and verify that update first, then prepare the call from the refreshed file. A later DOL change intentionally invalidates an earlier plan digest." }
        },
        required: ["query"]
      },
      ClaimFilingCallRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Same Chance file identifier used to prepare the approved plan." },
          planDigest: { type: "string", description: "Exact digest returned by prepareClaimFilingCall after all approved JobNimbus field updates are complete. Any later file fact change, including DOL, invalidates it and requires a fresh preparation." },
          goal: { type: "string" },
          to: { type: "string" },
          carrierPhone: { type: "string" },
          stormTime: { type: "string", description: "Use the same explicit time override supplied during preparation, if any. Otherwise omit so the bridge repeats automatic sourced weather-time enrichment before digest validation." },
          occupancy: { type: "string" },
          damageDiscovered: { type: "string" },
          propertyStories: { type: "string" },
          roofAccessibility: { type: "string" },
          damagedRooms: { type: "string" },
          damagedRoomCount: { type: "string" },
          contractorPhone: { type: "string" },
          injuries: { type: "string" },
          homeLivable: { type: "string" },
          temporaryRepairs: { type: "string" },
          contractorHired: { type: "string" },
          includeCarrierBatch: { type: "boolean", default: false, description: "Must be false for the dedicated Mac operator. The bridge also forces one-file mode server-side." },
          overrides: { type: "object", additionalProperties: true },
          retryOfCallId: { type: "string", description: "For an intentional retry only: the prior ended Retell call id for this same file. The bridge rejects retries while a callback is active or after a claim number was captured." },
          approvalChallenge: { type: "string", description: "Hidden short-lived single-use challenge returned by the immediately preceding exact dry run. The local Operator retains it; do not copy it into chat." },
          execute: { type: "boolean", default: false, description: "True only after Chance approves the exact prepared plan. Also requires both Retell claim-call gates." }
        },
        required: ["query", "planDigest"]
      },
      ClaimFilingConfigurationRequest: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      ClaimFilingResultRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Retell call id returned by placeApprovedClaimFilingCall." }
        },
        required: ["callId"]
      },
      ClaimFilingCallbacksRequest: {
        type: "object",
        properties: {}
      },
      ClaimFilingWritebackRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Retell call id returned by placeApprovedClaimFilingCall." },
          writebackDigest: { type: "string", description: "Exact digest returned after reviewing the call result." },
          execute: { type: "boolean", default: false, description: "True only after Chance approves the exact JobNimbus update. Also requires BRIDGE_ALLOW_WRITES=true." }
        },
        required: ["callId", "writebackDigest"]
      },
      RetellAgentConfigurationRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          configDigest: { type: "string", description: "Exact digest returned by the dry-run configuration review." },
          execute: { type: "boolean", default: false, description: "False returns a dry-run. True updates the Retell LLM and agent only when configDigest matches." },
          publish: { type: "boolean", default: false, description: "Must be true with execute=true. Publishes the updated draft so the live caller cannot drift from bridge code." }
        }
      },
      RetellClientCoordinatorConfigurationRequest: {
        type: "object",
        properties: {
          configDigest: { type: "string", description: "Exact digest returned by the Client Coordinator configuration dry run." },
          execute: { type: "boolean", default: false, description: "False returns the full prompt/tools/schema for review. True changes Retell only when the digest matches." },
          publish: { type: "boolean", default: false, description: "Must be true with execute=true so the reviewed draft is the published live version." }
        }
      },
      RetellClientCoordinatorCallRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact Chance-owned JobNimbus file identifier." },
          mode: {
            type: "string",
            enum: ["appointment_confirmation", "missing_document_request", "status_update", "client_check_in"],
            default: "appointment_confirmation",
            description: "One approved client-coordination purpose for this call."
          },
          dateStart: { type: "string", description: "Required only for appointment confirmation. ISO 8601 arrival-window start with an explicit UTC offset." },
          dateEnd: { type: "string", description: "Required only for appointment confirmation. ISO 8601 arrival-window end with an explicit UTC offset." },
          interiorAccessRequired: { type: "boolean", default: true },
          documentNeeded: { type: "string", description: "Required only for missing_document_request. Name the exact document requested." },
          statusUpdate: { type: "string", description: "Required only for status_update. Must contain only facts verified from the fresh evidence packet." },
          checkInReason: { type: "string", description: "Optional concise reason for a client_check_in." },
          approvedContext: { type: "string", maxLength: 1600, description: "Exact factual context Chance approves for directly related client questions. This is a ceiling, not a script." },
          reminderTopics: {
            type: "array",
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", enum: ["process_timing", "titan_role", "part_b_scope"] },
            description: "Optional verified Brain reminder topics approved for this specific call. Omit unless relevant."
          },
          includeGmail: { type: "boolean", default: true },
          includeQuo: { type: "boolean", default: true, description: "Reads matching communication across all company Quo lines as evidence only." },
          includeQuoTranscripts: { type: "boolean", default: false },
          communicationDays: { type: "integer", minimum: 1, maximum: 3650, default: 365 },
          gmailLimit: { type: "integer", minimum: 1, maximum: 15, default: 8 },
          gmailThreadLimit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
          quoLimit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          planDigest: { type: "string", description: "Exact digest returned by the unchanged dry run." },
          execute: { type: "boolean", default: false, description: "False reviews fresh evidence and returns an exact plan. True places one call only after Chance approves the unchanged digest." }
        },
        required: ["query"]
      },
      RetellClientCoordinatorCallResultRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Retell call id returned by placeApprovedClientCoordinatorCall." }
        },
        required: ["callId"]
      },
      RetellCarrierFollowUpConfigurationRequest: {
        type: "object",
        properties: {
          configDigest: { type: "string", description: "Exact digest returned by the Carrier Follow-Up configuration dry run." },
          execute: { type: "boolean", default: false, description: "False returns the exact configuration. True changes Retell only when the digest matches." },
          publish: { type: "boolean", default: false, description: "Must be true with execute=true so the reviewed version becomes live." }
        }
      },
      RetellCarrierFollowUpCallRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact Chance-owned JobNimbus file identifier." },
          goal: { type: "string", enum: ["adjuster_assignment", "claim_status", "appointment_scheduling", "appointment_confirmation", "inspector_eta", "document_receipt", "document_destination", "generic_information"], default: "adjuster_assignment" },
          destinationType: { type: "string", enum: ["carrier_general_line", "desk_adjuster", "field_inspector", "scheduler", "independent_adjusting_company"], default: "carrier_general_line" },
          to: { type: "string", description: "Verified destination phone. Required unless destinationType is desk_adjuster and the current file has a verified desk-adjuster phone." },
          carrierPhone: { type: "string", description: "Alias for a verified carrier general-line phone." },
          extension: { type: "string", description: "Optional verified extension, kept separate from the E.164 destination. The agent waits for the IVR prompt and enters it one digit at a time." },
          contactName: { type: "string", description: "Verified direct contact name for a conversational named-contact opening." },
          fieldInspectorName: { type: "string", description: "Verified current field inspector. Never substitute the desk adjuster." },
          fieldInspectorCompany: { type: "string" },
          appointmentDateTime: { type: "string", description: "Verified existing appointment date. This does not grant scheduling authority." },
          appointmentWindow: { type: "string", description: "Verified carrier arrival window." },
          interiorAccess: { type: "string", description: "Verified access requirement." },
          documentsSent: { type: "string", description: "Only documents verified as actually sent or uploaded." },
          documentDestination: { type: "string", description: "Known destination to confirm, if any." },
          approvedQuestions: { type: "array", maxItems: 10, items: { type: "string" }, description: "Additional exact questions approved for this call." },
          schedulingAuthority: { type: "boolean", default: false, description: "False means information gathering only. True must be explicitly approved and limits scheduling to approvedSchedulingOptions." },
          approvedSchedulingOptions: { type: "array", maxItems: 8, items: { type: "string" } },
          includeGmail: { type: "boolean", default: true },
          includeQuo: { type: "boolean", default: true },
          includeQuoTranscripts: { type: "boolean", default: false },
          communicationDays: { type: "integer", minimum: 1, maximum: 3650, default: 365 },
          gmailLimit: { type: "integer", minimum: 1, maximum: 15, default: 8 },
          gmailThreadLimit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
          quoLimit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          planDigest: { type: "string", description: "Exact digest returned by the unchanged dry run." },
          execute: { type: "boolean", default: false, description: "False returns an exact plan. True places one call only after Chance approves the unchanged plan." }
        },
        required: ["query"]
      },
      RetellCarrierFollowUpCallResultRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Retell call id returned by placeApprovedCarrierFollowUpCall." }
        },
        required: ["callId"]
      },
      RetellHomeownerCallRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Chance-owned JobNimbus file identifier." },
          dateStart: { type: "string", description: "Inspection arrival-window start as ISO 8601 with an explicit UTC offset." },
          dateEnd: { type: "string", description: "Inspection arrival-window end as ISO 8601 with an explicit UTC offset." },
          interiorAccessRequired: { type: "boolean", default: true },
          planDigest: { type: "string", description: "Exact digest returned by the dry run." },
          execute: { type: "boolean", default: false, description: "False returns the exact call plan. True places the call only after approval." }
        },
        required: ["query", "dateStart", "dateEnd"]
      },
      RetellHomeownerCallResultRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Retell call id returned by placeApprovedHomeownerAppointmentCall." }
        },
        required: ["callId"]
      },
      VoiceCallRequest: {
        type: "object",
        properties: {
          to: { type: "string", description: "Destination phone number in E.164 or US 10-digit format. Defaults to the configured verified test number if omitted." },
          from: { type: "string", description: "Optional Twilio from number. Defaults to configured TWILIO_FROM_NUMBER." },
          goal: { type: "string", description: "Short call goal, such as file_new_claim, claim_status, send_lor_destination, schedule_inspection, or test. Use test only for connection tests." },
          voice: { type: "string", description: "Optional OpenAI Realtime voice. Use cedar for the best deeper/more masculine test voice; marin and cedar are recommended quality voices." },
          prompt: { type: "string", description: "Concise but complete call packet. Include: who the assistant is, exact call purpose, insured/property/carrier/policy/DOL/claim facts, what to ask for, what to avoid saying, IVR/menu guidance, and the desired result. The current voice bridge can speak IVR answers but cannot press keypad digits yet. Keep it focused to control OpenAI voice usage." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True places the call and requires explicit user approval plus ALLOW_VOICE_CALLS=true." }
        }
      },
      VoiceTranscriptRequest: {
        type: "object",
        properties: {
          callId: { type: "string", description: "Bridge call id returned by placeRealtimeVoiceCall." },
          sid: { type: "string", description: "Twilio call SID returned by placeRealtimeVoiceCall." },
          twilioCallSid: { type: "string", description: "Alias for sid." }
        }
      },
      VoiceTranscriptsRequest: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          status: { type: "string", description: "Optional recent call status filter, such as connected, closed, stopped, or created." }
        }
      },
      CreateHandoffRequest: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source system or chat, such as regular-chat, gmail, quo, or ChatGPT Gmail/Quo chat." },
          client: { type: "string", description: "Optional client/file name, JobNimbus number, claim number, policy number, phone, email, or address." },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Structured handoff payload from another chat. Include summary, source details, recommendedActions, needsApproval, drafts, or raw text."
          },
          text: { type: "string", description: "Plain text handoff if no structured payload is available." }
        }
      },
      CreateHandoffChunkRequest: {
        type: "object",
        properties: {
          uploadId: { type: "string", description: "Optional upload id returned from the first chunk. Omit on the first chunk." },
          source: { type: "string", description: "Source system or chat, such as regular-chat, gmail, quo, or ChatGPT Gmail/Quo chat." },
          client: { type: "string", description: "Optional client/file name, JobNimbus number, claim number, policy number, phone, email, or address." },
          index: { type: "integer", minimum: 0, description: "Zero-based chunk index." },
          total: { type: "integer", minimum: 1, maximum: 1000, description: "Total number of chunks in the upload." },
          chunk: { type: "string", description: "Raw JSON/text slice for this chunk. The bridge assembles all chunks and creates one handoff." }
        },
        required: ["index", "total", "chunk"]
      },
      PendingHandoffsRequest: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          query: { type: "string", description: "Optional client/file search over pending handoffs." },
          client: { type: "string", description: "Optional client/file search over pending handoffs." },
          includeCompleted: { type: "boolean", default: false }
        }
      },
      GetHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by createHandoff or listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." }
        }
      },
      ProcessHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by createHandoff or listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." },
          query: { type: "string", description: "Override file/client identifier if the handoff did not include one." },
          fields: { type: "object", additionalProperties: true, description: "Override or provide exact JobNimbus contact fields to update." },
          status: { type: "string", description: "Override or provide JobNimbus workflow/status name to set." },
          statusName: { type: "string", description: "Alias for status." },
          workflowStatus: { type: "string", description: "Alias for status." },
          note: { type: "string", description: "Override or provide internal JobNimbus note text." },
          internalNote: { type: "string", description: "Alias for note." },
          execute: { type: "boolean", default: false, description: "When false, returns dry-run only. True requires bridge writes to be enabled." },
          completeOnSuccess: { type: "boolean", default: true, description: "When executing, mark the handoff completed after a successful update." },
          completionNote: { type: "string", description: "Optional note saved when marking the handoff complete." }
        }
      },
      CompleteHandoffRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Handoff id returned by listPendingHandoffs." },
          handoffId: { type: "string", description: "Alias for id." },
          completionNote: { type: "string", description: "Optional note describing how the handoff was processed." },
          note: { type: "string", description: "Alias for completionNote." }
        }
      },
      CreateArtifactChunkRequest: {
        type: "object",
        properties: {
          uploadId: { type: "string", description: "Upload id returned by the first chunk. Omit on chunk zero." },
          filename: { type: "string", description: "Simple UTF-8 .patch or .diff filename. Required on chunk zero." },
          source: { type: "string", description: "Agent creating the package, such as claude or codex." },
          baseCommit: { type: "string", description: "Git commit SHA the patch applies to. Required on chunk zero." },
          summary: { type: "string", description: "PII-free summary of the package." },
          sha256: { type: "string", description: "Lowercase SHA-256 of the complete UTF-8 patch. Required on chunk zero." },
          index: { type: "integer", minimum: 0, description: "Zero-based chunk index. Chunk zero must be sent first." },
          total: { type: "integer", minimum: 1, maximum: 1000, description: "Total number of chunks." },
          chunk: { type: "string", description: "One raw UTF-8 slice of the patch." }
        },
        required: ["index", "total", "chunk"]
      },
      ListArtifactsRequest: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          status: { type: "string", description: "Optional status filter, such as uploaded or completed." },
          includeCompleted: { type: "boolean", default: false }
        }
      },
      GetArtifactRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Artifact id returned after the final upload chunk." },
          artifactId: { type: "string", description: "Alias for id." },
          includeContent: { type: "boolean", default: true, description: "Return patch text after checksum verification." }
        }
      },
      CompleteArtifactRequest: {
        type: "object",
        properties: {
          id: { type: "string", description: "Artifact id to close." },
          artifactId: { type: "string", description: "Alias for id." },
          completionNote: { type: "string", description: "PII-free review result or published commit reference." },
          note: { type: "string", description: "Alias for completionNote." }
        }
      },
      BrainContextRequest: {
        type: "object",
        properties: {
          maxPerSection: { type: "integer", minimum: 1, maximum: 25, default: 25, description: "Maximum verified records to render in each brain section." }
        }
      },
      OperationalSessionRequest: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            enum: ["priority", "today_inspections", "communications"],
            default: "priority",
            description: "Use communications whenever the user asks about missed calls, voicemails, texts, emails, callbacks, or appointments that still need scheduling. It scans inbound Gmail and every Quo team line first, then matches communications to files. Use today_inspections for today's known JobNimbus inspection tasks. Use priority only for the general backlog."
          },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 },
          maxPerSection: { type: "integer", minimum: 1, maximum: 25, default: 25 },
          includeQuoTranscripts: { type: "boolean", default: false },
          includeBrainAdvisory: { type: "boolean", default: false, description: "For priority or today_inspections, request a bounded no-tools model advisory for each exact reviewed file. Default false avoids unnecessary model cost." },
          communicationDays: { type: "integer", minimum: 1, maximum: 3650, default: 365 },
          gmailLimit: { type: "integer", minimum: 1, maximum: 15, default: 8 },
          gmailThreadLimit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
          quoLimit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          quoTranscriptLimit: { type: "integer", minimum: 0, maximum: 25, default: 12, description: "Maximum recent incoming Quo calls to hydrate with transcripts during a communication recovery sweep." }
        }
      }
    }
  },
  paths: {
    "/health": { get: { operationId: "health", responses: { "200": { description: "OK" } } } },
    "/api/v1/meta": {
      get: {
        operationId: "readHcnPlatformMetadata",
        security: [],
        responses: {
          "200": {
            description: "Privacy-safe HCN bridge build attestation, capability schema versions, normalized runtime status, configuration drift, and permanent system boundaries.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlatformMetadataResponse" }
              }
            }
          }
        }
      }
    },
    "/api/v1/session": {
      get: {
        operationId: "readHcnPlatformSession",
        responses: {
          "200": {
            description: "Privacy-safe authenticated identity class, explicit named capabilities, normalized runtime status, build attestation, and deterministic descriptor hash.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlatformSessionResponse" }
              }
            }
          },
          "401": {
            description: "Authentication required.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlatformErrorResponse" }
              }
            }
          },
          "403": {
            description: "The authenticated identity is not allowed to read the HCN platform session.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PlatformErrorResponse" }
              }
            }
          }
        }
      }
    },
    "/hcn/api/v1/work-center": {
      post: {
        operationId: "readHcnWorkCenter",
        security: [{ hcnBrowserSession: [] }],
        description: "Chance-only fresh, read-only index of active Chance-assigned insurance files. Requires the same-origin HCN session CSRF header. Returns opaque file references and minimized operational flags with no persistence.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  offset: {
                    type: "integer",
                    minimum: 0,
                    maximum: 5000
                  },
                  limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 50
                  }
                },
                required: ["offset", "limit"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Fresh ephemeral HCN Work Center page."
          },
          "400": { description: "Strict request validation failed." },
          "401": { description: "HCN browser session required." },
          "403": { description: "Chance-only session, Origin, or CSRF check failed." },
          "413": { description: "Request exceeds the 4 KiB console limit." },
          "502": { description: "Fresh JobNimbus evidence could not be proven." },
          "503": { description: "HCN read-only reference configuration is unavailable." }
        }
      }
    },
    "/hcn/api/v1/file-review": {
      post: {
        operationId: "readHcnExactFile",
        security: [{ hcnBrowserSession: [] }],
        description: "Chance-only fresh exact-file review selected by opaque HCN file reference. JobNimbus is required; Gmail and Quo failures are explicit partial states. No Brain, Jobrolo, legacy-memory, advisory, write, send, call, upload, or persistence path is used.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  fileRef: {
                    type: "string",
                    pattern: "^subject_[a-f0-9]{32}$"
                  },
                  recentLimit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 20
                  }
                },
                required: ["fileRef", "recentLimit"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Fresh ephemeral exact-file workspace with source freshness and coded operational lanes."
          },
          "400": { description: "Strict request validation failed." },
          "401": { description: "HCN browser session required." },
          "403": { description: "Chance-only session, Origin, or CSRF check failed." },
          "404": { description: "Opaque reference is not a current active Chance-assigned file." },
          "413": { description: "Request exceeds the 4 KiB console limit." },
          "502": { description: "Required fresh JobNimbus evidence could not be proven." },
          "503": { description: "HCN read-only reference configuration is unavailable." }
        }
      }
    },
    "/hcn/api/v1/action-plans/prepare": {
      post: {
        operationId: "prepareHcnActionPlan",
        security: [{ hcnBrowserSession: [] }],
        description: "Prepares one exact, single-file JobNimbus action plan from fresh active Chance-assigned evidence. Provider identifiers and the server approval challenge never enter the browser response.",
        requestBody: hcnActionRequestBody("prepare"),
        responses: hcnActionOpenApiResponses({
          success:
            "An immutable pending plan with exact material, approval digest, and expiry. Nothing was executed.",
          bodyLimit: "64 KiB"
        })
      }
    },
    "/hcn/api/v1/action-plans/list": {
      post: {
        operationId: "listHcnActionPlans",
        security: [{ hcnBrowserSession: [] }],
        description: "Lists privacy-scoped pending and recent in-memory action-plan summaries for the current HCN browser session.",
        requestBody: hcnActionRequestBody("empty"),
        responses: hcnActionOpenApiResponses({
          success: "Current-session action-plan summaries.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/hcn/api/v1/action-plans/detail": {
      post: {
        operationId: "readHcnActionPlan",
        security: [{ hcnBrowserSession: [] }],
        description: "Reads the exact public review material for one current-session action plan. No provider identifiers or approval challenge are returned.",
        requestBody: hcnActionRequestBody("plan"),
        responses: hcnActionOpenApiResponses({
          success: "Exact public action-plan detail.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/hcn/api/v1/action-plans/execute": {
      post: {
        operationId: "executeHcnActionPlan",
        security: [{ hcnBrowserSession: [] }],
        description: "Consumes one unchanged pending plan after a separate explicit Chance approval. Both the global write gate and HCN execution gate must be enabled. Effects are single-flight, receipt-first, fail-stop, and never automatically retried.",
        "x-openai-isConsequential": true,
        requestBody: hcnActionRequestBody("plan"),
        responses: hcnActionOpenApiResponses({
          success:
            "Terminal plan and metadata-only durable receipt, including reconciliation-required outcomes.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/hcn/api/v1/action-plans/invalidate": {
      post: {
        operationId: "invalidateHcnActionPlan",
        security: [{ hcnBrowserSession: [] }],
        description: "Explicitly invalidates one unexecuted current-session pending plan. Editing always requires invalidation and a fresh preparation.",
        "x-openai-isConsequential": true,
        requestBody: hcnActionRequestBody("plan"),
        responses: hcnActionOpenApiResponses({
          success: "Invalidated plan projection.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/hcn/api/v1/action-receipts/list": {
      post: {
        operationId: "listHcnActionReceipts",
        security: [{ hcnBrowserSession: [] }],
        description: "Lists bounded metadata-only action receipts for the stable pinned Chance HCN operator principal. No client bodies, provider identifiers, credentials, or challenges are stored.",
        requestBody: hcnActionRequestBody("empty"),
        responses: hcnActionOpenApiResponses({
          success: "Stable Chance-operator durable receipt summaries.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/hcn/api/v1/action-receipts/detail": {
      post: {
        operationId: "readHcnActionReceipt",
        security: [{ hcnBrowserSession: [] }],
        description: "Reads one metadata-only durable action receipt by its action plan reference for the stable pinned Chance HCN operator principal.",
        requestBody: hcnActionRequestBody("plan"),
        responses: hcnActionOpenApiResponses({
          success: "Exact metadata-only durable receipt.",
          bodyLimit: "4 KiB"
        })
      }
    },
    "/auth/whoami": {
      get: {
        operationId: "readSignedInWaveIdentity",
        responses: { "200": { description: "Returns the authenticated employee, Wave role, JobNimbus scope, Gmail mode, and whether a Quo line is configured. Returns no Google token or secret." } }
      }
    },
    "/auth/quo-line": {
      post: {
        operationId: "linkAuthenticatedQuoLine",
        description: "Checks, starts, or verifies an employee's Quo line link. Start sends a short-lived SMS code only to a company Quo number; verify persists the authenticated employee-to-line mapping.",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("QuoLineLinkRequest"),
        responses: { "200": { description: "Quo line status, verification-code delivery receipt, or completed employee line link." } }
      }
    },
    "/privacy": { get: { operationId: "privacy", responses: { "200": { description: "Privacy policy" } } } },
    "/scheduling/availability": {
      post: {
        operationId: "reviewUnifiedSchedulingAvailability",
        requestBody: jsonBody("SchedulingAvailabilityRequest"),
        responses: { "200": { description: "Fresh merged Chance availability from JobNimbus and Google Calendar. Returns BLOCKED and no bookable windows if either source cannot be checked." } }
      }
    },
    "/claim-filing/prepare": {
      post: {
        operationId: "prepareClaimFilingCall",
        requestBody: jsonBody("ClaimFilingPrepareRequest"),
        responses: { "200": { description: "Fresh Chance-only JobNimbus evidence packet, readiness review, exact call plan, and approval digest. For inspection scheduling, includes live merged JobNimbus and Google Calendar authority. Never places a call." } }
      }
    },
    "/claim-filing/configuration": {
      post: {
        operationId: "verifyRetellClaimFilingConfiguration",
        requestBody: jsonBody("ClaimFilingConfigurationRequest"),
        responses: { "200": { description: "Read-only live attestation of the published Retell claim agent, linked LLM prompt, guarded tools, DTMF support, extraction schema, timezone, exact phone routing, authenticated callback webhook, and callback restoration." } }
      }
    },
    "/claim-filing/call": {
      post: {
        operationId: "placeApprovedClaimFilingCall",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("ClaimFilingCallRequest"),
        responses: { "200": { description: "Rechecks the Chance file and, for inspection scheduling, both calendars; then dry-runs or places the exact approved Retell carrier call. Calendar changes invalidate the prior digest and duplicate calls are blocked." } }
      }
    },
    "/claim-filing/result": {
      post: {
        operationId: "reviewClaimFilingCallResult",
        requestBody: jsonBody("ClaimFilingResultRequest"),
        responses: { "200": { description: "Retell transcript, structured extraction, confidence, unverified guesses, a dry-run JobNimbus writeback proposal, and an approval-gated JobNimbus calendar proposal when an inspection was confirmed inside an authorized window." } }
      }
    },
    "/claim-filing/callbacks": {
      post: {
        operationId: "listPendingClaimCallbacks",
        requestBody: jsonBody("ClaimFilingCallbacksRequest"),
        responses: { "200": { description: "Read-only list of confirmed carrier callbacks still awaiting an inbound continuation, including callback packet completeness." } }
      }
    },
    "/claim-filing/writeback": {
      post: {
        operationId: "processApprovedClaimFilingWriteback",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("ClaimFilingWritebackRequest"),
        responses: { "200": { description: "Rechecks the Chance file and call result, then dry-runs or executes the exact approved JobNimbus field/status/note update." } }
      }
    },
    "/retell/configure-agent": {
      post: {
        operationId: "configureApprovedRetellAgent",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("RetellAgentConfigurationRequest"),
        responses: { "200": { description: "Dry-runs or, after exact digest approval, updates and publishes the Retell prompt, tools, timezone, post-call extraction schema, exact inbound claim-agent routing, and authenticated callback webhook." } }
      }
    },
    "/retell/configure-client-coordinator": {
      post: {
        operationId: "configureApprovedClientCoordinatorAgent",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("RetellClientCoordinatorConfigurationRequest"),
        responses: { "200": { description: "Returns the exact Client Coordinator prompt, tools, and extraction schema or, after matching-digest approval, updates and publishes that Retell configuration. Never places a call." } }
      }
    },
    "/retell/client-coordinator-call": {
      post: {
        operationId: "placeApprovedClientCoordinatorCall",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("RetellClientCoordinatorCallRequest"),
        responses: { "200": { description: "Reviews fresh Chance-owned JobNimbus, Gmail, company-wide Quo, documents, tasks, and private receipts; returns an exact approval-gated plan or places one approved Client Coordinator call. It cannot send a fallback text or write JobNimbus." } }
      }
    },
    "/retell/client-coordinator-call-result": {
      post: {
        operationId: "reviewClientCoordinatorCall",
        requestBody: jsonBody("RetellClientCoordinatorCallResultRequest"),
        responses: { "200": { description: "Returns transcript, structured client commitments, questions, opt-out status, and review-only follow-up proposals. It sends and writes nothing." } }
      }
    },
    "/retell/configure-carrier-follow-up": {
      post: {
        operationId: "configureApprovedCarrierFollowUpAgent",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("RetellCarrierFollowUpConfigurationRequest"),
        responses: { "200": { description: "Returns or publishes the exact dedicated carrier follow-up prompt, DTMF tool, call settings, and structured extraction schema. It never places a call." } }
      }
    },
    "/retell/carrier-follow-up-call": {
      post: {
        operationId: "placeApprovedCarrierFollowUpCall",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("RetellCarrierFollowUpCallRequest"),
        responses: { "200": { description: "Reviews fresh Chance-owned JobNimbus, Gmail, company-wide Quo, documents, tasks, and receipts; returns an exact approval plan or places one approved information-gathering call. It cannot write, send, negotiate, or silently schedule." } }
      }
    },
    "/retell/carrier-follow-up-call-result": {
      post: {
        operationId: "reviewCarrierFollowUpCall",
        requestBody: jsonBody("RetellCarrierFollowUpCallResultRequest"),
        responses: { "200": { description: "Returns the transcript, separate desk-adjuster and field-inspector facts, appointment/document results, and review-only proposals. It writes and schedules nothing." } }
      }
    },
    "/retell/homeowner-call": {
      post: {
        operationId: "placeApprovedHomeownerAppointmentCall",
        requestBody: jsonBody("RetellHomeownerCallRequest"),
        responses: { "200": { description: "Dry-runs or places an approved homeowner appointment confirmation call through Retell." } }
      }
    },
    "/retell/homeowner-call-result": {
      post: {
        operationId: "reviewHomeownerAppointmentCall",
        requestBody: jsonBody("RetellHomeownerCallResultRequest"),
        responses: { "200": { description: "Returns the Retell homeowner appointment call status and transcript." } }
      }
    },
    "/voice/outbound-call": {
      post: {
        operationId: "placeRealtimeVoiceCall",
        requestBody: jsonBody("VoiceCallRequest"),
        responses: { "200": { description: "Dry-run plan or executed Twilio/OpenAI realtime voice call." } }
      }
    },
    "/voice/transcript": {
      post: {
        operationId: "getVoiceCallTranscript",
        requestBody: jsonBody("VoiceTranscriptRequest"),
        responses: { "200": { description: "Returns the stored transcript for a recent Twilio/OpenAI realtime voice call." } }
      }
    },
    "/voice/transcripts": {
      post: {
        operationId: "listRecentVoiceCallTranscripts",
        requestBody: jsonBody("VoiceTranscriptsRequest"),
        responses: { "200": { description: "Returns recent stored transcripts for Twilio/OpenAI realtime voice calls." } }
      }
    },
    "/handoff": {
      get: {
        operationId: "handoffInboxPage",
        security: [],
        responses: { "200": { description: "Human paste-in page for Gmail/Quo handoffs." } }
      },
      post: {
        operationId: "createHandoff",
        requestBody: jsonBody("CreateHandoffRequest"),
        responses: { "200": { description: "Created handoff for the JobNimbus assistant to process." } }
      }
    },
    "/handoff/chunk": {
      post: {
        operationId: "createHandoffChunk",
        security: [],
        requestBody: jsonBody("CreateHandoffChunkRequest"),
        responses: { "200": { description: "Receives one large handoff chunk and creates the handoff when all chunks arrive." } }
      }
    },
    "/handoff/pending": {
      post: {
        operationId: "listPendingHandoffs",
        requestBody: jsonBody("PendingHandoffsRequest"),
        responses: { "200": { description: "Pending handoffs from Gmail/Quo or other chats." } }
      }
    },
    "/handoff/get": {
      post: {
        operationId: "getHandoff",
        requestBody: jsonBody("GetHandoffRequest"),
        responses: { "200": { description: "Returns one handoff by id." } }
      }
    },
    "/handoff/process": {
      post: {
        operationId: "processHandoff",
        requestBody: jsonBody("ProcessHandoffRequest"),
        responses: { "200": { description: "Dry-runs or executes a JobNimbus update embedded in a handoff." } }
      }
    },
    "/handoff/complete": {
      post: {
        operationId: "completeHandoff",
        requestBody: jsonBody("CompleteHandoffRequest"),
        responses: { "200": { description: "Marks a handoff as completed after it is processed." } }
      }
    },
    "/artifacts/chunk": {
      post: {
        operationId: "uploadAgentPatchChunk",
        requestBody: jsonBody("CreateArtifactChunkRequest"),
        responses: { "200": { description: "Stores one authenticated patch chunk and returns artifact metadata after checksum verification." } }
      }
    },
    "/artifacts/list": {
      post: {
        operationId: "listAgentPatchArtifacts",
        requestBody: jsonBody("ListArtifactsRequest"),
        responses: { "200": { description: "Lists active patch-package metadata without file content." } }
      }
    },
    "/artifacts/get": {
      post: {
        operationId: "getAgentPatchArtifact",
        requestBody: jsonBody("GetArtifactRequest"),
        responses: { "200": { description: "Returns one patch after verifying its stored SHA-256." } }
      }
    },
    "/artifacts/complete": {
      post: {
        operationId: "completeAgentPatchArtifact",
        requestBody: jsonBody("CompleteArtifactRequest"),
        responses: { "200": { description: "Marks an artifact reviewed/completed. It remains non-executable and expires normally." } }
      }
    },
    "/brain/context": {
      post: {
        operationId: "readWaveJobNimbusBrain",
        requestBody: jsonBody("BrainContextRequest"),
        responses: { "200": { description: "Read-only company operating context. Never writes memory, exposes client memory, or executes an action." } }
      }
    },
    "/ops/start-session": {
      post: {
        operationId: "startThresherOperationalSession",
        requestBody: jsonBody("OperationalSessionRequest"),
        responses: { "200": { description: "Read-only operational router. focus=communications scans inbound Gmail plus every Quo team line first and matches scheduling/callback evidence to active Chance files while preserving unmatched unknown-number items. focus=today_inspections resolves exact files from active JobNimbus inspection tasks due today. focus=priority ranks the active backlog and deep-reviews one file." } }
      }
    },
    "/ops/recover-scheduling-communications": {
      post: {
        operationId: "recoverSchedulingCommunications",
        description: "Use for missed calls, voicemails, texts, scheduling emails, callbacks, adjuster appointments, reinspections, inspector ETAs, or homeowner notices. Always scans Gmail and company-wide Quo first and never executes outbound actions.",
        requestBody: jsonBody("OperationalSessionRequest"),
        responses: { "200": { description: "Read-only scheduling and callback recovery sweep across incoming Gmail and all available Quo team lines, matched to active Chance files with unmatched communications preserved." } }
      }
    },
    "/memory/file-actions": {
      post: {
        operationId: "readChanceFileActionReceipts",
        requestBody: jsonBody("MemoryFileActionsRequest"),
        responses: { "200": { description: "Private exact-file client snapshot, action receipts, Retell ledger, and external IDs. Use for continuity and prior IDs. Live evidence wins; snapshots and receipts never approve future work." } }
      }
    },
    "/memory/persistence-check": {
      post: {
        operationId: "checkRenderMemoryPersistence",
        requestBody: jsonBody("MemoryPersistenceCheckRequest"),
        responses: { "200": { description: "Reads or records a harmless approved persistence probe. No external system is contacted." } }
      }
    },
    "/ops/review-chance-files": {
      post: {
        operationId: "reviewChanceFilesForApproval",
        requestBody: jsonBody("ChanceReviewRequest"),
        responses: { "200": { description: "Loads company rules, gathers fresh Chance-only JobNimbus/Gmail/Quo evidence, refreshes each private client snapshot, and returns approval-ready context. It never authorizes or executes actions." } }
      }
    },
    "/ops/run-policy": {
      get: {
        operationId: "readChanceRunPolicy",
        description: "Read-only attestation for the exact 58-file Mac operator manifest, bridge boot, and unresolved batch boundary.",
        responses: { "200": { description: "Locked Chance run-policy attestation." } }
      }
    },
    "/ops/action-batch-receipts": {
      post: {
        operationId: "readMacActionBatchReceipts",
        description: "Read the dedicated Mac operator's own minimized action-batch receipts. Never retries or executes an operation.",
        requestBody: jsonBody("ActionBatchReceiptRequest"),
        responses: { "200": { description: "Minimized receipt list or exact batch detail." } }
      }
    },
    "/ops/action-batch-reconcile": {
      post: {
        operationId: "reconcileMacActionBatchReceipt",
        description: "Fresh-read the exact JobNimbus state for one provider-uncertain contact, status, or current-control task operation. Never retries or resumes an action.",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("ActionBatchReconcileRequest"),
        responses: { "200": { description: "Verified applied/not-applied reconciliation result and minimized receipt." } }
      }
    },
    "/ops/action-batch": {
      post: {
        operationId: "processApprovedWaveActionBatch",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("ActionBatchRequest"),
        responses: { "200": { description: "Two-step approval transaction. Dry run shows every exact action and digest; execute runs the unchanged approved batch once and blocks duplicates." } }
      }
    },
    "/jobnimbus/search": {
      post: {
        operationId: "searchJobNimbus",
        requestBody: jsonBody("SearchRequest"),
        responses: { "200": { description: "Matches" } }
      }
    },
    "/jobnimbus/review-file": {
      post: {
        operationId: "reviewJobNimbusFile",
        requestBody: jsonBody("ReviewFileRequest"),
        responses: { "200": { description: "Fresh exact-file JobNimbus review that refreshes the private client snapshot and returns company plus file-scoped brain context. Read-only; no action is authorized." } }
      }
    },
    "/jobnimbus/assigned-files": {
      post: {
        operationId: "listAssignedJobNimbusFiles",
        requestBody: jsonBody("AssignedFilesRequest"),
        responses: { "200": { description: "Assigned JobNimbus files" } }
      }
    },
    "/jobnimbus/assigned-counts": {
      post: {
        operationId: "countAssignedJobNimbusFiles",
        requestBody: jsonBody("AssignedCountsRequest"),
        responses: { "200": { description: "Assigned JobNimbus counts and grouping" } }
      }
    },
    "/jobnimbus/document-text": {
      post: {
        operationId: "extractJobNimbusDocumentText",
        requestBody: jsonBody("DocumentTextRequest"),
        responses: { "200": { description: "Extracted text from a related JobNimbus document when supported." } }
      }
    },
    "/jobnimbus/document-review": {
      post: {
        operationId: "reviewJobNimbusDocument",
        summary: "Reliably review one JobNimbus document in a single call",
        description: "Canonical read-only document workflow. Selects one exact file by query or purpose, extracts text, and automatically attaches the original through openaiFileResponse when extraction is empty, truncated, or unreliable. Inspect attached pages natively; never ask the user to retrieve the file.",
        requestBody: jsonBody("DocumentReviewRequest"),
        responses: {
          "200": {
            description: "Verified extraction and review, with the exact original document attached automatically when native page inspection is required.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DocumentReviewResponse" } } }
          }
        }
      }
    },
    "/jobnimbus/document-file": {
      post: {
        operationId: "attachJobNimbusDocumentToChat",
        summary: "Return one exact JobNimbus document as a ChatGPT conversation file",
        description: "Read-only fallback for scanned or visually complex documents. Returns the original verified file through openaiFileResponse so ChatGPT can inspect the actual pages with native file/PDF analysis.",
        requestBody: jsonBody("DocumentFileRequest"),
        responses: {
          "200": {
            description: "Original JobNimbus document attached to the ChatGPT conversation.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DocumentFileResponse" }
              }
            }
          }
        }
      }
    },
    "/jobnimbus/photo-review": {
      post: {
        operationId: "reviewJobNimbusPhotos",
        summary: "Find and visually review selected JobNimbus photo batches",
        description: "Read-only, bounded photo workflow. Call catalog first to identify likely measurement uploads without returning the full job-site photo set. Then call attach_batch with one exact batchKey or up to six photoIds; the bridge returns those images as a PDF for native visual inspection.",
        requestBody: jsonBody("PhotoReviewRequest"),
        responses: {
          "200": {
            description: "Candidate metadata or a bounded PDF containing only the explicitly selected photos.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PhotoReviewResponse" } } }
          }
        }
      }
    },
    "/weather/dol-research": {
      post: {
        operationId: "researchPropertyHailDates",
        summary: "Research nearby reported hail dates for one exact JobNimbus property",
        description: "Read-only candidate research using the JobNimbus property address, U.S. Census geocoding, and archived National Weather Service Local Storm Reports. Results never confirm the date of loss and never write to JobNimbus.",
        requestBody: jsonBody("DateOfLossResearchRequest"),
        responses: { "200": { description: "Ranked nearby hail-report dates with distances, hail sizes, sources, and fail-closed warnings." } }
      }
    },
    "/jobnimbus/upload-file": {
      post: {
        operationId: "uploadJobNimbusFile",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("JobNimbusUploadFileRequest"),
        responses: { "200": { description: "Dry run or JobNimbus document upload result." } }
      }
    },
    "/jobnimbus/update-contact": {
      post: {
        operationId: "updateJobNimbusContact",
        requestBody: jsonBody("UpdateContactRequest"),
        responses: { "200": { description: "Dry run or update result" } }
      }
    },
    "/jobnimbus/update-status": {
      post: {
        operationId: "updateJobNimbusStatus",
        requestBody: jsonBody("UpdateStatusRequest"),
        responses: { "200": { description: "Dry run or status update result" } }
      }
    },
    "/jobnimbus/process-update": {
      post: {
        operationId: "processJobNimbusUpdate",
        requestBody: jsonBody("ProcessUpdateRequest"),
        responses: { "200": { description: "Dry run or bundled JobNimbus field/status/note update result" } }
      }
    },
    "/jobnimbus/create-note": {
      post: {
        operationId: "createJobNimbusNote",
        requestBody: jsonBody("CreateNoteRequest"),
        responses: { "200": { description: "Dry run or note result" } }
      }
    },
    "/jobnimbus/create-task": {
      post: {
        operationId: "createJobNimbusTask",
        requestBody: jsonBody("CreateTaskRequest"),
        responses: { "200": { description: "Dry run or task creation result" } }
      }
    },
    "/jobnimbus/update-task": {
      post: {
        operationId: "updateJobNimbusTask",
        requestBody: jsonBody("UpdateTaskRequest"),
        responses: { "200": { description: "Dry run or task update result" } }
      }
    },
    "/jobnimbus/create-calendar-event": {
      post: {
        operationId: "createJobNimbusCalendarEvent",
        requestBody: jsonBody("CreateCalendarEventRequest"),
        responses: { "200": { description: "Dry run or calendar event creation result" } }
      }
    },
    "/jobnimbus/update-calendar-event": {
      post: {
        operationId: "updateJobNimbusCalendarEvent",
        requestBody: jsonBody("UpdateCalendarEventRequest"),
        responses: { "200": { description: "Dry run or calendar event update result" } }
      }
    },
    "/gmail/search": {
      post: {
        operationId: "searchGmail",
        requestBody: jsonBody("GmailSearchRequest"),
        responses: { "200": { description: "Matching Gmail messages and grouped threads." } }
      }
    },
    "/gmail/thread": {
      post: {
        operationId: "readGmailThread",
        requestBody: jsonBody("GmailThreadRequest"),
        responses: { "200": { description: "Full Gmail thread with parsed text and attachment metadata." } }
      }
    },
    "/gmail/attachment-review": {
      post: {
        operationId: "reviewGmailAttachment",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("GmailAttachmentReviewRequest"),
        responses: { "200": { description: "Downloads and validates a Gmail attachment, extracts text/OCR when supported, and optionally dry-runs or executes an upload to an exact Chance JobNimbus file." } }
      }
    },
    "/gmail/draft": {
      post: {
        operationId: "createGmailDraft",
        requestBody: jsonBody("GmailMessageRequest"),
        responses: { "200": { description: "Dry run or created Gmail draft." } }
      }
    },
    "/gmail/send": {
      post: {
        operationId: "sendGmail",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("GmailMessageRequest"),
        responses: { "200": { description: "Two-step Gmail send. Nothing is sent during dry run. A live send requires Chance's explicit approval, execute:true, both server write gates, and the exact unchanged digest." } }
      }
    },
    "/quo/numbers": {
      post: {
        operationId: "listQuoPhoneNumbers",
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: {} } } } },
        responses: { "200": { description: "Configured Quo team lines." } }
      }
    },
    "/quo/history": {
      post: {
        operationId: "reviewQuoHistory",
        requestBody: jsonBody("QuoHistoryRequest"),
        responses: { "200": { description: "Messages and calls across every Quo team line for one exact phone/file, with optional recorded-call transcripts." } }
      }
    },
    "/quo/transcript": {
      post: {
        operationId: "reviewQuoCallTranscript",
        requestBody: jsonBody("QuoTranscriptRequest"),
        responses: { "200": { description: "Transcript for one recorded Quo call." } }
      }
    },
    "/quo/send": {
      post: {
        operationId: "sendApprovedQuoText",
        "x-openai-isConsequential": true,
        requestBody: jsonBody("QuoSendRequest"),
        responses: { "200": { description: "Two-step Quo send. Dry run returns the exact text/recipient digest; live send requires Chance approval, execute:true, ALLOW_QUO_SEND=true, and the unchanged digest. A live response distinguishes Quo API acceptance from confirmed carrier delivery. Never report success as delivered unless delivery.confirmed is true; use reviewQuoHistory to recheck queued or sent messages." } }
      }
    }
  }
};

function jsonBody(schemaName) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaName}` }
      }
    }
  };
}

function hcnActionRequestBody(kind) {
  const planIdSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      planId: {
        type: "string",
        pattern: "^plan_[a-f0-9]{32}$"
      }
    },
    required: ["planId"]
  };
  let schema;
  if (kind === "empty") {
    schema = {
      type: "object",
      additionalProperties: false,
      maxProperties: 0
    };
  } else if (kind === "plan") {
    schema = planIdSchema;
  } else {
    const fileRef = {
      type: "string",
      pattern: "^subject_[a-f0-9]{32}$"
    };
    const taskRef = {
      type: "string",
      pattern: "^ref_[a-f0-9]{32}$"
    };
    const isoDate = {
      type: "string",
      format: "date",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$"
    };
    const operation = (type, input) => ({
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", const: type },
        input
      },
      required: ["type", "input"]
    });
    schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        fileRef,
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            oneOf: [
              operation("jobnimbus.create_note", {
                type: "object",
                additionalProperties: false,
                properties: {
                  note: { type: "string", minLength: 1, maxLength: 8192 }
                },
                required: ["note"]
              }),
              operation("jobnimbus.create_task", {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 256 },
                  description: { type: "string", maxLength: 4096 },
                  dueDate: isoDate
                },
                required: ["title"]
              }),
              operation("jobnimbus.update_task", {
                type: "object",
                additionalProperties: false,
                properties: {
                  taskRef,
                  title: { type: "string", minLength: 1, maxLength: 256 },
                  description: { type: "string", maxLength: 4096 },
                  dueDate: isoDate,
                  completed: { type: "boolean" }
                },
                required: ["taskRef"],
                minProperties: 2
              }),
              operation("jobnimbus.update_status", {
                type: "object",
                additionalProperties: false,
                properties: {
                  status: { type: "string", minLength: 1, maxLength: 128 }
                },
                required: ["status"]
              }),
              operation("jobnimbus.update_contact", {
                type: "object",
                additionalProperties: false,
                properties: { dateOfLoss: isoDate },
                required: ["dateOfLoss"]
              })
            ]
          }
        }
      },
      required: ["fileRef", "operations"]
    };
  }
  return {
    required: true,
    content: {
      "application/json": { schema }
    }
  };
}

function hcnActionOpenApiResponses({ success, bodyLimit }) {
  return {
    "200": { description: success },
    "400": { description: "Strict browser action contract validation failed." },
    "401": { description: "HCN browser session required." },
    "403": {
      description: "Chance-only session, exact Origin, or CSRF check failed."
    },
    "404": {
      description:
        "The session-scoped opaque plan or stable-operator receipt was not found."
    },
    "409": {
      description:
        "The file scope, digest, plan state, or approval state changed. Nothing was automatically retried."
    },
    "413": { description: `Request exceeds the ${bodyLimit} route limit.` },
    "429": {
      description:
        "Per-session or process-wide action capacity is temporarily unavailable."
    },
    "503": {
      description:
        "A release gate, fresh evidence source, or durable receipt boundary is unavailable."
    }
  };
}
