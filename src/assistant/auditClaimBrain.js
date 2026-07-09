import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, writeText } from "../lib/io.js";

export function runClaimBrainAudit(config) {
  const rawDir = config.paths.rawDir;
  const reportsDir = config.paths.reportsDir;
  const claimBrainDir = path.join(config.projectRoot, "work", "claim-brain");
  fs.mkdirSync(claimBrainDir, { recursive: true });

  const raw = {
    contacts: readOptionalJson(path.join(rawDir, "contacts.json"), []),
    tasks: readOptionalJson(path.join(rawDir, "tasks.json"), []),
    activities: readOptionalJson(path.join(rawDir, "activities.json"), []),
    documents: readOptionalJson(path.join(rawDir, "documents.json"), []),
    payments: readOptionalJson(path.join(rawDir, "payments.json"), []),
    accountSettings: readOptionalJson(path.join(rawDir, "accountSettings.json"), []),
    accountUsers: readOptionalJson(path.join(rawDir, "accountUsers.json"), []),
    syncMeta: readOptionalJson(path.join(rawDir, "sync-meta.json"), {})
  };

  const audit = buildAudit(raw);
  const storageSpec = buildStorageSpec(audit);
  const schema = buildSchema();
  const relationshipMap = buildRelationshipMap(audit);

  writeJson(path.join(claimBrainDir, "jobnimbus-local-storage-spec.json"), storageSpec);
  writeJson(path.join(claimBrainDir, "claim-file-schema-v2.json"), schema);
  writeJson(path.join(claimBrainDir, "jobnimbus-relationship-map.json"), relationshipMap);
  writeText(path.join(reportsDir, "jobnimbus-local-brain-audit.md"), buildMarkdown(audit, storageSpec));

  console.log("JobNimbus local brain audit complete:");
  console.log(`- ${path.join(reportsDir, "jobnimbus-local-brain-audit.md")}`);
  console.log(`- ${path.join(claimBrainDir, "jobnimbus-local-storage-spec.json")}`);
  console.log(`- ${path.join(claimBrainDir, "claim-file-schema-v2.json")}`);
  console.log(`- ${path.join(claimBrainDir, "jobnimbus-relationship-map.json")}`);
}

function buildAudit(raw) {
  const settings = raw.accountSettings[0] || {};
  const contacts = raw.contacts;
  const users = unwrapUsers(raw.accountUsers);
  const customFields = settings.custom_fields_contact || [];
  const workflow = (settings.workflows || []).find((item) => item.object_type === "contact" && item.name === "Insurance") || {};
  const contactIds = new Set(contacts.map((contact) => contact.jnid).filter(Boolean));
  const userById = new Map(users.map((user) => [user.id, user]));

  return {
    generatedAt: new Date().toISOString(),
    syncMeta: raw.syncMeta,
    entityCounts: {
      contacts: contacts.length,
      tasks: raw.tasks.length,
      activities: raw.activities.length,
      documents: raw.documents.length,
      payments: raw.payments.length,
      users: users.length,
      contactCustomFields: customFields.length,
      contactWorkflowStatuses: workflow.status?.length || 0
    },
    endpointCompleteness: endpointCompleteness(raw.syncMeta),
    contactStatusCounts: countBy(contacts, "status_name"),
    recordTypeCounts: countBy(contacts, "record_type_name"),
    customFieldMap: customFields.map((field) => ({
      storageField: field.field,
      title: field.title,
      type: field.type,
      searchable: Boolean(field.is_searchable),
      options: field.options || []
    })),
    workflowStatuses: (workflow.status || []).map((status) => ({
      id: status.id,
      name: status.name,
      stage: status.stage,
      order: status.order,
      active: Boolean(status.is_active),
      archived: Boolean(status.is_archived)
    })),
    relationshipAudit: {
      tasks: relationStats(raw.tasks, contactIds),
      activities: relationStats(raw.activities, contactIds),
      documents: relationStats(raw.documents, contactIds),
      payments: relationStats(raw.payments, contactIds)
    },
    userOwnership: ownerStats(contacts, userById),
    activityTypeCounts: countBy(raw.activities, "record_type_name"),
    documentTypeCounts: countBy(raw.documents, "record_type_name"),
    documentContentTypeCounts: countBy(raw.documents, "content_type"),
    taskTypeDefinitions: settings.taskTypes || [],
    fileTypeDefinitions: settings.fileTypes || [],
    findings: [
      {
        severity: "high",
        finding: "Contacts are the operational claim files.",
        implication: "The local ledger root must be contact/contact jnid, not JobNimbus jobs, because jobs.json is empty while Insurance contacts hold claim status and fields."
      },
      {
        severity: "high",
        finding: "Bulk sync completeness must be read from data/raw/sync-meta.json.",
        implication: "The ledger must refuse to treat activities, documents, or other large endpoints as complete unless sync metadata says the endpoint fetched all visible rows."
      },
      {
        severity: "high",
        finding: "The raw customer field is not a safe relationship key.",
        implication: "Use related.id and primary.id first. Treat customer as tenant/account context unless verified per endpoint. Joining on customer globally can attach unrelated records to every file."
      },
      {
        severity: "high",
        finding: "Field values alone are not enough to determine next action.",
        implication: "Recent notes, activity, document metadata, prior failed attempts, and local preserved decisions must override simple field rules."
      },
      {
        severity: "medium",
        finding: "Custom field titles and backing field names are both needed.",
        implication: "Local storage must keep human labels like Claim # and API fields like cf_string_2 so writes and audits do not drift."
      }
    ]
  };
}

function buildStorageSpec(audit) {
  return {
    schemaVersion: 2,
    purpose: "Persistent local operating memory for HCN/Wave JobNimbus claim files.",
    rootDirectory: "work/claim-brain",
    sourceOfTruthRule: "Live JobNimbus remains authoritative for current fields; local ledger preserves verified interpretation, blockers, evidence summaries, and action history.",
    refreshPolicy: {
      fullSync: "Run before broad reviews when time allows; record sync caps and freshness.",
      targetedRefresh: "Required before any JobNimbus write, carrier email, Quo text, or claim-filing handoff.",
      afterAction: "Append action log and refresh the affected file if possible."
    },
    files: {
      "claim-ledger.json": "Generated current ledger view for active scoped files.",
      "files/{contact_jnid}.json": "Future canonical per-file persistent state to prevent one huge ledger from becoming brittle.",
      "evidence/{contact_jnid}.jsonl": "Future append-only evidence summaries from JobNimbus, Gmail, Quo, docs, calls, and storm data.",
      "actions/action-log.jsonl": "Future append-only approval/execution log with exact payloads and results.",
      "indexes/*.json": "Future lookup indexes by number, claim, policy, phone, email, owner, status, and phase.",
      "documents/{contact_jnid}/metadata.json": "Future document index, OCR/text extraction status, downloaded file paths, and classification.",
      "storm/storm-events-cache.json": "Future normalized DFW hail/wind event cache."
    },
    shouldPersist: [
      "contact identity, JobNimbus number, jnid, owner ids, status id/name/order/stage",
      "critical claim facts with evidence: carrier, policy, claim number, DOL, loss type, deductible, adjuster, address, phones, email",
      "operational phase and blocker state",
      "workflow gate checklist results and evidence references",
      "recent activity summaries and key historical notes, not every raw note forever",
      "document index and extracted text/OCR status for policy, estimate, LOR, PA contract, carrier docs, photos",
      "external communication summaries from Gmail and Quo with source ids, timestamps, and match confidence",
      "storm research candidates with distance, hail size, source, and confidence",
      "approval queue items and action outcomes",
      "do-not-do rules and user-specific instructions learned during work"
    ],
    shouldNotPersistAsPrimary: [
      "API keys or bearer tokens",
      "raw full email/text bodies unless needed and explicitly approved",
      "bulk uncapped duplicate raw JobNimbus history inside each file",
      "inferred facts without source/evidence/confidence",
      "transient reports as source of truth"
    ],
    relationshipRules: [
      "Contact jnid is the root claim-file key.",
      "related.id and primary.id are high-confidence links.",
      "owner ids map to accountUsers.",
      "status ids map to accountSettings.workflows contact Insurance statuses.",
      "custom fields map via accountSettings.custom_fields_contact.",
      "document download/text extraction is on demand and linked by document jnid.",
      "Gmail/Quo join must use match confidence across name, phone, email, address, claim, and policy.",
      "Storm events join by geocoded address and distance, not client name."
    ]
  };
}

function buildRelationshipMap(audit) {
  return {
    schemaVersion: 1,
    rootEntity: "JobNimbus contact where record_type_name is Insurance",
    reliableKeys: [
      { key: "contact.jnid", use: "canonical local file id" },
      { key: "contact.number", use: "human JobNimbus file number/search" },
      { key: "activity.primary.id", use: "high-confidence activity relation" },
      { key: "activity.related[].id", use: "high-confidence activity relation" },
      { key: "task.related[].id", use: "high-confidence task relation" },
      { key: "document.primary.id", use: "high-confidence document relation" },
      { key: "payment.related[].id", use: "high-confidence payment relation" },
      { key: "contact.owners[].id", use: "owner/user relation" },
      { key: "contact.status", use: "workflow status id relation" }
    ],
    unsafeOrConditionalKeys: [
      {
        key: "record.customer",
        reason: "In sampled data this can behave like shared account/customer context, not a unique file id. Do not globally join on it."
      }
    ],
    currentRelationshipStats: audit.relationshipAudit
  };
}

function buildSchema() {
  return {
    schemaVersion: 2,
    type: "ClaimFile",
    requiredTopLevel: ["identity", "observed", "interpretation", "evidence", "actions", "preserved"],
    identity: {
      contactJnid: "string",
      jobNimbusNumber: "string",
      displayName: "string",
      ownerIds: ["string"],
      ownerNames: ["string"],
      scopeTags: ["Chance Pearson", "company-wide"]
    },
    observed: {
      source: "JobNimbus live/local sync",
      freshness: { syncedAt: "ISO timestamp", completeness: "complete|partial|targeted" },
      status: { id: "number|string", name: "string", stage: "string", order: "number" },
      contact: { address: "string", phone: "string", email: "string" },
      claimFacts: {
        carrier: "fact",
        policyNumber: "fact",
        claimNumber: "fact",
        dateOfLoss: "fact",
        typeOfLoss: "fact",
        deductible: "fact",
        adjuster: "fact"
      },
      relatedCounts: { tasks: "number", activities: "number", documents: "number", payments: "number" }
    },
    interpretation: {
      operationalPhase: "enum",
      blockers: ["enum"],
      checklist: "workflow gate map",
      nextAction: "string",
      approvalNeeded: "boolean",
      confidence: "field_only_low|medium_from_file_activity|high_blocker|verified"
    },
    evidence: [
      {
        id: "local evidence id",
        source: "jobnimbus_activity|jobnimbus_document|gmail|quo|storm|manual",
        sourceId: "string",
        timestamp: "ISO/string",
        summary: "string",
        factTypes: ["policy", "claim", "appraisal", "appointment", "payment"],
        confidence: "low|medium|high|verified"
      }
    ],
    actions: [
      {
        id: "string",
        status: "proposed|approved|executed|failed|cancelled",
        channel: "jobnimbus|gmail|quo|mitra|manual",
        payload: "object",
        approvedBy: "string",
        executedAt: "ISO timestamp",
        result: "object"
      }
    ],
    preserved: {
      humanNotes: "string",
      userInstructions: ["string"],
      doNotDo: ["string"],
      verifiedOverrides: "object",
      completedChecks: "object"
    },
    factObjectShape: {
      value: "any",
      source: "string",
      sourceId: "string",
      observedAt: "ISO timestamp",
      confidence: "low|medium|high|verified",
      stale: "boolean"
    }
  };
}

function buildMarkdown(audit, storageSpec) {
  const lines = [];
  lines.push("# JobNimbus Local Brain Audit");
  lines.push("");
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push("");
  lines.push("## Executive Read");
  lines.push("");
  lines.push("The local system should not be a spreadsheet-shaped dump of JobNimbus. It should be a persistent operating ledger: live JobNimbus fields plus locally preserved interpretation, blockers, evidence, approvals, and action history.");
  lines.push("");
  lines.push("The root object is a JobNimbus **Insurance contact**, because this account currently has no job records in `jobs.json`; the client files are represented as contacts with workflow statuses and custom claim fields.");
  lines.push("");
  lines.push("## Entity Counts");
  lines.push("");
  for (const [key, value] of Object.entries(audit.entityCounts)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Sync Completeness");
  lines.push("");
  lines.push(`- Last sync: ${audit.syncMeta.syncedAt || "unknown"}`);
  for (const [key, value] of Object.entries(audit.endpointCompleteness)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Critical Findings");
  lines.push("");
  for (const finding of audit.findings) {
    lines.push(`- **${finding.severity.toUpperCase()}**: ${finding.finding} ${finding.implication}`);
  }
  lines.push("");
  lines.push("## What Must Be Saved Locally");
  lines.push("");
  for (const item of storageSpec.shouldPersist) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## What Should Not Be Trusted As Primary Memory");
  lines.push("");
  for (const item of storageSpec.shouldNotPersistAsPrimary) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Relationship Rules");
  lines.push("");
  for (const item of storageSpec.relationshipRules) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Workflow/Status Model");
  lines.push("");
  lines.push("The local brain must store both JobNimbus status and operational phase. Status alone is not enough. Example: `Ready for PA Review` may mean ready to file, policy lookup failed, stale claim already filed, or appraisal/follow-up depending on recent notes and documents.");
  lines.push("");
  lines.push("| Status | Stage | Active | Archived |");
  lines.push("| --- | --- | --- | --- |");
  for (const status of audit.workflowStatuses.filter((status) => status.active)) {
    lines.push(`| ${status.name} | ${status.stage} | ${status.active} | ${status.archived} |`);
  }
  lines.push("");
  lines.push("## Custom Field Map");
  lines.push("");
  lines.push("| API field | Title | Type | Searchable |");
  lines.push("| --- | --- | --- | --- |");
  for (const field of audit.customFieldMap) {
    lines.push(`| ${field.storageField} | ${field.title} | ${field.type} | ${field.searchable} |`);
  }
  lines.push("");
  lines.push("## Recommended Local Architecture");
  lines.push("");
  lines.push("1. Keep `data/raw` as the latest API cache, with sync completeness metadata.");
  lines.push("2. Keep `work/claim-brain/claim-ledger.json` as a generated current view.");
  lines.push("3. Add canonical per-file JSON at `work/claim-brain/files/{contact_jnid}.json` for durable local memory.");
  lines.push("4. Add append-only evidence logs and action logs so we can explain why the assistant decided something.");
  lines.push("5. Export spreadsheets only as a human review view, not as the system source of truth.");
  lines.push("");
  lines.push("## Immediate Implementation Priorities");
  lines.push("");
  lines.push("- Add per-file persistent JSON files with schema version 2.");
  lines.push("- Add source/evidence references to every blocker and checklist gate.");
  lines.push("- Add sync completeness/freshness to every ledger entry.");
  lines.push("- Add targeted per-file refresh before generating approval/action lists.");
  lines.push("- Add document text/OCR cache fields for policy, estimate, LOR, PA contract, and carrier docs.");
  lines.push("- Add Gmail/Quo evidence summaries with match confidence once connectors are available in this chat.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function endpointCompleteness(syncMeta) {
  const resources = syncMeta?.resources || {};
  if (!Object.keys(resources).length) {
    return {
      contacts: "unknown_no_sync_meta",
      tasks: "unknown_no_sync_meta",
      activities: "unknown_no_sync_meta",
      documents: "unknown_no_sync_meta",
      payments: "unknown_no_sync_meta"
    };
  }

  return Object.fromEntries(Object.entries(resources).map(([name, resource]) => {
    const total = resource.total === undefined ? "unknown total" : `${resource.fetched}/${resource.total}`;
    const state = resource.complete ? "complete" : "partial";
    return [name, `${state} (${total}; ${resource.stoppedReason || "unknown stop"})`];
  }));
}

function relationStats(rows, contactIds) {
  const stats = { rows: rows.length, primaryIdMatches: 0, relatedIdMatches: 0, unresolved: 0 };
  for (const row of rows) {
    const primaryMatch = row.primary?.id && contactIds.has(String(row.primary.id));
    const relatedMatch = Array.isArray(row.related) && row.related.some((related) => contactIds.has(String(related.id)));
    if (primaryMatch) stats.primaryIdMatches += 1;
    if (relatedMatch) stats.relatedIdMatches += 1;
    if (!primaryMatch && !relatedMatch) stats.unresolved += 1;
  }
  return stats;
}

function ownerStats(contacts, userById) {
  const counts = new Map();
  for (const contact of contacts) {
    for (const owner of contact.owners || []) {
      counts.set(owner.id, (counts.get(owner.id) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([id, count]) => ({
      id,
      count,
      name: userById.has(id) ? `${userById.get(id).first_name} ${userById.get(id).last_name}` : ""
    }));
}

function countBy(rows, key) {
  return Object.fromEntries([...rows.reduce((map, row) => {
    const value = String(row[key] || "Unknown");
    map.set(value, (map.get(value) || 0) + 1);
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1]));
}

function unwrapUsers(payload) {
  if (Array.isArray(payload?.users)) return payload.users;
  if (Array.isArray(payload?.[0]?.users)) return payload[0].users;
  if (Array.isArray(payload)) return payload;
  return [];
}

function readOptionalJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}
