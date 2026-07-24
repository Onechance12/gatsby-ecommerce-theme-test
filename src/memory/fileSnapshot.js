// Private read-through evidence cache for one JobNimbus file.
//
// This is continuity, not authority: snapshots preserve the last assembled
// client picture between sessions, but live JobNimbus/Gmail/Quo evidence wins
// and the snapshot never authorizes a write, send, or call.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { memoryPaths } from "./store.js";

const SNAPSHOT_VERSION = 1;
const MAX_ACTIVITIES = 30;
const MAX_TASKS = 30;
const MAX_DOCUMENTS = 60;
const MAX_RECEIPTS = 50;
const MAX_GMAIL_MESSAGES = 12;
const MAX_GMAIL_THREADS = 5;
const MAX_QUO_TIMELINE = 30;
const MAX_QUO_TRANSCRIPTS = 8;

export function fileSnapshotPath(config, subjectKey) {
  const key = requiredSubjectKey(subjectKey);
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(path.dirname(memoryPaths(config).client), "files", `${digest}.json`);
}

export function readFileSnapshot(config, subjectKey) {
  const file = fileSnapshotPath(config, subjectKey);
  if (!fs.existsSync(file)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!snapshot || snapshot.subjectKey !== String(subjectKey)) {
      throw new Error("snapshot subject does not match its lookup key");
    }
    return snapshot;
  } catch (error) {
    // Snapshots are a rebuildable cache, not source-of-truth records. Preserve
    // the damaged bytes for inspection, then let the next live review rebuild
    // clean continuity instead of taking the operational bridge offline.
    const quarantined = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, quarantined); } catch { /* leave the original in place if quarantine fails */ }
    console.error(`WARN: quarantined unreadable client snapshot ${file}: ${error.message}`);
    return null;
  }
}

export function refreshFileSnapshot(config, evidence = {}) {
  const subjectKey = requiredSubjectKey(evidence.subjectKey || evidence.file?.id);
  const previous = readFileSnapshot(config, subjectKey);
  const now = new Date().toISOString();
  const file = compactFileFacts(evidence.file || previous?.file || {});
  const liveJobNimbus = evidence.liveJobNimbus || evidence.jobNimbus || {};
  const incomingReceipts = Array.isArray(evidence.actionReceipts) ? evidence.actionReceipts : [];
  const actionReceipts = mergeReceipts(previous?.actionReceipts || [], incomingReceipts);
  const changes = compareFileFacts(previous?.file || {}, file);

  const snapshot = {
    version: SNAPSHOT_VERSION,
    subjectKey,
    refreshedAt: now,
    previousRefreshedAt: previous?.refreshedAt || "",
    refreshCount: Number(previous?.refreshCount || 0) + 1,
    file,
    sourceStatus: compactSourceStatus(evidence.sourceStatus || {}, previous?.sourceStatus || {}, now),
    jobNimbus: {
      recentActivities: compactList(liveJobNimbus.recentActivities, MAX_ACTIVITIES, compactActivity),
      openTasks: compactList(liveJobNimbus.openTasks, MAX_TASKS, compactTask),
      operationalDocuments: compactList(liveJobNimbus.operationalDocuments || liveJobNimbus.documents, MAX_DOCUMENTS, compactDocument),
      excludedPhotoLikeDocumentCount: finiteNumber(liveJobNimbus.excludedPhotoLikeDocumentCount, previous?.jobNimbus?.excludedPhotoLikeDocumentCount || 0),
      assistantRead: jsonClone(liveJobNimbus.assistantRead || previous?.jobNimbus?.assistantRead || {})
    },
    communications: {
      gmail: mergeCommunication(previous?.communications?.gmail, evidence.gmail, evidence.sourceStatus?.gmail, now, compactGmailEvidence),
      quo: mergeCommunication(previous?.communications?.quo, evidence.quo, evidence.sourceStatus?.quo, now, compactQuoEvidence)
    },
    factualSignals: jsonClone(evidence.factualSignals || previous?.factualSignals || {}),
    actionReceipts,
    continuity: {
      changesSincePrevious: changes,
      openFollowUps: collectOpenFollowUps(actionReceipts, liveJobNimbus.openTasks),
      lastActionAt: actionReceipts[0]?.at || previous?.continuity?.lastActionAt || ""
    },
    authority: snapshotAuthority()
  };

  writeSnapshot(fileSnapshotPath(config, subjectKey), snapshot);
  return snapshot;
}

export function appendActionReceiptToFileSnapshot(config, receipt = {}) {
  const subjectKey = String(receipt.subjectKey || "").trim();
  if (!subjectKey) return { updated: false, reason: "receipt_has_no_subject_key" };
  const previous = readFileSnapshot(config, subjectKey);
  const now = new Date().toISOString();
  const actionReceipts = mergeReceipts(previous?.actionReceipts || [], [receipt]);
  const snapshot = previous || {
    version: SNAPSHOT_VERSION,
    subjectKey,
    refreshedAt: "",
    previousRefreshedAt: "",
    refreshCount: 0,
    file: { id: subjectKey },
    sourceStatus: {},
    jobNimbus: { recentActivities: [], openTasks: [], operationalDocuments: [], excludedPhotoLikeDocumentCount: 0, assistantRead: {} },
    communications: {
      gmail: emptyCommunication("never_reviewed"),
      quo: emptyCommunication("never_reviewed")
    },
    factualSignals: {},
    actionReceipts: [],
    continuity: { changesSincePrevious: [], openFollowUps: [], lastActionAt: "" },
    authority: snapshotAuthority()
  };
  snapshot.updatedAt = now;
  snapshot.actionReceipts = actionReceipts;
  snapshot.continuity = {
    ...(snapshot.continuity || {}),
    openFollowUps: collectOpenFollowUps(actionReceipts, snapshot.jobNimbus?.openTasks),
    lastActionAt: actionReceipts[0]?.at || snapshot.continuity?.lastActionAt || ""
  };
  snapshot.authority = snapshotAuthority();
  writeSnapshot(fileSnapshotPath(config, subjectKey), snapshot);
  return { updated: true, snapshot };
}

export function summarizeFileSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    subjectKey: snapshot.subjectKey,
    refreshedAt: snapshot.refreshedAt || "",
    updatedAt: snapshot.updatedAt || snapshot.refreshedAt || "",
    refreshCount: snapshot.refreshCount || 0,
    file: snapshot.file || {},
    sourceStatus: snapshot.sourceStatus || {},
    jobNimbus: {
      recentActivities: (snapshot.jobNimbus?.recentActivities || []).slice(0, 5),
      openTasks: (snapshot.jobNimbus?.openTasks || []).slice(0, 12),
      operationalDocuments: (snapshot.jobNimbus?.operationalDocuments || []).slice(0, 20),
      excludedPhotoLikeDocumentCount: snapshot.jobNimbus?.excludedPhotoLikeDocumentCount || 0,
      assistantRead: snapshot.jobNimbus?.assistantRead || {}
    },
    communications: {
      gmail: summarizeCommunication(snapshot.communications?.gmail, "gmail"),
      quo: summarizeCommunication(snapshot.communications?.quo, "quo")
    },
    factualSignals: snapshot.factualSignals || {},
    recentActionReceipts: (snapshot.actionReceipts || []).slice(0, 10),
    continuity: snapshot.continuity || {},
    authority: snapshotAuthority()
  };
}

export function renderFileSnapshotSummary(snapshot) {
  const summary = summarizeFileSnapshot(snapshot);
  if (!summary) return "";
  const file = summary.file;
  const lines = [
    "CURRENT CLIENT SNAPSHOT (private read-through evidence cache; never approval):",
    `- refreshed: ${summary.refreshedAt || "not yet fully reviewed"}; review count: ${summary.refreshCount}`,
    `- file: ${[file.number ? `#${file.number}` : "", file.name, file.status].filter(Boolean).join(" | ") || summary.subjectKey}`
  ];
  const facts = [
    file.carrier && `carrier=${file.carrier}`,
    file.policyNumber && `policy=${file.policyNumber}`,
    file.claimNumber && `claim=${file.claimNumber}`,
    file.dateOfLoss && `DOL=${file.dateOfLoss}`,
    file.adjusterName && `adjuster=${file.adjusterName}`
  ].filter(Boolean);
  if (facts.length) lines.push(`- facts: ${facts.join("; ")}`);
  lines.push(`- source freshness: ${renderSourceStatus(summary.sourceStatus)}`);
  lines.push(`- JobNimbus: ${summary.jobNimbus.openTasks.length} open task(s), ${summary.jobNimbus.operationalDocuments.length} retained operational document(s), ${summary.jobNimbus.excludedPhotoLikeDocumentCount} photo-like file(s) excluded`);
  if (summary.continuity.changesSincePrevious?.length) {
    lines.push(`- changes since prior review: ${summary.continuity.changesSincePrevious.map((item) => `${item.field}: ${display(item.from)} -> ${display(item.to)}`).join("; ")}`);
  }
  if (summary.continuity.openFollowUps?.length) {
    lines.push(`- continuity follow-ups: ${summary.continuity.openFollowUps.slice(0, 8).join("; ")}`);
  }
  const latestActivity = summary.jobNimbus.recentActivities[0];
  if (latestActivity) lines.push(`- latest JobNimbus activity: ${latestActivity.dateCreated || "undated"} ${latestActivity.type || ""} ${String(latestActivity.note || "").slice(0, 240)}`.trim());
  const gmail = summary.communications.gmail;
  if (gmail.latestItems?.length) lines.push(`- last-known Gmail: ${gmail.latestItems.map((item) => [item.date, item.from, item.subject].filter(Boolean).join(" | ")).join("; ")}`);
  const quo = summary.communications.quo;
  if (quo.latestItems?.length) lines.push(`- last-known Quo: ${quo.latestItems.map((item) => [item.at || item.createdAt, item.direction, String(item.text || item.content || "").slice(0, 120)].filter(Boolean).join(" | ")).join("; ")}`);
  lines.push("- authority: use this for continuity only; fresh source evidence wins and explicit approval is still required for every action.");
  return lines.join("\n");
}

function compactFileFacts(file) {
  const fields = [
    "id", "number", "name", "status", "statusId", "address", "phone", "email",
    "carrier", "claimNumber", "policyNumber", "typeOfLoss", "dateOfLoss",
    "deductible", "adjusterName", "adjusterPhone", "adjusterEmail"
  ];
  return Object.fromEntries(fields.map((key) => [key, primitive(file?.[key])]).filter(([, value]) => value !== ""));
}

function compactActivity(value) {
  return cleanObject({
    id: primitive(value?.id || value?.jnid),
    dateCreated: primitive(value?.dateCreated || value?.date_created),
    type: primitive(value?.type || value?.record_type_name),
    note: text(value?.note || value?.description, 1600)
  });
}

function compactTask(value) {
  return cleanObject({
    id: primitive(value?.id || value?.jnid),
    title: text(value?.title || value?.subject, 500),
    description: text(value?.description || value?.note, 1200),
    createdAt: primitive(value?.createdAt || value?.dateCreated || value?.date_created),
    dateStart: primitive(value?.dateStart || value?.date_start),
    dateEnd: primitive(value?.dateEnd || value?.date_end),
    dueDate: primitive(value?.dueDate || value?.dateStart || value?.date_start || value?.dateEnd || value?.date_end),
    completed: Boolean(value?.completed || value?.is_completed)
  });
}

function compactDocument(value) {
  return cleanObject({
    id: primitive(value?.id || value?.jnid),
    name: text(value?.name || value?.filename || value?.file_name, 500),
    type: primitive(value?.type || value?.record_type_name)
  });
}

function compactGmailEvidence(value = {}) {
  return {
    query: text(value.query, 1500),
    messages: compactList(value.messages, MAX_GMAIL_MESSAGES, (message) => cleanObject({
      id: primitive(message?.id),
      threadId: primitive(message?.threadId),
      date: primitive(message?.date),
      from: text(message?.from, 500),
      to: text(message?.to, 500),
      subject: text(message?.subject, 500),
      snippet: text(message?.snippet || message?.text, 1200)
    })),
    threads: compactList(value.threads, MAX_GMAIL_THREADS, (thread) => ({
      id: primitive(thread?.id),
      messageCount: finiteNumber(thread?.messageCount, 0),
      messages: compactList(thread?.messages, 5, (message) => cleanObject({
        id: primitive(message?.id),
        date: primitive(message?.date),
        from: text(message?.from, 500),
        to: text(message?.to, 500),
        subject: text(message?.subject, 500),
        text: text(message?.text || message?.plainText || message?.snippet, 1800),
        attachments: compactList(message?.attachments, 12, (attachment) => cleanObject({
          id: primitive(attachment?.attachmentId || attachment?.id),
          filename: text(attachment?.filename, 500),
          contentType: primitive(attachment?.mimeType || attachment?.contentType)
        }))
      }))
    }))
  };
}

function compactQuoEvidence(value = {}) {
  return {
    phone: primitive(value.phone),
    timeline: compactList(value.timeline, MAX_QUO_TIMELINE, (item) => cleanObject({
      id: primitive(item?.id || item?.activityId || item?.callId || item?.messageId),
      at: primitive(item?.at || item?.createdAt || item?.created_at),
      atUtc: primitive(item?.atUtc),
      direction: primitive(item?.direction),
      type: primitive(item?.type || item?.kind),
      status: primitive(item?.status),
      line: text(item?.line, 240),
      from: primitive(item?.from),
      to: jsonClone(item?.to || ""),
      text: text(item?.text || item?.content || item?.transcript || item?.summary, 1800),
      durationSec: finiteNumber(item?.durationSec || item?.duration, 0),
      aiHandled: Boolean(item?.aiHandled)
    })),
    transcripts: compactList(value.transcripts, MAX_QUO_TRANSCRIPTS, (item) => cleanObject({
      id: primitive(item?.id || item?.callId),
      at: primitive(item?.at || item?.createdAt),
      status: primitive(item?.status),
      duration: finiteNumber(item?.duration, 0),
      text: text(item?.text || item?.transcript || item?.summary, 4000),
      dialogue: compactList(item?.dialogue, 80, (segment) => cleanObject({
        who: text(segment?.who || segment?.identifier, 240),
        at: finiteNumber(segment?.at || segment?.start, 0),
        text: text(segment?.text || segment?.content, 1200)
      }))
    }))
  };
}

function mergeCommunication(previous, incoming, source, now, compactor) {
  const status = String(incoming?.status || source?.status || "not_requested");
  const fresh = status === "fresh";
  const prior = previous || emptyCommunication("never_reviewed");
  return {
    status,
    lastAttemptAt: source?.at || now,
    lastSuccessfulAt: fresh ? (source?.at || now) : (prior.lastSuccessfulAt || ""),
    error: text(incoming?.error, 1000),
    retainedFromPriorSuccessfulReview: !fresh && Boolean(prior.evidence),
    evidence: fresh ? compactor(incoming) : (prior.evidence || null)
  };
}

function summarizeCommunication(value, type) {
  const base = value || emptyCommunication("never_reviewed");
  const evidence = base.evidence || {};
  const latestItems = type === "gmail"
    ? (evidence.messages || evidence.threads?.flatMap((thread) => thread.messages || []) || []).slice(0, 3)
    : (evidence.timeline || []).slice(0, 3);
  return {
    status: base.status,
    lastAttemptAt: base.lastAttemptAt || "",
    lastSuccessfulAt: base.lastSuccessfulAt || "",
    retainedFromPriorSuccessfulReview: Boolean(base.retainedFromPriorSuccessfulReview),
    error: base.error || "",
    itemCount: type === "gmail"
      ? (evidence.messages?.length || evidence.threads?.reduce((count, thread) => count + (thread.messages?.length || 0), 0) || 0)
      : (evidence.timeline?.length || 0),
    latestItems
  };
}

function compactSourceStatus(incoming, previous, now) {
  const names = new Set([...Object.keys(previous || {}), ...Object.keys(incoming || {}), "jobNimbus", "gmail", "quo"]);
  return Object.fromEntries([...names].map((name) => {
    const current = incoming?.[name];
    const prior = previous?.[name] || {};
    return [name, {
      status: String(current?.status || (name === "jobNimbus" ? "fresh" : "not_requested")),
      at: current?.at || now,
      lastSuccessfulAt: current?.status === "fresh" ? (current?.at || now) : (prior.lastSuccessfulAt || (prior.status === "fresh" ? prior.at : ""))
    }];
  }));
}

function compareFileFacts(previous, next) {
  if (!previous || !Object.keys(previous).length) return [];
  const ignored = new Set(["id"]);
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((field) => !ignored.has(field) && String(previous[field] ?? "") !== String(next[field] ?? ""))
    .map((field) => ({ field, from: previous[field] ?? "", to: next[field] ?? "" }))
    .slice(0, 20);
}

function mergeReceipts(previous, incoming) {
  const byKey = new Map();
  for (const receipt of [...previous, ...incoming]) {
    if (!receipt || typeof receipt !== "object") continue;
    const compact = cleanObject({
      id: primitive(receipt.id),
      at: primitive(receipt.at),
      channel: primitive(receipt.channel),
      action: primitive(receipt.action),
      status: primitive(receipt.status),
      subjectKey: primitive(receipt.subjectKey),
      fileLabel: text(receipt.fileLabel, 240),
      summary: text(receipt.summary, 1600),
      externalId: text(receipt.externalId, 300),
      dedupKey: text(receipt.dedupKey, 500),
      followUps: compactList(receipt.followUps, 12, (item) => text(item, 500)),
      evidence: compactList(receipt.evidence, 12, (item) => text(item, 500))
    });
    const key = compact.id || compact.dedupKey || `${compact.channel}:${compact.action}:${compact.externalId}:${compact.at}`;
    byKey.set(key, compact);
  }
  return [...byKey.values()]
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, MAX_RECEIPTS);
}

function collectOpenFollowUps(receipts, tasks) {
  const values = [
    ...receipts.flatMap((receipt) => receipt.followUps || []),
    ...compactList(tasks, MAX_TASKS, compactTask).filter((task) => !task.completed).map((task) => task.title)
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return [...new Set(values)].slice(0, 20);
}

function writeSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function snapshotAuthority() {
  return {
    kind: "live_evidence_cache",
    liveSourcesWin: true,
    doesNotAuthorizeActions: true,
    explicitApprovalStillRequired: true
  };
}

function emptyCommunication(status) {
  return { status, lastAttemptAt: "", lastSuccessfulAt: "", error: "", retainedFromPriorSuccessfulReview: false, evidence: null };
}

function compactList(value, max, mapper) {
  return (Array.isArray(value) ? value : []).slice(0, max).map(mapper).filter((item) => item !== "" && item !== null && item !== undefined);
}

function primitive(value) {
  if (value === undefined || value === null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  return String(value);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback || 0);
}

function text(value, max) {
  return String(value || "").trim().slice(0, max);
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

function requiredSubjectKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("client snapshot requires subjectKey");
  return key;
}

function renderSourceStatus(sourceStatus) {
  return Object.entries(sourceStatus || {})
    .map(([name, value]) => `${name}=${value?.status || "unknown"}${value?.lastSuccessfulAt ? ` (last fresh ${value.lastSuccessfulAt})` : ""}`)
    .join(", ") || "unknown";
}

function display(value) {
  return value === "" || value === undefined || value === null ? "missing" : String(value);
}
