import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
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
import { listQuoNumbers, readQuoHistory, readQuoInbox, readQuoTranscript, sendQuoText } from "./quo/client.js";
import { buildRetellLlmFromPacket, postCallAnalysisSchema } from "./claim-filing-core/retellPrompt.js";
import { evaluateGuardedEndCall } from "./claim-filing-core/endCallGuard.js";
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
  authenticateGoogleAccessToken,
  parseWaveUsers,
  publicIdentity,
  routeAllowed
} from "./auth/google-user.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.RENDER ? "0.0.0.0" : "127.0.0.1";
const API_BASE = stripTrailingSlash(process.env.JOBNIMBUS_API_BASE_URL || "https://app.jobnimbus.com/api1");
const JOBNIMBUS_FILE_BASE_URL = stripTrailingSlash(process.env.JOBNIMBUS_FILE_BASE_URL || "https://app.jobnimbus.com/files");
const API_KEY = process.env.JOBNIMBUS_API_KEY || "";
const BRIDGE_TOKEN = process.env.JOBNIMBUS_BRIDGE_TOKEN || "";
const ALLOW_WRITES = process.env.BRIDGE_ALLOW_WRITES === "true";
const PUBLIC_BASE_URL = stripTrailingSlash(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://jobnimbus-chatgpt-bridge.onrender.com");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const GOOGLE_TOKENINFO_URL = process.env.GOOGLE_TOKENINFO_URL || "https://www.googleapis.com/oauth2/v2/tokeninfo";
const GOOGLE_USERINFO_URL = process.env.GOOGLE_USERINFO_URL || "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_OAUTH_ALLOWED_DOMAIN = process.env.GOOGLE_OAUTH_ALLOWED_DOMAIN || "wavepa.com";
const ALLOW_GOOGLE_USER_AUTH = process.env.ALLOW_GOOGLE_USER_AUTH === "true";
const AUTO_ENROLL_WAVE_USERS = process.env.AUTO_ENROLL_WAVE_USERS === "true";
const GPT_OAUTH_CLIENT_ID = process.env.GPT_OAUTH_CLIENT_ID || "wave-jobnimbus-gpt";
const GPT_OAUTH_CLIENT_SECRET = process.env.GPT_OAUTH_CLIENT_SECRET || "";
const OAUTH_SESSION_SECRET = process.env.OAUTH_SESSION_SECRET || "";
const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly"
];
const WAVE_AUTH_USERS = parseWaveUsers(process.env.WAVE_AUTH_USERS_JSON, [{
  email: process.env.CHANCE_GOOGLE_EMAIL || "cpearson@wavepa.com",
  name: "Chance Pearson",
  role: "chance",
  jobNimbusOwnerId: process.env.CHANCE_JOBNIMBUS_OWNER_ID || "fc95a213f70e4c9daddc5fa366be9941",
  jobNimbusScope: "assigned"
}]);
const GMAIL_API_BASE_URL = stripTrailingSlash(process.env.GMAIL_API_BASE_URL || "https://gmail.googleapis.com");
const GMAIL_USER = process.env.GMAIL_USER || "me";
const STANDARD_W9_GMAIL_MESSAGE_ID = process.env.STANDARD_W9_GMAIL_MESSAGE_ID || "19e88b6a5da1ac61";
const ALLOW_GMAIL_SEND = process.env.ALLOW_GMAIL_SEND === "true";
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
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
const ALLOW_VOICE_CALLS = process.env.ALLOW_VOICE_CALLS === "true";
const RETELL_API_BASE_URL = stripTrailingSlash(process.env.RETELL_API_BASE_URL || "https://api.retellai.com");
const RETELL_API_KEY = process.env.RETELL_API_KEY || "";
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID || "";
const RETELL_HOMEOWNER_AGENT_ID = process.env.RETELL_HOMEOWNER_AGENT_ID || "agent_83d18f8328f04e88ba2d5dcdd9";
const RETELL_CLIENT_COORDINATOR_AGENT_ID = process.env.RETELL_CLIENT_COORDINATOR_AGENT_ID || RETELL_HOMEOWNER_AGENT_ID;
const RETELL_CARRIER_FOLLOWUP_AGENT_ID = process.env.RETELL_CARRIER_FOLLOWUP_AGENT_ID || "agent_66fb8a49fc6ab5a777eb9f0474";
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || TWILIO_FROM_NUMBER || "";
const ALLOW_RETELL_CALLS = process.env.ALLOW_RETELL_CALLS === "true";
const ALLOW_CLIENT_COORDINATOR_CALLS = process.env.ALLOW_CLIENT_COORDINATOR_CALLS === "true";
const ALLOW_CARRIER_FOLLOWUP_CALLS = process.env.ALLOW_CARRIER_FOLLOWUP_CALLS
  ? process.env.ALLOW_CARRIER_FOLLOWUP_CALLS === "true"
  : ALLOW_RETELL_CALLS;
const CHANCE_OWNER_ID = process.env.CHANCE_JOBNIMBUS_OWNER_ID || "fc95a213f70e4c9daddc5fa366be9941";
const CHANCE_GOOGLE_EMAIL = String(process.env.CHANCE_GOOGLE_EMAIL || "cpearson@wavepa.com").trim().toLowerCase();
const CLAIM_CALL_STORE_PATH = process.env.CLAIM_CALL_STORE_PATH || path.join(BRIDGE_DATA_DIR, "claim-call-ledger.json");
const ACTION_BATCH_STORE_PATH = process.env.ACTION_BATCH_STORE_PATH || path.join(BRIDGE_DATA_DIR, "action-batches.json");
const OUTBOUND_SEND_STORE_PATH = process.env.OUTBOUND_SEND_STORE_PATH || path.join(BRIDGE_DATA_DIR, "outbound-sends.json");
const QUO_LINE_LINK_STORE_PATH = process.env.QUO_LINE_LINK_STORE_PATH || path.join(BRIDGE_DATA_DIR, "quo-line-links.json");
const QUO_LINE_CHALLENGE_STORE_PATH = process.env.QUO_LINE_CHALLENGE_STORE_PATH || path.join(BRIDGE_DATA_DIR, "quo-line-challenges.json");
const AUTO_ENROLLED_USER_STORE_PATH = process.env.AUTO_ENROLLED_USER_STORE_PATH || path.join(BRIDGE_DATA_DIR, "auto-enrolled-users.json");
const QUO_API_KEY = process.env.QUO_API_KEY || "";
const QUO_API_BASE_URL = stripTrailingSlash(process.env.QUO_API_BASE_URL || "https://api.quo.com/v1");
const QUO_DEFAULT_FROM_NUMBER = process.env.QUO_DEFAULT_FROM_NUMBER || "";
const ALLOW_QUO_SEND = process.env.ALLOW_QUO_SEND === "true";
const RETELL_INBOUND_WEBHOOK_TOKEN = process.env.RETELL_INBOUND_WEBHOOK_TOKEN || BRIDGE_TOKEN || "";
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
const REALTIME_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const voiceCallLogs = new Map();
const claimScopeTextCache = new Map();
const MEMORY_CONFIG = { projectRoot: process.cwd(), redact: redactSensitiveText };
const REQUEST_CONTEXT = new AsyncLocalStorage();
const GOOGLE_IDENTITY_CACHE = new Map();
const JOBNIMBUS_USER_CACHE = new Map();
const USED_OAUTH_CODES = new Map();
let quoLineMutationQueue = Promise.resolve();

const routes = new Map([
  ["GET /health", health],
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/oauth/authorize") return oauthAuthorize(res, url);
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") return oauthGoogleCallback(res, url);
    if (req.method === "POST" && url.pathname === "/oauth/token") return oauthToken(req, res);
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return send(res, 404, { error: "Not found" });
    if (url.pathname.startsWith("/artifacts/") && (!BRIDGE_TOKEN || !authorized(req))) {
      return send(res, 401, { error: "Artifact mailbox requires bridge bearer authentication." });
    }
    if (url.pathname === "/retell/inbound" && !retellInboundAuthorized(url)) {
      return send(res, 401, { error: "Unauthorized inbound webhook" });
    }
    let identity = null;
    if (url.pathname !== "/retell/inbound" && !isPublicRoute(req.method, url.pathname)) {
      identity = await authenticateRequest(req);
      if (!identity) return send(res, 401, { error: "Unauthorized" });
      if (!routeAllowed(identity, req.method, url.pathname)) {
        return send(res, 403, { error: "This Wave Ops role is not permitted to use that action." });
      }
    }
    const body = req.method === "GET" ? {} : await readJson(req);
    const result = await REQUEST_CONTEXT.run({ identity }, () => handler(body));
    if (result?.html) sendHtml(res, 200, result.html);
    else if (typeof result === "string") sendText(res, 200, result);
    else send(res, 200, result);
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error) });
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
  return {
    ok: true,
    service: "jobnimbus-chatgpt-bridge",
    jobNimbusConfigured: Boolean(API_KEY),
    gmailConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN),
    userOAuth: {
      available: oauthBrokerConfigured(),
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
    outboundSafety: {
      automaticEmailOrTextSending: false,
      explicitChanceApprovalRequired: true,
      exactDryRunDigestRequired: true,
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
      available: Boolean(RETELL_API_KEY && RETELL_AGENT_ID && RETELL_FROM_NUMBER),
      engine: "retell",
      callsAllowed: ALLOW_RETELL_CALLS,
      ownerScope: "Chance Pearson",
      approvalDigestRequired: true,
      writebackRequiresSeparateApproval: true,
      callbackWebhookAvailable: Boolean(RETELL_INBOUND_WEBHOOK_TOKEN),
      callbackPacketRestoration: "full_approved_packet",
      callbackTtlHours: RETELL_CALLBACK_TTL_HOURS,
      retryRequiresPriorCallId: true
    },
    clientCoordinator: {
      available: Boolean(RETELL_API_KEY && RETELL_CLIENT_COORDINATOR_AGENT_ID && RETELL_FROM_NUMBER),
      engine: "retell",
      supportedModes: ["appointment_confirmation", "missing_document_request", "status_update", "client_check_in"],
      appointmentCallsAllowed: ALLOW_RETELL_CALLS,
      expandedModesAllowed: ALLOW_CLIENT_COORDINATOR_CALLS,
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
      mode: "verified_company_context_with_live_client_snapshots_and_action_receipts",
      autonomousLearning: false,
      externalActions: false,
      clientMemoryExposed: "exact_Chance_file_only",
      clientSnapshots: true,
      automaticRefreshOnReview: true,
      liveSourcesWin: true,
      doesNotAuthorizeActions: true,
      persistentRootConfigured: Boolean(process.env.MEMORY_ROOT)
    }
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

async function oauthGoogleCallback(res, url) {
  try {
    if (!oauthBrokerConfigured()) throw oauthError("temporarily_unavailable", "Employee OAuth is not fully configured.", 503);
    const state = openOAuthPayload(required(url.searchParams.get("state"), "state"));
    if (state.kind !== "authorize_state" || Number(state.exp || 0) <= Date.now()) {
      throw oauthError("invalid_request", "OAuth state is invalid or expired.");
    }
    if (url.searchParams.get("error")) {
      return redirectOAuthError(res, state.redirectUri, state.clientState, url.searchParams.get("error"));
    }
    const code = required(url.searchParams.get("code"), "code");
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_BASE_URL}/oauth/google/callback`,
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.access_token) throw oauthError("access_denied", "Google sign-in could not be completed.", 401);
    const identity = await authenticateGoogleAccessToken({
      token: tokens.access_token,
      clientId: GOOGLE_CLIENT_ID,
      tokenInfoUrl: GOOGLE_TOKENINFO_URL,
      userInfoUrl: GOOGLE_USERINFO_URL,
      allowedDomain: GOOGLE_OAUTH_ALLOWED_DOMAIN,
      users: WAVE_AUTH_USERS,
      resolveUser: resolveFirstUseWaveUser
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
  } catch (error) {
    sendOAuthError(res, error.statusCode || 400, error.oauthCode || "invalid_request", error.message || "OAuth callback failed.");
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
      const googleResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          refresh_token: refresh.googleRefreshToken,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type: "refresh_token"
        })
      });
      const google = await googleResponse.json().catch(() => ({}));
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
    gmailMode: identity.type === "google_oauth" ? "signed_in_employee_mailbox" : "legacy_chance_mailbox",
    instruction: identity.type === "google_oauth"
      ? "The bridge will use this signed-in employee's Google token for Gmail and enforce this employee's Wave Ops role."
      : "This task is using the temporary shared bridge-token fallback and Chance's legacy Gmail connection."
  };
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

async function memoryFileActions(input = {}) {
  const query = required(input.query, "query");
  const limit = clamp(Number(input.limit || 20), 1, 100);
  const { contact } = await findChanceContact(query);
  const file = compactContact(contact);
  const receipts = latestActionReceipts(MEMORY_CONFIG, limit, { subjectKey: file.id });
  const clientSnapshot = summarizeFileSnapshot(readFileSnapshot(MEMORY_CONFIG, file.id));
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
      description: "Consolidated 29-operation workflow schema for role-aware HCN/Wave Custom GPTs. Employee identity comes from approved Google OAuth or the temporary Chance bridge-token fallback. All external writes and calls remain exact and approval-gated."
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
  const query = required(input.query, "query").toLowerCase();
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 10) });
  const matches = contacts
    .filter(isInsuranceFile)
    .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
    .filter((contact) => contactMatches(contact, query))
    .slice(0, limit);
  const compactMatches = matches.map(compactContact);
  return {
    query,
    count: compactMatches.length,
    matches: compactMatches,
    contacts: compactMatches,
    jobs: []
  };
}

async function reviewFile(input) {
  const query = required(input.query, "query");
  const { contact, alternatives } = await findChanceContact(query);
  const activities = await listRelated("/activities", contact.jnid, 30);
  const tasks = await listRelated("/tasks", contact.jnid, 30);
  const documents = await listRelated("/files", contact.jnid, 1000);
  const file = compactContact(contact);
  const sortedActivities = [...activities].sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));
  const openTasks = tasks.filter((task) => !task.is_completed).sort((a, b) => Number(a.date_start || a.date_end || 0) - Number(b.date_start || b.date_end || 0));
  const operationalDocuments = documents.filter(isOperationalDocumentMetadata);
  const actionReceipts = latestActionReceipts(MEMORY_CONFIG, 20, { subjectKey: file.id });
  const sourceStatus = {
    jobNimbus: { status: "fresh", at: new Date().toISOString() },
    gmail: { status: "not_requested", at: new Date().toISOString() },
    quo: { status: "not_requested", at: new Date().toISOString() }
  };
  const liveJobNimbus = {
    recentActivities: sortedActivities.map(compactActivity),
    openTasks: openTasks.map(compactTask),
    operationalDocuments: operationalDocuments.slice(0, 60).map(compactDocument),
    excludedPhotoLikeDocumentCount: documents.length - operationalDocuments.length,
    assistantRead: buildAssistantRead(contact, activities, tasks, operationalDocuments)
  };
  const snapshot = refreshFileSnapshot(MEMORY_CONFIG, {
    subjectKey: file.id,
    file,
    liveJobNimbus,
    gmail: { status: "not_requested", messages: [], threads: [] },
    quo: { status: "not_requested", timeline: [], transcripts: [] },
    actionReceipts,
    sourceStatus,
    factualSignals: buildFactualSignals(file, sortedActivities, openTasks, operationalDocuments, {}, {})
  });
  return {
    file,
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
    clientMemory: clientMemoryEnvelope(snapshot),
    brain: reviewBrainContext(file.id, input.maxPerSection)
  };
}

async function assignedFiles(input = {}) {
  const ownerId = String(input.ownerId || "fc95a213f70e4c9daddc5fa366be9941").trim();
  const activeOnly = input.activeOnly !== false;
  const limit = clamp(Number(input.limit || 100), 1, 250);
  const contacts = await listContacts({ maxPages: Number(input.maxPages || 25) });
  const files = contacts
    .filter((contact) => isInsuranceFile(contact))
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

async function prepareClaimFiling(input) {
  const context = await buildLiveClaimContext(required(input.query, "query"));
  let plan = await buildClaimPlanWithStormTime(input, context.canonicalInput, context.file);
  plan = await attachSameCarrierBatch(plan, context, input);
  plan = await attachSchedulingAvailability(plan);
  return {
    mode: "dry_run",
    approvalRequired: true,
    file: context.file,
    evidence: context.evidenceSummary,
    ...plan,
    nextStep: plan.readiness.ready
      ? "Review this exact packet. To call, submit its planDigest to placeApprovedClaimFilingCall with execute=true."
      : "Resolve the listed blockers, then prepare the filing again."
  };
}

async function placeClaimFilingCall(input) {
  const context = await buildLiveClaimContext(required(input.query, "query"));
  let plan = await buildClaimPlanWithStormTime(input, context.canonicalInput, context.file);
  plan = await attachSameCarrierBatch(plan, context, input);
  plan = await attachSchedulingAvailability(plan);
  assertApprovalDigest(input.planDigest, plan.planDigest);

  const request = retellCallBody(plan);
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

  if (!ALLOW_RETELL_CALLS) badRequest("Retell calls are disabled. Set ALLOW_RETELL_CALLS=true only after approving the deployment and first controlled call.");
  if (!RETELL_API_KEY || !RETELL_AGENT_ID || !RETELL_FROM_NUMBER) {
    badRequest("Retell claim filing is not configured. RETELL_API_KEY, RETELL_AGENT_ID, and RETELL_FROM_NUMBER are required.");
  }
  if (!plan.readiness.ready) badRequest(`Claim filing is blocked: ${plan.readiness.blockers.join("; ")}`);

  const ledger = await readClaimCallLedger();
  const prior = ledger.find((row) => row.planDigest === plan.planDigest && String(row.retryOfCallId || "") === retryOfCallId && row.callId)
    || await findRemoteClaimCallAttempt(plan.planDigest, retryOfCallId);
  if (prior) {
    return {
      mode: "duplicate_prevented",
      file: context.file,
      planDigest: plan.planDigest,
      callId: prior.callId,
      callStatus: prior.callStatus,
      createdAt: prior.createdAt,
      note: "This exact approved filing plan already created a Retell call. No second call was placed."
    };
  }

  if (retryOfCallId) {
    const retryAnalysis = await loadClaimCallAnalysis(retryOfCallId);
    if (retryAnalysis.file.id !== context.file.id) badRequest("retryOfCallId belongs to a different JobNimbus file.");
    if (retryAnalysis.call.callStatus !== "ended") badRequest("The prior call or callback is still active; do not create a retry yet.");
    if (retryAnalysis.extracted.claimNumber || ["claim_filed", "existing_claim_confirmed"].includes(retryAnalysis.extracted.outcome)) {
      badRequest("The prior call already captured a claim number. Review and write back that result instead of retrying.");
    }
    request.metadata.retryOfCallId = retryOfCallId;
  }

  const result = await retellApi("POST", "/v2/create-phone-call", request);
  const record = {
    planDigest: plan.planDigest,
    callId: result.call_id,
    callStatus: result.call_status,
    contactId: context.file.id,
    fileNumber: context.file.number,
    goal: plan.packet.goal,
    retryOfCallId,
    createdAt: new Date().toISOString()
  };
  ledger.push(record);
  await writeClaimCallLedger(ledger.slice(-500));
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
    channel: "retell",
    action: "place_claim_call",
    status: result.call_status || "registered",
    subjectKey: context.file.id,
    fileLabel: `${context.file.number || ""} ${context.file.name || ""}`.trim(),
    summary: `Placed approved Retell carrier call for ${plan.packet.goal}.`,
    externalId: result.call_id,
    evidence: result.call_id ? [`retell:${result.call_id}`] : []
  });
  return {
    mode: "executed",
    file: context.file,
    planDigest: plan.planDigest,
    callId: result.call_id,
    callStatus: result.call_status,
    nextStep: "After the call ends, use reviewClaimFilingCallResult with this callId.",
    memoryCloseout
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
  if (!ALLOW_RETELL_CALLS) badRequest("Retell calls are disabled.");
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
    factualSignals: packet.factualSignals || {}
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
  const response = await retellApi("POST", "/v3/list-calls", {
    filter_criteria: {},
    sort_order: "descending",
    limit: 100
  });
  const row = (response.items || []).find((call) =>
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
    nextStep: proposedCalendarEvent?.ready
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
  if (!RETELL_API_KEY || !RETELL_AGENT_ID) badRequest("RETELL_API_KEY and RETELL_AGENT_ID are required.");
  const agent = await retellApi("GET", `/get-agent/${encodeURIComponent(RETELL_AGENT_ID)}`);
  const llmId = String(agent?.response_engine?.llm_id || "").trim();
  if (agent?.response_engine?.type !== "retell-llm" || !llmId) {
    badRequest("The configured Retell agent does not use a Retell LLM response engine.");
  }

  const llmConfig = buildRetellLlmFromPacket(retellConfigurationPacket(), {
    guardedEndCallUrl: `${PUBLIC_BASE_URL}/retell/guarded-end-call`,
    guardedEndCallAuthorization: BRIDGE_TOKEN ? `Bearer ${BRIDGE_TOKEN}` : ""
  }).toLlmRequestBody();
  const analysisSchema = postCallAnalysisSchema();
  const configDigest = digest({
    agentId: RETELL_AGENT_ID,
    llmId,
    generalPrompt: llmConfig.general_prompt,
    generalTools: llmConfig.general_tools,
    postCallAnalysisData: analysisSchema,
    timeZone: OPERATIONS_TIME_ZONE
  });
  const preview = {
    agentId: RETELL_AGENT_ID,
    llmId,
    currentAgentVersion: agent.version,
    currentPublished: Boolean(agent.is_published),
    configDigest,
    promptCharacters: llmConfig.general_prompt.length,
    toolNames: llmConfig.general_tools.map((tool) => tool.name),
    analysisFields: analysisSchema.map((field) => field.name)
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

  return {
    mode: "executed",
    published: true,
    ...preview,
    draftAgentVersion: Number(draftAgent.version),
    publishedAgentVersion: version,
    retellLlmVersion: llmVersion,
    nextStep: "Verify the deployed bridge health and prepare one inspection-scheduling call. Do not place the call without Chance's approval."
  };
}

async function guardedRetellEndCall(input = {}) {
  const suppliedCall = input.call && typeof input.call === "object" ? input.call : {};
  const args = input.args && typeof input.args === "object" ? input.args : input;
  const callId = required(suppliedCall.call_id || input.call_id || args.call_id, "call.call_id");
  const liveCall = await retellApi("GET", `/v2/get-call/${encodeURIComponent(callId)}`);

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
    ...suppliedCall,
    metadata: { ...(liveCall.metadata || {}), ...(suppliedCall.metadata || {}) },
    retell_llm_dynamic_variables: {
      ...(liveCall.retell_llm_dynamic_variables || {}),
      ...(suppliedCall.retell_llm_dynamic_variables || {})
    },
    transcript_object: suppliedCall.transcript_object?.length
      ? suppliedCall.transcript_object
      : liveCall.transcript_object,
    transcript: suppliedCall.transcript || liveCall.transcript
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

  const candidates = await recentCallbackCandidates(inbound.from_number);
  const { selected, match } = selectCallbackCandidate(candidates, inbound.from_number);
  const dynamicVariables = selected
    ? buildCallbackDynamicVariables(selected, match)
    : buildCallbackDynamicVariables({
        carrier: "Unknown carrier callback",
        insuredName: "Unknown",
        propertyAddress: "Unknown",
        policyNumberSpoken: "Unknown",
        claimNumber: "Unknown"
      }, match);

  if (String(dynamicVariables.goal || "") === "inspection_scheduling") {
    const availability = await collectUnifiedSchedulingAvailability();
    applyAvailabilityDynamicVariables(dynamicVariables, availability);
  }

  if (!selected && candidates.length) {
    dynamicVariables.pendingCallbackCases = candidates.slice(0, 8).map(callbackCaseLabel).join(" | ");
  }
  const metadata = buildCallbackMetadata(selected, match);
  if (!metadata.ownerId) metadata.ownerId = CHANCE_OWNER_ID;

  return {
    call_inbound: {
      override_agent_id: RETELL_AGENT_ID,
      dynamic_variables: dynamicVariables,
      metadata
    }
  };
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
  const candidates = await recentCallbackCandidates("");
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
  return url.searchParams.get("token") === RETELL_INBOUND_WEBHOOK_TOKEN;
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
  const rows = await readJsonFile(CLAIM_CALL_STORE_PATH, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeClaimCallLedger(rows) {
  await mkdir(path.dirname(CLAIM_CALL_STORE_PATH), { recursive: true });
  await writeFile(CLAIM_CALL_STORE_PATH, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
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
  const { contact } = await findChanceContact(query);
  const normalizedFields = normalizeContactFields(fields);
  const plan = { endpoint: `/contacts/${contact.jnid}`, fields: normalizedFields };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body: normalizedFields });
  const refreshedContact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`);
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
  const { contact, knownStatusNames } = await findChanceContact(query);
  const status = resolveWorkflowStatusName(requestedStatus, knownStatusNames);
  const body = { status_name: status };
  const plan = {
    endpoint: `/contacts/${contact.jnid}`,
    body,
    requestedStatus,
    resolvedStatus: status
  };
  if (input.execute !== true) return { mode: "dry_run", file: compactContact(contact), plan };
  const result = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`, { method: "PUT", body });
  const refreshedContact = await jobNimbus(`/contacts/${encodeURIComponent(contact.jnid)}`);
  if (!recordMatchesFields(refreshedContact, body)) {
    conflictError("JobNimbus accepted the status update request, but a fresh read did not confirm the requested status. The bridge will not report this update as complete.");
  }
  const file = compactContact(refreshedContact);
  const memoryCloseout = await closeoutJobNimbusAction(file, "update_status", result, `Moved JobNimbus file to ${status}.`);
  return { mode: "executed", verifiedByReadback: true, file, result, memoryCloseout };
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
  const contactBody = normalizeContactFields({ ...fields, ...(status ? { status_name: status } : {}) });
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
  const document = selectDocument(documents, documentQuery);
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
    ? selectDocument(documents, documentQuery)
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
  const body = cleanObject({
    title,
    subject: title,
    description: input.description || input.note || "",
    note: input.note || input.description || "",
    date_start: toUnixSeconds(input.dateStart || input.dueDate),
    date_end: toUnixSeconds(input.dateEnd || input.dueDate),
    is_completed: Boolean(input.completed || false),
    record_type_name: input.recordTypeName || "Task",
    owners: [{ id: CHANCE_OWNER_ID }],
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
  validateDateRange(body.date_start, body.date_end);
  if (input.execute !== true) {
    return {
      mode: "dry_run",
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
  const taskSubjectKey = String(input.subjectKey || result?.primary?.id || result?.related?.[0]?.id || "").trim();
  const taskFile = input.query
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
  return { mode: "executed", taskId, result, reconciledAfterApiError, memoryCloseout };
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
  const body = cleanObject({
    title,
    subject: title,
    note: input.note || input.description || "",
    description: input.description || input.note || "",
    date_start: dateStart,
    date_end: dateEnd,
    record_type_name: input.recordTypeName || "Event",
    owners: [{ id: CHANCE_OWNER_ID }],
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
  const file = input.query ? compactContact((await findChanceContact(input.query)).contact) : null;
  const body = normalizeDateFields(fields);
  validateDateRange(body.date_start, body.date_end);
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan: { endpoint: `/activities/${eventId}`, body, schedule: centralSchedulePreview(body.date_start, body.date_end) }
    };
  }
  const result = await jobNimbus(`/activities/${encodeURIComponent(eventId)}`, { method: "PUT", body });
  const memoryCloseout = file
    ? await closeoutJobNimbusAction(file, "update_calendar_event", result, `Updated approved JobNimbus calendar event ${eventId}.`)
    : safeCloseoutAction(MEMORY_CONFIG, {
      channel: "jobnimbus",
      action: "update_calendar_event",
      summary: `Updated approved JobNimbus calendar event ${eventId}.`,
      externalId: resultId(result) || eventId,
      evidence: [`jobnimbus:activity:${eventId}`]
    });
  return { mode: "executed", eventId, result, memoryCloseout };
}

async function gmailSearch(input) {
  const query = required(input.query, "query");
  const limit = clamp(Number(input.limit || 10), 1, 25);
  const messages = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
  const rows = Array.isArray(messages.messages) ? messages.messages : [];
  const hydrated = [];
  for (const row of rows) {
    const message = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
    hydrated.push(compactGmailMessage(message));
  }
  return {
    query,
    count: hydrated.length,
    messages: hydrated,
    threads: groupGmailMessagesByThread(hydrated)
  };
}

async function gmailThread(input) {
  const threadId = required(input.threadId, "threadId");
  const thread = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/threads/${encodeURIComponent(threadId)}?format=full`);
  const messages = Array.isArray(thread.messages) ? thread.messages.map(compactGmailFullMessage) : [];
  return {
    id: thread.id || threadId,
    historyId: thread.historyId || "",
    messageCount: messages.length,
    messages,
    assistantRead: buildGmailAssistantRead(messages)
  };
}

async function gmailAttachmentReview(input) {
  const messageId = required(input.messageId, "messageId");
  const attachmentId = required(input.attachmentId, "attachmentId");
  const filename = safeMimeFilename(required(input.filename, "filename"));
  const contentType = String(input.contentType || "application/octet-stream").trim();
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

async function gmailDraft(input) {
  const to = required(input.to, "to");
  const subject = required(input.subject, "subject");
  const cc = String(input.cc || "").trim();
  const bcc = String(input.bcc || "").trim();
  const threadId = String(input.threadId || "").trim();
  const attachments = await loadEmailAttachments(input);
  const resolvedMessage = await resolveGmailMessageBody(input, attachments);
  const body = resolvedMessage.body;
  const reusable = await reusableGmailDraft(input, subject);
  if (reusable) {
    const bodyMatches = normalizeEmailBody(reusable.snapshot.body) === normalizeEmailBody(body);
    return {
      mode: "existing_draft",
      draft: reusable.snapshot,
      bodyTemplate: resolvedMessage.template,
      bodyMatches,
      instruction: bodyMatches
        ? "A verified Gmail draft already exists for this file and subject. Do not create another draft. After Chance approves sending it, use gmail.send with this exact draftId so Gmail sends and removes the reviewed draft."
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
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan: {
        endpoint: "/gmail/v1/users/me/drafts",
        to,
        cc,
        bcc,
        subject,
        body,
        bodyTemplate: resolvedMessage.template,
        threadId,
        attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source))
      }
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to create Gmail drafts.");
  const result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts`, {
    method: "POST",
    body: draftBody
  });
  const file = await optionalChanceFile(input.query || input.fileQuery);
  const memoryCloseout = closeoutGmailAction(input, file, "create_draft", result.id || result.message?.id, `Created approved Gmail draft with subject ${subject} and ${attachments.length} verified attachment(s).`, "drafted");
  return { mode: "executed", draft: compactGmailDraft(result), attachments: attachments.map((attachment) => emailAttachmentDescriptor(attachment, attachment.source)), memoryCloseout };
}

async function gmailSend(input) {
  const draftId = String(input.draftId || "").trim();
  if (draftId) return gmailSendExistingDraft(input, draftId);

  const to = required(input.to, "to");
  const subject = required(input.subject, "subject");
  const cc = String(input.cc || "").trim();
  const bcc = String(input.bcc || "").trim();
  const threadId = String(input.threadId || "").trim();
  const attachments = await loadEmailAttachments(input);
  const resolvedMessage = await resolveGmailMessageBody(input, attachments);
  const body = resolvedMessage.body;
  const reusable = await reusableGmailDraft(input, subject);
  if (reusable) {
    badRequest(`A verified Gmail draft already exists for this file and subject. Send the reviewed draft with gmail.send payload {draftId:'${reusable.snapshot.id}', query:'${input.query || input.fileQuery || ""}'}; do not rebuild the email or create another draft.`);
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

async function gmailSendExistingDraft(input, draftId) {
  const snapshot = await gmailDraftSnapshot(draftId);
  const plan = {
    endpoint: "/gmail/v1/users/me/drafts/send",
    action: "send_existing_draft",
    draftId: snapshot.id,
    messageId: snapshot.messageId,
    threadId: snapshot.threadId,
    to: snapshot.to,
    cc: snapshot.cc,
    bcc: snapshot.bcc,
    subject: snapshot.subject,
    body: snapshot.body,
    attachments: snapshot.attachments,
    contentDigest: snapshot.contentDigest
  };
  const approvalDigest = digest({ channel: "gmail", action: "send_existing_draft", plan });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      plan,
      approvalDigest,
      instruction: "Nothing was sent. After Chance approves this exact existing draft, repeat gmail.send unchanged with execute:true, this draftId, and this approvalDigest. Gmail will send and remove the reviewed draft."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true in Render to send Gmail messages.");
  if (!ALLOW_GMAIL_SEND) badRequest("Gmail sending is disabled. Set ALLOW_GMAIL_SEND=true in Render.");
  requireApprovalDigest(input.approvalDigest, approvalDigest, "Gmail existing-draft send");
  const reservation = await reserveOutboundSend("gmail", approvalDigest, { to: snapshot.to, subject: snapshot.subject });
  let result;
  try {
    result = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts/send`, {
      method: "POST",
      body: { id: draftId }
    });
    await completeOutboundSend(reservation.id, "completed", result.id || "");
  } catch (error) {
    await completeOutboundSend(reservation.id, "failed_requires_review", "", redactSensitiveText(error.message));
    throw error;
  }
  const file = await optionalChanceFile(input.query || input.fileQuery);
  const memoryCloseout = closeoutGmailAction(
    input,
    file,
    "send_draft",
    result.id,
    `Sent and consumed approved Gmail draft with subject ${snapshot.subject} and ${snapshot.attachments.length} verified attachment(s).`
  );
  return {
    mode: "executed",
    message: compactGmailMessage(result),
    consumedDraftId: draftId,
    attachments: snapshot.attachments,
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
  if (!receipt) return null;
  try {
    return { file, receipt, snapshot: await gmailDraftSnapshot(receipt.externalId) };
  } catch (error) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

async function gmailDraftSnapshot(draftId) {
  const draft = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/drafts/${encodeURIComponent(draftId)}?format=full`);
  const message = compactGmailFullMessage(draft.message || {});
  const headers = gmailHeaders(draft.message || {});
  const attachments = message.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.mimeType || ""
  }));
  return {
    id: String(draft.id || draftId),
    messageId: message.id,
    threadId: message.threadId,
    to: headers.to || "",
    cc: headers.cc || "",
    bcc: headers.bcc || "",
    subject: headers.subject || "",
    body: message.plainText || message.htmlText || message.snippet || "",
    attachments,
    contentDigest: digest({
      draftId: String(draft.id || draftId),
      messageId: message.id,
      threadId: message.threadId,
      payload: draft.message?.payload || null
    })
  };
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
  const numbers = await listQuoNumbers(quoConfig());
  return { count: numbers.length, numbers };
}

async function quoHistory(input = {}) {
  let file = null;
  let phone = String(input.phone || "").trim();
  if (input.query) {
    file = compactContact((await findChanceContact(input.query)).contact);
    phone ||= file.phone;
  }
  if (!phone) badRequest("phone or a Chance file query with a phone number is required");
  const history = await readQuoHistory(quoConfig(), {
    phone,
    maxResults: input.maxResults,
    includeTranscripts: input.includeTranscripts === true
  });
  return { generatedAt: new Date().toISOString(), file, ...history };
}

async function quoTranscript(input = {}) {
  const callId = required(input.callId, "callId");
  return readQuoTranscript(quoConfig(), callId);
}

async function quoSend(input = {}) {
  const query = required(input.query, "query");
  const { contact } = await findChanceContact(query);
  const file = compactContact(contact);
  const to = String(input.to || file.phone || "").trim();
  const content = required(input.content || input.message || input.text, "content");
  const authorizedLine = await authorizedQuoLine();
  const from = authorizedLine.number;
  if (!from) badRequest("No Quo sending line is configured for the authenticated employee.");
  const preview = await sendQuoText(quoConfig(), {
    from,
    to,
    content,
    userId: input.userId,
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
      userId: input.userId,
      execute: true
    });
    await completeOutboundSend(reservation.id, "completed", result.message.id || "");
  } catch (error) {
    await completeOutboundSend(reservation.id, "failed_requires_review", "", redactSensitiveText(error.message));
    throw error;
  }
  const memoryCloseout = safeCloseoutAction(MEMORY_CONFIG, {
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
  const deliveryStatus = String(result.message.status || "accepted").toLowerCase();
  const deliveryConfirmed = deliveryStatus === "delivered";
  const deliveryFailed = deliveryStatus === "failed" || deliveryStatus === "undelivered";
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
  const page = clamp(Number(input.page || 1), 1, 1000);
  const limit = clamp(Number(input.limit || (input.query ? 1 : 5)), 1, 10);
  let contacts;
  if (input.query) {
    contacts = [(await findChanceContact(input.query)).contact];
  } else {
    contacts = (await listContacts({ maxPages: Number(input.maxPages || 25) }))
      .filter(isInsuranceFile)
      .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
      .filter((contact) => input.activeOnly === false || isOpenActive(contact))
      .sort(fileSort);
  }
  const total = contacts.length;
  if (input.indexOnly === true && !input.query) {
    return {
      generatedAt: new Date().toISOString(),
      owner: { id: CHANCE_OWNER_ID, name: "Chance Pearson" },
      mode: "index",
      total,
      files: contacts.map(compactChanceIndexContact),
      brain: reviewBrainContext("", input.maxPerSection),
      assistantDirective: [
        "This is a lightweight, fresh JobNimbus index for prioritization only.",
        "The company brain is included, but rich client snapshots are intentionally not overwritten by this lightweight index.",
        "Choose the highest-priority candidate using current status, missing claim facts, and last update.",
        "Then call this endpoint again with that exact file as query, limit 1, and Gmail/Quo enabled before proposing any action.",
        "Do not execute or infer completed work from this index."
      ]
    };
  }
  const selected = input.query ? contacts : contacts.slice((page - 1) * limit, page * limit);
  const packets = [];
  for (const contact of selected) packets.push(await buildChanceEvidencePacket(contact, input));
  const exactSubjectKey = input.query && packets.length === 1 ? packets[0].file.id : "";
  return {
    generatedAt: new Date().toISOString(),
    owner: { id: CHANCE_OWNER_ID, name: "Chance Pearson" },
    query: String(input.query || ""),
    page,
    limit,
    total,
    pageCount: Math.ceil(total / limit),
    complete: packets.every((packet) => packet.complete),
    packets,
    brain: reviewBrainContext(exactSubjectKey, input.maxPerSection),
    assistantDirective: [
      "These are fresh evidence packets joined with durable client continuity, not automatic decisions.",
      "Compare current JobNimbus fields, activities, tasks, operational documents, Gmail, Quo, and prior action receipts.",
      "The snapshot has been refreshed by this review. Use it to remember prior context, but let live evidence win.",
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
    ...file,
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
  const file = compactContact(contact);
  const [activities, tasks, documents] = await Promise.all([
    listRelated("/activities", contact.jnid, 60),
    listRelated("/tasks", contact.jnid, 60),
    listRelated("/files", contact.jnid, 1000)
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
        const search = await gmailSearch({ query, limit: clamp(Number(input.gmailLimit || 8), 1, 15) });
        const threads = [];
        for (const row of search.threads.slice(0, clamp(Number(input.gmailThreadLimit || 3), 1, 5))) {
          const thread = await gmailThread({ threadId: row.threadId });
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
        const history = await readQuoHistory(quoConfig(), {
          phone: file.phone,
          maxResults: clamp(Number(input.quoLimit || 25), 1, 50),
          includeTranscripts: input.includeQuoTranscripts === true
        });
        quo = { status: "fresh", ...history, timeline: history.timeline.slice(-30).reverse() };
      } catch (error) {
        quo = { status: "error", error: redactSensitiveText(error.message), timeline: [], transcripts: [] };
      }
    }
  }
  sourceStatus.quo = { status: quo.status, at: new Date().toISOString() };

  const sortedActivities = [...activities].sort((a, b) => Number(b.date_created || 0) - Number(a.date_created || 0));
  const openTasks = tasks.filter((task) => !task.is_completed).sort((a, b) => Number(a.date_start || a.date_end || 0) - Number(b.date_start || b.date_end || 0));
  const requestedSourcesComplete = [gmail.status, quo.status].every((status) => !["unavailable", "error"].includes(status));
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
    actionReceipts: latestActionReceipts(MEMORY_CONFIG, 20, { subjectKey: file.id }),
    sourceStatus,
    factualSignals: buildFactualSignals(file, sortedActivities, openTasks, operationalDocuments, gmail, quo)
  };
  const snapshot = refreshFileSnapshot(MEMORY_CONFIG, {
    subjectKey: file.id,
    file: packet.file,
    liveJobNimbus: packet.liveJobNimbus,
    gmail: packet.gmail,
    quo: packet.quo,
    actionReceipts: packet.actionReceipts,
    sourceStatus: packet.sourceStatus,
    factualSignals: packet.factualSignals
  });
  return {
    ...packet,
    clientMemory: clientMemoryEnvelope(snapshot)
  };
}

async function processActionBatch(input = {}) {
  const operations = normalizeActionOperations(input.operations);
  const plans = [];
  for (const operation of operations) plans.push(await prepareActionOperation(operation));
  const approvalDigest = digest({ version: 1, operations, plans: stableApprovalPlans(plans) });
  if (input.execute !== true) {
    return {
      mode: "dry_run",
      operationCount: operations.length,
      operations: plans,
      approvalDigest,
      instruction: "Nothing was executed. Show Chance every exact action. After approval, repeat unchanged with execute:true and this approvalDigest."
    };
  }
  if (!ALLOW_WRITES) badRequest("Writes are disabled. Set BRIDGE_ALLOW_WRITES=true before executing an approved batch.");
  requireApprovalDigest(input.approvalDigest, approvalDigest, "action batch");

  const ledger = await readActionBatchLedger();
  const existing = ledger.find((row) => row.approvalDigest === approvalDigest);
  if (existing) {
    return {
      mode: "blocked_duplicate",
      reason: `This exact approved batch is already ${existing.status}. Review its receipt before attempting anything again.`,
      batch: existing
    };
  }
  const batch = {
    id: randomUUID(),
    approvalDigest,
    status: "in_progress",
    createdAt: new Date().toISOString(),
    operationCount: operations.length,
    completed: []
  };
  ledger.push(batch);
  await writeActionBatchLedger(ledger);

  for (let index = 0; index < operations.length; index += 1) {
    try {
      const result = await executeActionOperation(operations[index], plans[index]);
      batch.completed.push({ index, type: operations[index].type, status: "executed", receipt: summarizeOperationResult(result) });
      await writeActionBatchLedger(ledger);
    } catch (error) {
      batch.status = "partial_failure";
      batch.failedAt = index;
      batch.error = redactSensitiveText(error.message || String(error));
      batch.updatedAt = new Date().toISOString();
      await writeActionBatchLedger(ledger);
      return { mode: "partial_failure", batch, reason: "Execution stopped immediately. Review completed receipts before retrying any action." };
    }
  }
  batch.status = "completed";
  batch.completedAt = new Date().toISOString();
  await writeActionBatchLedger(ledger);
  return { mode: "executed", batch };
}

function stableApprovalPlans(plans) {
  return JSON.parse(JSON.stringify(plans, (key, value) => {
    if (["date_created", "generatedAt", "instruction"].includes(key)) return undefined;
    return value;
  }));
}

async function findChanceContact(query) {
  const needle = normalizeContactLookupQuery(query);
  if (!needle) badRequest("query is required");
  const lower = needle.toLowerCase();
  const contacts = await listContacts({ maxPages: 25 });
  const matches = contacts
    .filter(isInsuranceFile)
    .filter((contact) => assignedTo(contact, CHANCE_OWNER_ID))
    .filter((contact) => contactMatches(contact, lower))
    .map((contact) => ({ contact, score: chanceMatchScore(contact, needle) }))
    .sort((a, b) => b.score - a.score || fileSort(a.contact, b.contact));

  if (!matches.length) badRequest(`No Chance Pearson JobNimbus insurance file found for: ${needle}`);
  if (matches.length > 1 && matches[0].score === matches[1].score && matches[0].score < 90) {
    const choices = matches.slice(0, 5).map(({ contact }) => `${contact.number || contact.recid || "?"}: ${contact.display_name || contact.name || "Unnamed"}`);
    badRequest(`Ambiguous Chance file query: ${needle}. Use the JobNimbus number, claim number, or exact address. Matches: ${choices.join("; ")}`);
  }

  const selectedId = matches[0].contact.jnid || matches[0].contact.id;
  const contact = await jobNimbus(`/contacts/${encodeURIComponent(selectedId)}`);
  if (!isInsuranceFile(contact) || !assignedTo(contact, CHANCE_OWNER_ID)) {
    badRequest(`Resolved record is not a Chance Pearson insurance file: ${needle}`);
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
    .sort((a, b) => b.score - a.score || fileSort(a.contact, b.contact));
  const chanceMatches = ranked.filter(({ contact }) => assignedTo(contact, CHANCE_OWNER_ID));

  let matches = chanceMatches;
  let readScope = "chance_assigned";
  if (!matches.length) {
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
  const address = normalizeCompare([contact.address_line1, contact.city, contact.state_text, contact.zip].filter(Boolean).join(" "));
  if (address && address === exact) return 90;
  return 10;
}

async function listContacts({ maxPages }) {
  return listResourcePages("/contacts", maxPages);
}

async function listResourcePages(endpoint, maxPages = 10) {
  const all = [];
  const pageSize = 1000;
  const name = endpoint.replace(/^\//, "").split("?")[0];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const separator = endpoint.includes("?") ? "&" : "?";
    const batch = await jobNimbus(`${endpoint}${separator}size=${pageSize}&from=${offset}`);
    const rows = unwrapList(batch, name);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function listRelated(endpoint, contactId, limit) {
  const filter = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": contactId } }] }));
  const rows = await jobNimbus(`${endpoint}?size=1000&from=0&filter=${filter}`);
  const list = unwrapList(rows, endpoint.replace("/", ""));
  return list.filter((item) => referencesContact(item, contactId)).slice(0, limit);
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
  for (const key of ["primary", "related", "customer", "contact"]) collectIds(item?.[key], ids);
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

function isOpenActive(contact) {
  return contact.is_active !== false && contact.is_archived !== true && contact.is_closed !== true;
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

async function jobNimbus(endpoint, options = {}) {
  if (!API_KEY) badRequest("JOBNIMBUS_API_KEY is not configured.");
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
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const error = new Error(`Google OAuth ${response.status}: ${JSON.stringify(json)}`);
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
  const attachments = [];
  for (const [index, spec] of specs.entries()) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) badRequest(`attachments[${index}] must be an object`);
    const source = String(spec.source || (spec.contentBase64 ? "base64" : "jobnimbus")).trim().toLowerCase();
    if (source === "jobnimbus") {
      const query = required(spec.query || input.query || input.fileQuery, `attachments[${index}].query`);
      const { contact } = await findChanceContact(query);
      const documents = await listRelated("/files", contact.jnid, 1000);
      const document = selectDocument(documents, String(spec.documentQuery || spec.documentId || "").trim());
      if (!document) badRequest(`No matching JobNimbus document found for attachment ${index + 1}.`);
      const downloaded = await downloadJobNimbusFile(document);
      attachments.push(validateEmailAttachment({
        filename: spec.filename || compactDocument(document).name || `attachment-${index + 1}`,
        contentType: spec.contentType || downloaded.contentType || "application/octet-stream",
        bytes: downloaded.bytes,
        source,
        sourceId: document.jnid || document.id || "",
        sourceFileId: contact.jnid
      }));
      continue;
    }
    if (source === "generated_lor") {
      const query = required(spec.query || input.query || input.fileQuery, `attachments[${index}].query`);
      const { contact } = await findChanceContact(query);
      const file = compactContact(contact);
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
        sourceFileId: contact.jnid || contact.id || ""
      }));
      continue;
    }
    if (source === "standard_w9") {
      const attachment = await loadStandardW9Attachment();
      attachments.push(validateEmailAttachment({
        ...attachment,
        filename: spec.filename || attachment.filename,
        source
      }));
      continue;
    }
    if (source === "base64") {
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

async function loadStandardW9Attachment() {
  const query = 'from:richard@wavepa.com filename:"Wave W-9.pdf"';
  const rows = [];
  if (STANDARD_W9_GMAIL_MESSAGE_ID) rows.push({ id: STANDARD_W9_GMAIL_MESSAGE_ID });
  const search = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages?q=${encodeURIComponent(query)}&maxResults=10`);
  for (const row of Array.isArray(search?.messages) ? search.messages : []) {
    if (!rows.some((candidate) => candidate.id === row.id)) rows.push(row);
  }
  for (const row of rows) {
    let message;
    try {
      message = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}?format=full`);
    } catch (error) {
      if (error?.statusCode === 404) continue;
      throw error;
    }
    const match = listGmailAttachments(message?.payload).find((attachment) => /(?:^|\b)wave[ _-]*w[ _-]*9\.pdf$/i.test(attachment.filename));
    if (!match) continue;
    const payload = await gmailApi(`/gmail/v1/users/${encodeURIComponent(GMAIL_USER)}/messages/${encodeURIComponent(row.id)}/attachments/${encodeURIComponent(match.attachmentId)}`);
    return {
      filename: "Wave_W-9.pdf",
      contentType: match.mimeType || "application/pdf",
      bytes: base64UrlToBuffer(payload?.data || ""),
      sourceId: `${row.id}:${match.attachmentId}`
    };
  }
  badRequest("The standard Wave W-9 could not be found in authenticated Gmail. Search Richard's messages for Wave W-9.pdf and verify the attachment still exists.");
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

function validateEmailAttachment(attachment) {
  const filename = safeMimeFilename(attachment.filename);
  const bytes = Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes || []);
  if (!bytes.length) badRequest(`Attachment ${filename} is empty; refusing to draft or send.`);
  const contentType = String(attachment.contentType || "application/octet-stream").trim();
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
    sourceFileId: attachment.sourceFileId || ""
  });
}

function buildRawEmail({ to, cc, bcc, subject, body, attachments = [] }) {
  if (attachments.length) return buildMultipartRawEmail({ to, cc, bcc, subject, body, attachments });
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ].filter(Boolean);
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function buildMultipartRawEmail({ to, cc, bcc, subject, body, attachments }) {
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

function isAmbiguousTaskUpdateError(error) {
  return Number(error?.statusCode) === 400 && /jnLog is not a function/i.test(String(error?.message || ""));
}

function recordMatchesFields(record, fields) {
  if (!record || typeof record !== "object") return false;
  return Object.entries(fields).every(([key, expected]) => {
    const actual = record[key];
    if (typeof expected === "boolean") return Boolean(actual) === expected;
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

function normalizeActionOperations(value) {
  if (!Array.isArray(value) || !value.length) badRequest("operations must be a non-empty array");
  if (value.length > 12) badRequest("An approval batch may contain at most 12 actions.");
  return value.map((operation, index) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) badRequest(`operations[${index}] must be an object`);
    const type = String(operation.type || "").trim().toLowerCase();
    const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
      ? { ...operation.payload }
      : {};
    delete payload.execute;
    delete payload.approvalDigest;
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
  "jobnimbus.create_calendar_event",
  "jobnimbus.update_calendar_event",
  "gmail.create_draft",
  "gmail.send",
  "quo.send_text"
]);

async function prepareActionOperation(operation) {
  const input = { ...operation.payload, execute: false };
  let plan;
  switch (operation.type) {
    case "jobnimbus.update_contact": plan = await updateContact(input); break;
    case "jobnimbus.update_status": plan = await updateStatus(input); break;
    case "jobnimbus.process_update": plan = await processUpdate(input); break;
    case "jobnimbus.create_note": plan = await createNote(input); break;
    case "jobnimbus.create_task": plan = await createTask(input); break;
    case "jobnimbus.update_task": plan = await updateTask(input); break;
    case "jobnimbus.create_calendar_event": plan = await createCalendarEvent(input); break;
    case "jobnimbus.update_calendar_event": plan = await updateCalendarEvent(input); break;
    case "gmail.create_draft": plan = await gmailDraft(input); break;
    case "gmail.send": plan = await gmailSend(input); break;
    case "quo.send_text": plan = await quoSend(input); break;
    default: badRequest(`Unsupported action type: ${operation.type}`);
  }
  return { type: operation.type, plan };
}

async function executeActionOperation(operation, prepared) {
  const input = { ...operation.payload, execute: true };
  switch (operation.type) {
    case "jobnimbus.update_contact": return updateContact(input);
    case "jobnimbus.update_status": return updateStatus(input);
    case "jobnimbus.process_update": return processUpdate(input);
    case "jobnimbus.create_note": return createNote(input);
    case "jobnimbus.create_task": return createTask(input);
    case "jobnimbus.update_task": return updateTask(input);
    case "jobnimbus.create_calendar_event": return createCalendarEvent(input);
    case "jobnimbus.update_calendar_event": return updateCalendarEvent(input);
    case "gmail.create_draft": return gmailDraft(input);
    case "gmail.send": return gmailSend({ ...input, approvalDigest: prepared.plan.approvalDigest });
    case "quo.send_text": return quoSend({ ...input, approvalDigest: prepared.plan.approvalDigest });
    default: badRequest(`Unsupported action type: ${operation.type}`);
  }
}

async function readActionBatchLedger() {
  const rows = await readJsonFile(ACTION_BATCH_STORE_PATH, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeActionBatchLedger(rows) {
  await mkdir(path.dirname(ACTION_BATCH_STORE_PATH), { recursive: true });
  const temporary = `${ACTION_BATCH_STORE_PATH}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(rows.slice(-300), null, 2)}\n`, "utf8");
  await rename(temporary, ACTION_BATCH_STORE_PATH);
}

async function reserveOutboundSend(channel, approvalDigest, metadata = {}) {
  const rows = await readJsonFile(OUTBOUND_SEND_STORE_PATH, []);
  const ledger = Array.isArray(rows) ? rows : [];
  const existing = ledger.find((row) => row.channel === channel && row.approvalDigest === approvalDigest);
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
    subject: String(metadata.subject || "").slice(0, 160)
  };
  ledger.push(row);
  await writeOutboundSendLedger(ledger);
  return row;
}

async function completeOutboundSend(id, status, externalId = "", error = "") {
  const rows = await readJsonFile(OUTBOUND_SEND_STORE_PATH, []);
  const ledger = Array.isArray(rows) ? rows : [];
  const row = ledger.find((item) => item.id === id);
  if (!row) return;
  row.status = status;
  row.externalId = String(externalId || "").slice(0, 300);
  row.error = String(error || "").slice(0, 500);
  row.updatedAt = new Date().toISOString();
  await writeOutboundSendLedger(ledger);
}

async function writeOutboundSendLedger(rows) {
  await mkdir(path.dirname(OUTBOUND_SEND_STORE_PATH), { recursive: true });
  const temporary = `${OUTBOUND_SEND_STORE_PATH}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(rows.slice(-500), null, 2)}\n`, "utf8");
  await rename(temporary, OUTBOUND_SEND_STORE_PATH);
}

function summarizeOperationResult(result) {
  return cleanObject({
    mode: result?.mode || "executed",
    fileId: result?.file?.id || "",
    fileNumber: result?.file?.number || "",
    externalId: resultId(result?.message || result?.draft || result?.result || result?.results || result),
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
  for (const secret of [API_KEY, BRIDGE_TOKEN, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, OPENAI_API_KEY, TWILIO_AUTH_TOKEN, RETELL_API_KEY, QUO_API_KEY].filter((item) => item && item.length >= 8)) {
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
  const token = bearerToken(req);
  if (!token) return null;
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
    resolveUser: resolveFirstUseWaveUser
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

function currentRequestIdentity() {
  return REQUEST_CONTEXT.getStore()?.identity || null;
}

function requestGoogleAccessToken() {
  const identity = currentRequestIdentity();
  return identity?.type === "google_oauth" ? String(identity.googleAccessToken || "") : "";
}

function googleAccessConfiguredForRequest() {
  return Boolean(requestGoogleAccessToken() || (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN));
}

function isPublicRoute(method, pathname) {
  return (method === "GET" && ["/health", "/openapi.json", "/openapi-chatgpt.json", "/privacy", "/handoff", "/voice/twiml"].includes(pathname))
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

async function readJson(req) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BODY_BYTES) {
      const error = new Error(`Request body too large. Limit is ${MAX_JSON_BODY_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    raw += chunk;
  }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { badRequest("Request body must be valid JSON."); }
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

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
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
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      SearchRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address to search for." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"]
      },
      ReviewFileRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, JobNimbus number, claim number, policy number, phone, email, or address for the file to review." }
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
          query: { type: "string", description: "Exact file/client identifier, preferably JobNimbus number, claim number, exact client name, or exact address. Read-only document retrieval may resolve an explicitly named company file; all write actions remain Chance-only." },
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
            enum: ["chance_assigned", "explicit_company_read"],
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
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 }
        },
        required: ["query"]
      },
      GmailThreadRequest: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Gmail thread id returned by searchGmail." }
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
          description: { type: "string" },
          isPrivate: { type: "boolean", default: false },
          execute: { type: "boolean", default: false, description: "Only affects the optional JobNimbus upload. Attachment review itself is read-only." }
        },
        required: ["messageId", "attachmentId", "filename"]
      },
      GmailAttachmentSpec: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["jobnimbus", "generated_lor", "standard_w9", "base64"], default: "jobnimbus", description: "Use generated_lor to build the standard one-page Wave LOR from the current Chance file, standard_w9 to retrieve the verified company W-9 from Gmail, jobnimbus for TDI/FIN535 and other client documents, or base64 only for an already verified external file." },
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
          approvalDigest: { type: "string", description: "Required only for a live send. Must exactly match the immediately preceding send dry run." },
          execute: { type: "boolean", default: false, description: "False returns a dry run. A live send additionally requires ALLOW_GMAIL_SEND=true and the exact approvalDigest." }
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
          query: { type: "string", description: "Optional exact Chance file identifier. Its current phone number will be used." },
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
        properties: { callId: { type: "string" } },
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
          indexOnly: { type: "boolean", default: false, description: "Use true first for a lightweight current index of every active Chance file. Then deep-review one selected file using query and limit 1." },
          page: { type: "integer", minimum: 1, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Use 1 for full evidence reviews so JobNimbus, Gmail, Quo, documents, tasks, and receipts fit within connector response limits." },
          maxPages: { type: "integer", minimum: 1, maximum: 25, default: 25 },
          activeOnly: { type: "boolean", default: true },
          includeGmail: { type: "boolean", default: true },
          includeQuo: { type: "boolean", default: true, description: "When true, reads matching homeowner/adjuster communications across every Quo team line, including other employees' lines, as evidence only." },
          includeQuoTranscripts: { type: "boolean", default: false },
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
              "jobnimbus.create_calendar_event", "jobnimbus.update_calendar_event",
              "gmail.create_draft", "gmail.send", "quo.send_text"
            ]
          },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Exact payload. Do not include execute or approvalDigest. Examples: task {taskId:'ID',completed:true}; note {query:'JN',note:'Exact'}; fields/status {query:'JN',fields:{...},status:'Exact'}; first Gmail draft with exact content. If that draft is approved later, send it with gmail.send {query:'JN',draftId:'RETURNED_DRAFT_ID'}; never recreate or raw-send a second copy."
          }
        },
        required: ["type", "payload"]
      },
      ActionBatchRequest: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { $ref: "#/components/schemas/ActionOperation" },
            description: "Every exact approved action. For task completion use type jobnimbus.update_task with payload {taskId:'TASK_ID',completed:true}. The dry run returns the canonical JobNimbus body before anything executes."
          },
          approvalDigest: { type: "string", description: "Required for execution. Must match the immediately preceding unchanged batch dry run." },
          execute: { type: "boolean", default: false, description: "False prepares the exact batch. True executes once after Chance approves its digest. Duplicate execution is blocked." }
        },
        required: ["operations"]
      },
      ClaimFilingPrepareRequest: {
        type: "object",
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
          overrides: { type: "object", additionalProperties: true, description: "Approved per-call overrides. If DOL must also be saved to JobNimbus, execute and verify that update first, then prepare the call from the refreshed file. A later DOL change intentionally invalidates an earlier plan digest." }
        },
        required: ["query"]
      },
      ClaimFilingCallRequest: {
        type: "object",
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
          overrides: { type: "object", additionalProperties: true },
          retryOfCallId: { type: "string", description: "For an intentional retry only: the prior ended Retell call id for this same file. The bridge rejects retries while a callback is active or after a claim number was captured." },
          execute: { type: "boolean", default: false, description: "True only after Chance approves the exact prepared plan. Also requires ALLOW_RETELL_CALLS=true." }
        },
        required: ["query", "planDigest"]
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
    "/claim-filing/call": {
      post: {
        operationId: "placeApprovedClaimFilingCall",
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
        requestBody: jsonBody("ClaimFilingWritebackRequest"),
        responses: { "200": { description: "Rechecks the Chance file and call result, then dry-runs or executes the exact approved JobNimbus field/status/note update." } }
      }
    },
    "/retell/configure-agent": {
      post: {
        operationId: "configureApprovedRetellAgent",
        requestBody: jsonBody("RetellAgentConfigurationRequest"),
        responses: { "200": { description: "Dry-runs or, after exact digest approval, updates and publishes the Retell prompt, tools, timezone, and post-call extraction schema." } }
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
