import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CHANCE_RUN_ACTION_TYPES } from "./scope.mjs";
import { APPROVED_NOTES_ENABLED } from "./approved-note-release.mjs";
import { PDF_UPLOADS_ENABLED } from "./pdf-upload-release.mjs";
import { PDF_UPLOAD_TYPE } from "./pdf-upload-contract.mjs";
import { createOperatorCoordinator } from "./operator-coordinator.mjs";
import { createInstalledManagementReportClient } from "./management-report.mjs";
import {
  createResearchCoordinator,
  loadResearchPin,
  RESEARCH_KEYCHAIN_ACCOUNT,
  RESEARCH_KEYCHAIN_SERVICE,
  RESEARCH_ROUTES
} from "./research-coordinator.mjs";

const PLUGIN_MANIFEST = JSON.parse(readFileSync(
  new URL("../.codex-plugin/plugin.json", import.meta.url),
  "utf8"
));
const VERSION = String(PLUGIN_MANIFEST.version || "").trim();
if (!VERSION) throw new Error("The JobNimbus plugin manifest has no version.");
const BASE_URL = "https://jobnimbus-chatgpt-bridge.onrender.com";
const KEYCHAIN_SERVICE = "com.wavepa.jobnimbus-operator";
const KEYCHAIN_ACCOUNT = "codex-mac-operator";
const FILE_CACHE = path.join(
  os.homedir(),
  "Library",
  "Caches",
  KEYCHAIN_SERVICE,
  "files"
);
// PDF bytes enter only through the local-file tools, not a chat base64 payload.
const ACTION_TYPES = CHANCE_RUN_ACTION_TYPES.filter((type) => type !== PDF_UPLOAD_TYPE);

function operatorToken() {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w"
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000
      }
    ).trim();
  } catch {
    throw new Error(
      "The Mac JobNimbus operator credential is not installed in macOS Keychain."
    );
  }
}

// Pin one Keychain credential for this MCP process so every attestation GET,
// approval POST, execution POST, and receipt read uses the same principal.
// Credential rotation is picked up only by starting a new MCP process.
const OPERATOR_BEARER_TOKEN = operatorToken();

function cleanFilename(value) {
  const safe = String(value || "jobnimbus-document")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return safe || "jobnimbus-document";
}

async function materializeOpenAiFiles(payload) {
  const files = Array.isArray(payload?.openaiFileResponse)
    ? payload.openaiFileResponse
    : [];
  if (!files.length) return payload;

  await mkdir(FILE_CACHE, { recursive: true, mode: 0o700 });
  const localFiles = [];
  for (const file of files) {
    const bytes = Buffer.from(String(file?.content || ""), "base64");
    if (!bytes.length) continue;
    const prefix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const filename = `${prefix}-${cleanFilename(file?.name)}`;
    const localPath = path.join(FILE_CACHE, filename);
    await writeFile(localPath, bytes, { mode: 0o600 });
    localFiles.push({
      name: String(file?.name || filename),
      mimeType: String(file?.mime_type || "application/octet-stream"),
      bytes: bytes.length,
      localPath
    });
  }
  const result = { ...payload, localFiles };
  delete result.openaiFileResponse;
  return result;
}

async function bridgeRequest(method, pathname, body) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${OPERATOR_BEARER_TOKEN}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240000)
  });
  const contentType = String(response.headers.get("content-type") || "");
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { text: await response.text() };
  if (!response.ok) {
    const message = String(payload?.error || payload?.message || payload?.text || "");
    throw new Error(`Bridge ${response.status}: ${message || "request failed"}`);
  }
  return materializeOpenAiFiles(payload);
}

const OPERATOR = createOperatorCoordinator({
  bridgeRequest,
  version: VERSION
});

function companyBody(input = {}) {
  return { ...input, operatorScope: "company" };
}

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value, null, 2)
    }]
  };
}

function register(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (input) => {
    try {
      return textResult(await handler(input || {}));
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  });
}

const server = new McpServer({
  name: "jobnimbus-operator",
  version: VERSION
});

// Separate read-only HCN reporting credential. Ordinary operator scope,
// manifest, approvals, and production bridge build pins are not broadened.
const MANAGEMENT_REPORT = createInstalledManagementReportClient();
register("management_report_status", "Verify the separate HCN read-only three-adjuster report connection and exact deployed build. No Google login, client effects, or operational credential fallback.", z.object({}).strict(), () => MANAGEMENT_REPORT.verifySession());
register("management_gap_report", "Run a fresh read-only 3x10 JobNimbus activity-gap report for the three configured adjusters on the Estimating board. Preserves evidence warnings; Gmail and Quo are not evaluated. No customer writes, messages, calls, or AI-model spend.", z.object({}).strict(), () => MANAGEMENT_REPORT.runReport());

// An absent locally installed research pin leaves the operational tool surface
// unchanged. No research credential, directory, or provider is touched here.
// The research identity never falls back to OPERATOR_BEARER_TOKEN.
let RESEARCH_PIN = null;
try {
  RESEARCH_PIN = await loadResearchPin(process.env.JOBNIMBUS_DOCUMENT_RESEARCH_PIN_PATH);
} catch {
  process.stderr.write("Document research is disabled: its local private pin is missing, invalid, or expired. Operational tools are unchanged.\n");
}
if (RESEARCH_PIN) {
  let researchToken;
  const researchRequest = async (method, pathname, body) => {
    if (!RESEARCH_ROUTES.includes(`${method} ${pathname}`)) {
      throw new Error("The document research transport forbids this route.");
    }
    if (!researchToken) {
      try {
        const candidate = execFileSync("/usr/bin/security", [
          "find-generic-password", "-s", RESEARCH_KEYCHAIN_SERVICE,
          "-a", RESEARCH_KEYCHAIN_ACCOUNT, "-w"
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
        if (!/^[\x21-\x7e]{32,512}$/.test(candidate) || candidate === OPERATOR_BEARER_TOKEN) {
          throw new Error("Invalid isolated research credential");
        }
        researchToken = candidate;
      } catch {
        throw new Error("The separate document research credential is missing, invalid, or collides with the operational identity.");
      }
      if (!researchToken) throw new Error("The separate document research credential is empty.");
    }
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${researchToken}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("application/json")) {
      await response.body?.cancel();
      throw new Error(`Document research request failed (${response.status}); no original was saved.`);
    }
    const maximum = Math.ceil(RESEARCH_PIN.limits.maxBytesPerFile * 4 / 3) + 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body?.cancel();
      throw new Error("Document research response exceeds its byte limit.");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) throw new Error("Document research response exceeds its byte limit.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const research = createResearchCoordinator({
    researchRequest,
    grant: RESEARCH_PIN,
    cacheRoot: path.join(FILE_CACHE, "research")
  });
  register("document_research_session", "Verify the separately pinned, expiring, read-only document research identity. Does not authorize operational tools.", z.object({}).strict(), () => research.verifySession());
  register("document_research_inventory", "Read one bounded page of the isolated document research inventory. Only the returned continuation cursor is accepted; ambiguous PDFs remain inventory-only.", z.object({
    cursor: z.string().min(1).max(4096).optional()
  }).strict(), input => research.inventory(input));
  register("document_research_original", "Retrieve one exact current-inventory PDF or ESX original into the private research cache after source binding, length, SHA-256 and file-signature verification. ESX is internal owner-confirmed evidence; archives are never extracted or executed. No automatic cache cleanup or data transfer.", z.object({
    runId: z.string().min(1).max(200),
    documentId: z.string().min(1).max(200),
    fileId: z.string().min(1).max(200)
  }).strict(), input => research.original(input));
}

register(
  "bridge_whoami",
  "Verify the dedicated Mac operator identity and its exact restrictions before HCN/Wave work.",
  {},
  () => bridgeRequest("GET", "/auth/whoami")
);

register(
  "bridge_session",
  "Verify the local plugin, production bridge build, exact 58-file run manifest, and unresolved receipt boundary before HCN/Wave work.",
  {},
  () => OPERATOR.verifiedBridgeSession()
);

register(
  "bridge_restart_verify",
  "Mandatory first check after a Codex restart or new chat. Verifies the dedicated Mac identity, exact provider-attested bridge commit, six-receipt never-replay historical isolation, JobNimbus action-batch plus single-file Retell claim-filing boundary, pinned 58-file manifest, #2628 exclusion, expiry, and classified receipt boundary. Only the Retell claim-filing call gate may be enabled; every generic send, generic/homeowner/carrier-follow-up call, and HCN action gate remains disabled. The reviewed existing-draft send exception exists only inside the pinned action batch. Recovery is allowed only when every new unresolved batch is reconciliation-eligible and none is hard-blocked; rerun afterward and require ready true.",
  {},
  () => OPERATOR.restartVerifiedBridgeSession()
);

register(
  "run_policy_read",
  "Read the bridge's exact locked 58-file run-policy attestation and unresolved batch boundary. Read-only.",
  {},
  () => bridgeRequest("GET", "/ops/run-policy")
);

register(
  "action_batch_receipt_list",
  "List this Mac operator's minimized action-batch receipts. Use before retries or after a restart. Read-only and never resumes work.",
  {
    fileNumber: z.string().regex(/^#?\d+$/).optional(),
    statuses: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(50).optional()
  },
  (input) => bridgeRequest("POST", "/ops/action-batch-receipts", input)
);

register(
  "action_batch_receipt_detail",
  "Read one exact minimized Mac operator batch receipt. Read-only; never retries, resumes, or reconciles provider state.",
  { batchId: z.string().uuid() },
  (input) => bridgeRequest("POST", "/ops/action-batch-receipts", input)
);

register(
  "action_batch_reconcile",
  "Manually reconcile one exact durable batch after reading its receipt. This re-reads provider state and may update only bridge receipt metadata; it never retries, resumes, executes, creates a draft, or changes JobNimbus/Gmail provider state. Treat not_applied_verified as requiring fresh evidence, a new plan, and a new approval. For manual_quarantined/unknown_file_quarantined, never retry: scope file/files blocks only the listed exact files; scope global hard-stops all work and the batch must not be reconciled again.",
  { batchId: z.string().uuid() },
  ({ batchId }) => OPERATOR.reconcileActionBatch(batchId)
);

register(
  "jobnimbus_search",
  "Search Chance-assigned JobNimbus files by identifying fact. Use this to resolve one exact file before review.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).optional(),
    maxPages: z.number().int().min(1).max(25).optional()
  },
  (input) => bridgeRequest("POST", "/jobnimbus/search", input)
);

register(
  "jobnimbus_review_file",
  "Read one exact Chance-assigned JobNimbus file with its current fields, activities, tasks, documents, and payments.",
  { query: z.string().min(1) },
  (input) => bridgeRequest("POST", "/jobnimbus/review-file", input)
);

register(
  "company_find_exact_file",
  "Resolve one explicitly named company JobNimbus insurance file outside the normal Chance lane. Use only when Chance or Richard identifies the file; broad company searches are blocked.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(5).optional(),
    maxPages: z.number().int().min(1).max(25).optional()
  },
  (input) => bridgeRequest(
    "POST",
    "/jobnimbus/search",
    companyBody(input)
  )
);

register(
  "company_review_exact_file",
  "Deep-review one explicitly named company file with fresh JobNimbus, Gmail, and company-wide Quo evidence. This never starts a company sweep and does not execute changes.",
  {
    query: z.string().min(1),
    includeGmail: z.boolean().optional(),
    includeQuo: z.boolean().optional(),
    includeQuoTranscripts: z.boolean().optional(),
    communicationDays: z.number().int().min(1).max(3650).optional(),
    gmailLimit: z.number().int().min(1).max(15).optional(),
    gmailThreadLimit: z.number().int().min(1).max(5).optional(),
    quoLimit: z.number().int().min(1).max(50).optional()
  },
  (input) => bridgeRequest(
    "POST",
    "/ops/review-chance-files",
    companyBody({
      ...input,
      limit: 1,
      activeOnly: false,
      includeGmail: input.includeGmail !== false,
      includeQuo: input.includeQuo !== false
    })
  )
);

register(
  "ops_start_session",
  "Start a Thresher session using fresh live evidence. Priority mode reviews the Chance backlog; today_inspections reviews today's inspection work. Review Gmail and Quo only after resolving an exact assigned file.",
  {
    focus: z.enum(["priority", "today_inspections"]).optional(),
    maxPages: z.number().int().min(1).max(25).optional(),
    maxPerSection: z.number().int().min(1).max(25).optional(),
    includeQuoTranscripts: z.boolean().optional(),
    includeBrainAdvisory: z.boolean().optional(),
    communicationDays: z.number().int().min(1).max(3650).optional(),
    gmailLimit: z.number().int().min(1).max(15).optional(),
    gmailThreadLimit: z.number().int().min(1).max(5).optional(),
    quoLimit: z.number().int().min(1).max(50).optional(),
    quoTranscriptLimit: z.number().int().min(0).max(25).optional()
  },
  (input) => bridgeRequest("POST", "/ops/start-session", input)
);

register(
  "ops_review_chance_files",
  "Run the evidence-first Chance file index or deep-review one exact file. Start with indexOnly true, then review one selected file with limit 1.",
  {
    query: z.string().optional(),
    indexOnly: z.boolean().optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(10).optional(),
    maxPages: z.number().int().min(1).max(25).optional(),
    activeOnly: z.boolean().optional(),
    includeGmail: z.boolean().optional(),
    includeQuo: z.boolean().optional(),
    includeQuoTranscripts: z.boolean().optional(),
    includeCompleteJobNimbusEvidence: z.boolean().optional(),
    includeBrainAdvisory: z.boolean().optional(),
    communicationDays: z.number().int().min(1).max(3650).optional(),
    gmailLimit: z.number().int().min(1).max(15).optional(),
    gmailThreadLimit: z.number().int().min(1).max(5).optional(),
    quoLimit: z.number().int().min(1).max(50).optional()
  },
  (input) => bridgeRequest("POST", "/ops/review-chance-files", input)
);

register(
  "scheduling_availability",
  "Read Chance's unified JobNimbus and Google Calendar availability. This is read-only and fails closed when either source is unavailable.",
  {},
  () => bridgeRequest("POST", "/scheduling/availability", {})
);

register(
  "jobnimbus_document_text",
  "Extract text or OCR from one exact operational document on a Chance-assigned file.",
  {
    query: z.string().min(1),
    documentQuery: z.string().optional(),
    maxChars: z.number().int().min(1000).max(50000).optional(),
    forceOcr: z.boolean().optional(),
    maxOcrPages: z.number().int().min(1).max(20).optional()
  },
  (input) => bridgeRequest("POST", "/jobnimbus/document-text", input)
);

register(
  "jobnimbus_document_review",
  "Review one unique policy, TDI, estimate/scope, carrier, appraisal, or representation document. Original files that require native review are downloaded to a secure local cache and returned as localFiles.",
  {
    query: z.string().min(1),
    documentQuery: z.string().optional(),
    documentPurpose: z.enum([
      "insurance_policy",
      "tdi_form",
      "estimate_scope",
      "carrier_claim_document",
      "appraisal_document",
      "representation_contract"
    ]).optional(),
    maxChars: z.number().int().min(1000).max(50000).optional(),
    previewChars: z.number().int().min(500).max(12000).optional(),
    forceOcr: z.boolean().optional(),
    maxOcrPages: z.number().int().min(1).max(20).optional()
  },
  (input) => bridgeRequest("POST", "/jobnimbus/document-review", input)
);

register(
  "jobnimbus_document_file",
  "Download one exact JobNimbus document into this Mac's secure local cache for native PDF or image inspection.",
  {
    query: z.string().min(1),
    documentQuery: z.string().min(1)
  },
  (input) => bridgeRequest("POST", "/jobnimbus/document-file", input)
);

register(
  "company_document_review",
  "Review one exact operational document on an explicitly named company file. Native files are returned to the secure Mac cache when needed.",
  {
    query: z.string().min(1),
    documentQuery: z.string().optional(),
    documentPurpose: z.enum([
      "insurance_policy",
      "tdi_form",
      "estimate_scope",
      "carrier_claim_document",
      "appraisal_document",
      "representation_contract"
    ]).optional(),
    maxChars: z.number().int().min(1000).max(50000).optional(),
    previewChars: z.number().int().min(500).max(12000).optional(),
    forceOcr: z.boolean().optional(),
    maxOcrPages: z.number().int().min(1).max(20).optional()
  },
  (input) => bridgeRequest(
    "POST",
    "/jobnimbus/document-review",
    companyBody(input)
  )
);

register(
  "company_document_file",
  "Download one exact document from an explicitly named company JobNimbus file into this Mac's secure local cache.",
  {
    query: z.string().min(1),
    documentQuery: z.string().min(1)
  },
  (input) => bridgeRequest(
    "POST",
    "/jobnimbus/document-file",
    companyBody(input)
  )
);

register(
  "gmail_search_exact_file",
  "Search the connected Wave Gmail mailbox only through facts freshly bound to one exact Chance-assigned JobNimbus file.",
  {
    fileQuery: z.string().min(1),
    communicationDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(25).optional()
  },
  (input) => bridgeRequest("POST", "/gmail/search", input)
);

register(
  "gmail_read_thread_exact_file",
  "Read a Gmail thread only after the bridge verifies it belongs to one exact Chance-assigned file.",
  {
    fileQuery: z.string().min(1),
    threadId: z.string().min(1)
  },
  (input) => bridgeRequest("POST", "/gmail/thread", input)
);

register(
  "gmail_review_attachment_exact_file",
  "Extract or OCR a Gmail attachment only after exact-file correlation. This tool never uploads the attachment.",
  {
    fileQuery: z.string().min(1),
    messageId: z.string().min(1),
    attachmentId: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().optional(),
    maxChars: z.number().int().min(1000).max(50000).optional(),
    previewChars: z.number().int().min(500).max(12000).optional(),
    forceOcr: z.boolean().optional(),
    maxOcrPages: z.number().int().min(1).max(20).optional()
  },
  (input) => bridgeRequest("POST", "/gmail/attachment-review", {
    ...input,
    uploadToJobNimbus: false,
    execute: false
  })
);

register(
  "company_gmail_read_thread_exact_file",
  "Read a Gmail thread only after the bridge correlates it to one explicitly named company JobNimbus file.",
  {
    fileQuery: z.string().min(1),
    threadId: z.string().min(1)
  },
  (input) => bridgeRequest(
    "POST",
    "/gmail/thread",
    companyBody(input)
  )
);

register(
  "company_gmail_review_attachment_exact_file",
  "Extract or OCR a Gmail attachment only after correlation to one explicitly named company file. This never uploads it.",
  {
    fileQuery: z.string().min(1),
    messageId: z.string().min(1),
    attachmentId: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().optional(),
    maxChars: z.number().int().min(1000).max(50000).optional(),
    previewChars: z.number().int().min(500).max(12000).optional(),
    forceOcr: z.boolean().optional(),
    maxOcrPages: z.number().int().min(1).max(20).optional()
  },
  (input) => bridgeRequest(
    "POST",
    "/gmail/attachment-review",
    companyBody({
      ...input,
      uploadToJobNimbus: false,
      execute: false
    })
  )
);

register(
  "quo_list_numbers",
  "List configured company Quo phone lines for communication evidence discovery. Read-only.",
  {},
  () => bridgeRequest("POST", "/quo/numbers", {})
);

register(
  "quo_history_exact_file",
  "Review company-wide Quo calls, voicemails, and texts matched to one exact Chance-assigned file. Never provide an arbitrary phone number.",
  {
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional(),
    includeTranscripts: z.boolean().optional()
  },
  (input) => bridgeRequest("POST", "/quo/history", input)
);

register(
  "quo_transcript_exact_file",
  "Read one Quo call transcript only after the bridge verifies call membership in an exact Chance-assigned file.",
  {
    query: z.string().min(1),
    callId: z.string().min(1)
  },
  (input) => bridgeRequest("POST", "/quo/transcript", input)
);

register(
  "company_quo_transcript_exact_file",
  "Read one Quo call transcript only after the bridge verifies the call belongs to one explicitly named company file.",
  {
    query: z.string().min(1),
    callId: z.string().min(1)
  },
  (input) => bridgeRequest(
    "POST",
    "/quo/transcript",
    companyBody(input)
  )
);

const claimFilingOverridesSchema = z.object({
  insuredName: z.string().optional(),
  propertyAddress: z.string().optional(),
  carrier: z.string().optional(),
  policyNumber: z.string().optional(),
  claimNumber: z.string().optional(),
  dateOfLoss: z.string().optional(),
  causeOfLoss: z.string().optional(),
  mortgageCompany: z.string().optional(),
  stormTime: z.string().optional(),
  occupancy: z.string().optional(),
  damageDiscovered: z.string().optional(),
  propertyStories: z.string().optional(),
  roofAccessibility: z.string().optional(),
  damagedRooms: z.string().optional(),
  damagedRoomCount: z.string().optional(),
  contractorPhone: z.string().optional(),
  injuries: z.string().optional(),
  homeLivable: z.string().optional(),
  temporaryRepairs: z.string().optional(),
  contractorHired: z.string().optional(),
  damageOpening: z.string().optional(),
  damageDetails: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1)
  ]).optional(),
  coverageTermStatus: z.enum([
    "verified_in_force",
    "carrier_lookup_required",
    "blocked_conflict"
  ]).optional(),
  policyCoverageStart: z.string().optional(),
  policyCoverageEnd: z.string().optional()
}).strict();

const claimFilingInputShape = {
  query: z.string().regex(/^#?\d+$/),
  goal: z.enum(["file_new_claim", "find_existing_claim"]).optional(),
  to: z.string().min(1).optional(),
  carrierPhone: z.string().min(1).optional(),
  retryOfCallId: z.string().min(1).optional(),
  stormTime: z.string().min(1).optional(),
  occupancy: z.string().min(1).optional(),
  damageDiscovered: z.string().min(1).optional(),
  propertyStories: z.string().min(1).optional(),
  roofAccessibility: z.string().min(1).optional(),
  damagedRooms: z.string().min(1).optional(),
  damagedRoomCount: z.string().min(1).optional(),
  contractorPhone: z.string().min(1).optional(),
  injuries: z.string().min(1).optional(),
  homeLivable: z.string().min(1).optional(),
  temporaryRepairs: z.string().min(1).optional(),
  contractorHired: z.string().min(1).optional(),
  overrides: claimFilingOverridesSchema.optional()
};

register(
  "retell_claim_configuration_verify",
  "Read and attest the live published Retell carrier claim-filing agent against the exact deployed bridge prompt, tools (including DTMF and guarded end-call), extraction schema, timezone, callback restoration, and separate-writeback boundary. Read-only; never configures an agent or places a call.",
  {},
  () => OPERATOR.readClaimFilingConfiguration()
);

register(
  "retell_claim_call_plan",
  "Prepare one exact Chance-manifest claim-filing call only after a fresh exact-file JobNimbus, Gmail, and Quo review finds no new-claim stop signal. The wrapper forces includeCarrierBatch:false, allows only file_new_claim or find_existing_claim, rejects #2628, freshly attests the bridge and live Retell configuration, and retains the communication digest plus short-lived one-use challenge locally. This never places a call. Show the complete returned packet, communicationPreflight, readiness, destination, planDigest, approvalId, and approvedInput to Chance for exact approval.",
  claimFilingInputShape,
  (input) => OPERATOR.planClaimFilingCall(input)
);

register(
  "retell_claim_call_execute",
  "Place exactly one Retell carrier claim-filing call only after Chance explicitly approves the immediately preceding complete plan. Requires that plan's local approvalId, planDigest, and every unchanged input field. The hidden bridge challenge is consumed once; immediately before calling, the wrapper re-attests the bridge, reruns the exact-file JobNimbus/Gmail/Quo review, requires its evidence digest to remain unchanged, and rechecks the live Retell configuration. This does not update JobNimbus, create a note or task, send an email/text, or expose claim-result writeback.",
  {
    approvalId: z.string().uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    ...claimFilingInputShape
  },
  ({ approvalId, planDigest, ...input }) => OPERATOR.executeClaimFilingCall(
    approvalId,
    planDigest,
    input
  )
);

register(
  "retell_claim_call_get",
  "Read one exact Retell claim-filing call, callback continuation, transcript, structured extraction, confidence review, and dry-run proposals after a fresh bridge attestation. Read-only. Any JobNimbus field, status, task, note, calendar, email, or text action requires a separate workflow and approval; claim writeback is not exposed here.",
  { callId: z.string().min(1) },
  ({ callId }) => OPERATOR.reviewClaimFilingCallResult(callId)
);

register(
  "retell_claim_pending_callbacks",
  "Read the currently pending carrier callbacks for exact in-manifest Chance claim calls after a fresh bridge attestation. Read-only; never places or resumes a call.",
  {},
  () => OPERATOR.listPendingClaimCallbacks()
);

const operationSchema = z.object({
  type: z.enum(ACTION_TYPES),
  payload: z.record(z.string(), z.unknown())
}).superRefine((operation, context) => {
  if (operation.type !== "gmail.send_existing_draft") return;
  const keys = Object.keys(operation.payload).sort();
  if (
    keys.length !== 2
    || keys[0] !== "draftId"
    || keys[1] !== "query"
    || !/^#?\d+$/.test(String(operation.payload.query || ""))
    || !/^[A-Za-z0-9_-]{1,512}$/.test(String(operation.payload.draftId || ""))
  ) {
    context.addIssue({
      code: "custom",
      message: "gmail.send_existing_draft requires exactly {query,draftId} for one numeric manifest file; raw recipients, content, attachments, and control fields are forbidden."
    });
  }
});

if (PDF_UPLOADS_ENABLED) {
  register(
    "pdf_upload_plan",
    "Snapshot one reviewed local PDF for one active Chance-manifest file. No upload yet. Show the exact client, filename, privacy, size, SHA-256 and approvalDigest to Chance. PDF contents are not printed or persisted by the bridge. A new plan invalidates older approvals. Upload approval does not approve an email draft or send.",
    { query: z.string().regex(/^#?\d+$/), path: z.string().min(1), filename: z.string().min(1), isPrivate: z.boolean() },
    (input) => OPERATOR.planPdfUpload(input)
  );
  register(
    "pdf_upload_execute",
    "Upload only after Chance explicitly approves the unchanged immediately preceding PDF plan. Uses the captured immutable bytes and the one-use approvalDigest, re-attests the bridge, then verifies provider ID, client, metadata and downloaded bytes. Any uncertain outcome stops; use receipt recovery, never retry or fall back to browser/raw API. Drafting and sending remain separately approved actions.",
    { approvalDigest: z.string().regex(/^[a-f0-9]{64}$/) },
    ({ approvalDigest }) => OPERATOR.executePdfUpload(approvalDigest)
  );
}

register(
  "action_batch_plan",
  "Prepare an exact dry-run JobNimbus/Gmail batch under the pinned 58-file Thresher manifest. The wrapper freshly re-attests the exact bridge build, boot, policy, six-receipt historical isolation, runtime, identity, capabilities, and ready receipt boundary before posting. Up to five exact Chance files may contain one contact correction, one forward stage move, and one current-control task each, in that order. Gmail draft creation remains a sole-operation batch and is not a send. A reviewed bridge-created draft may be sent only in a later sole-operation gmail.send_existing_draft batch with exactly {query,draftId} and a new approval. "
    + (APPROVED_NOTES_ENABLED || PDF_UPLOADS_ENABLED
      ? "One exact-file JobNimbus note may be prepared as a sole-operation batch with exactly {query,note}. Only one canonical @RichardR mention request is accepted, bound to Richard R's exact user ID in the displayed plan. All other @ text is blocked. Mention rendering and notification delivery are unverified: preserve mentionsVerified:false and accountingNotified:false. "
      : "JobNimbus notes are not activated and remain blocked. ")
    + "Raw sends, #2628, completions, calendar writes, backward moves, and every call outside the separate single-file Retell claim-filing lane are blocked. Show the complete returned plan and approvalDigest to Chance before execution.",
  {
    operations: z.array(operationSchema).min(1).max(15)
  },
  ({ operations }) => OPERATOR.planActionBatch(operations, "assigned")
);

register(
  "action_batch_execute",
  "Execute only the unchanged action batch that Chance explicitly approved in the immediately preceding plan. Requires that plan's approvalDigest and exact operations; the hidden challenge is consumed once and never exposed to chat. Before posting, the wrapper freshly re-attests ready:true and requires the exact same stored boot, build, policy, historical isolation, runtime, identity, and capability boundary. Existing-draft Gmail delivery is accepted only when the receipt proves the exact approved draftId, a provider Sent-message id, immutable readback, and retained source draft.",
  {
    approvalDigest: z.string().min(1),
    operations: z.array(operationSchema).min(1).max(15)
  },
  ({ approvalDigest, operations }) => OPERATOR.executeActionBatch(
    approvalDigest,
    operations,
    "assigned"
  )
);

await server.connect(new StdioServerTransport());
