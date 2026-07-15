// Gmail read + draft layer, ported from the jobnimbus-bridge branch.
// Reads are open; creating a draft requires execute:true (dry-run default);
// SENDING requires ALLOW_GMAIL_SEND=true AND execute:true. Drafts-first is the
// standing posture — Chance hits send.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { googleApi } from "./googleAuth.js";
import { safeCloseoutAction } from "../memory/actionCloseout.js";
import { isOperationalDocument } from "../jobnimbus/documentFilters.js";

const GMAIL = "https://gmail.googleapis.com";

export async function runGmailTool(config, args) {
  const [tool, ...rest] = args;
  const input = parseInput(rest.join(" "));

  if (!tool || tool === "list") {
    printJson({
      tools: [
        { name: "search", input: { query: "gmail query string", limit: "number optional" }, note: "e.g. 'from:claims@claims.allstate.com newer_than:30d'" },
        { name: "thread", input: { threadId: "string", downloadAttachments: "boolean optional", includeNonDocuments: "boolean optional", subjectKey: "JobNimbus id optional", fileLabel: "client name optional" }, note: "full thread with assistant read; optionally downloads and validates operational documents (photos/logos skipped by default)" },
        { name: "attachment", input: { messageId: "string", attachmentId: "string", filename: "string", contentType: "string optional", subjectKey: "JobNimbus id optional", fileLabel: "client name optional" }, note: "download one Gmail attachment into the controlled work directory and validate its bytes" },
        { name: "delivery", input: { subject: "exact claim-number subject", days: "number optional, default 30" }, note: "check for bounce messages or inbound acknowledgement candidates; no bounce is not proof of receipt" },
        { name: "draft", input: { to: "", subject: "", body: "", cc: "optional", threadId: "optional", execute: "true to create" }, note: "dry-run unless execute:true. LOR rule: subject = claim number only." },
        { name: "send", input: { "...same as draft": "" }, note: "blocked unless ALLOW_GMAIL_SEND=true AND execute:true" }
      ]
    });
    return;
  }

  if (tool === "search") {
    const query = required(input.query || input._, "query");
    const limit = clamp(Number(input.limit || 10), 1, 25);
    const list = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
    const rows = Array.isArray(list.messages) ? list.messages : [];
    const messages = [];
    for (const row of rows) {
      const message = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
      messages.push(compactMessage(message));
    }
    printJson({ query, count: messages.length, messages, threads: groupByThread(messages) });
    return;
  }

  if (tool === "thread") {
    const threadId = required(input.threadId || input._, "threadId");
    const thread = await googleApi(config, GMAIL, `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
    const messages = Array.isArray(thread.messages) ? thread.messages.map(compactFullMessage) : [];
    const downloadedAttachments = input.downloadAttachments === true
      ? await downloadThreadAttachments(config, thread, input)
      : [];
    printJson({ id: thread.id || threadId, messageCount: messages.length, messages, assistantRead: assistantRead(messages), downloadedAttachments });
    return;
  }

  if (tool === "attachment") {
    const downloaded = await downloadGmailAttachment(config, {
      messageId: required(input.messageId, "messageId"),
      attachmentId: required(input.attachmentId, "attachmentId"),
      filename: required(input.filename, "filename"),
      contentType: input.contentType || "application/octet-stream",
      subjectKey: input.subjectKey,
      fileLabel: input.fileLabel
    });
    printJson({ mode: "downloaded", attachment: downloaded });
    return;
  }

  if (tool === "delivery") {
    const subject = required(input.subject || input._, "subject");
    const days = clamp(Number(input.days || 30), 1, 365);
    const safeSubject = subject.replace(/"/g, "");
    const query = `in:anywhere {subject:"${safeSubject}" "${safeSubject}"} newer_than:${days}d`;
    const messages = await searchMessageMetadata(config, query, 25);
    const bounces = messages.filter(isBounceMessage);
    const acknowledgements = messages.filter((message) =>
      (message.labels || []).includes("INBOX") && !isBounceMessage(message)
    );
    printJson({
      subject,
      query,
      status: bounces.length ? "bounced" : acknowledgements.length ? "acknowledgement_candidate" : "no_failure_found",
      warning: bounces.length ? "Delivery failed; correct the destination before resending."
        : acknowledgements.length ? "Review the inbound message body before treating carrier receipt as confirmed."
          : "No bounce was found, but this does not prove carrier receipt. Continue waiting for or requesting acknowledgement.",
      bounces,
      acknowledgements,
      messages
    });
    return;
  }

  if (tool === "draft" || tool === "send") {
    const to = required(input.to, "to");
    const subject = required(input.subject, "subject");
    const body = required(input.body, "body");
    const raw = buildRawEmail({ to, cc: input.cc, bcc: input.bcc, subject, body });
    const plan = { tool, to, cc: input.cc || "", subject, bodyPreview: String(body).slice(0, 400), threadId: input.threadId || "" };

    if (input.execute !== true) {
      printJson({ mode: "dry_run", plan, note: "Add execute:true to create." });
      return;
    }
    if (tool === "send") {
      if (!config.google.allowSend) {
        printJson({ mode: "blocked", plan, reason: "Sending is disabled. Set ALLOW_GMAIL_SEND=true to enable. Current posture: drafts only — Chance sends." });
        process.exitCode = 1;
        return;
      }
      const result = await googleApi(config, GMAIL, "/gmail/v1/users/me/messages/send", { method: "POST", body: cleanObject({ raw, threadId: input.threadId }) });
      const memoryCloseout = gmailCloseout(config, input, "send_email", result.id || "", `Gmail message sent with subject ${subject}.`);
      printJson({ mode: "executed", message: compactMessage(result), memoryCloseout });
      return;
    }
    const result = await googleApi(config, GMAIL, "/gmail/v1/users/me/drafts", { method: "POST", body: { message: cleanObject({ raw, threadId: input.threadId }) } });
    const memoryCloseout = gmailCloseout(config, input, "create_draft", result.id || "", `Gmail draft created with subject ${subject}.`, "drafted");
    printJson({ mode: "executed", draft: { id: result.id || "", message: result.message ? compactMessage(result.message) : null }, memoryCloseout });
    return;
  }

  throw new Error(`Unknown gmail tool: ${tool}. Run 'npm run gmail -- list'.`);
}

function compactMessage(message) {
  const headers = headerMap(message);
  return {
    id: message.id || "",
    threadId: message.threadId || "",
    date: headers.date || "",
    from: headers.from || "",
    to: headers.to || "",
    cc: headers.cc || "",
    subject: headers.subject || "",
    snippet: message.snippet || "",
    labels: Array.isArray(message.labelIds) ? message.labelIds : []
  };
}

async function searchMessageMetadata(config, query, limit) {
  const list = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
  const rows = Array.isArray(list.messages) ? list.messages : [];
  const messages = [];
  for (const row of rows) {
    const message = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
    messages.push(compactMessage(message));
  }
  return messages;
}

function isBounceMessage(message) {
  const text = `${message.from || ""} ${message.subject || ""} ${message.snippet || ""}`;
  return /mailer-daemon|mail delivery subsystem|postmaster|delivery status notification|address not found|wasn'?t delivered|user unknown|550\s+5\.[01]\.[01]/i.test(text);
}

function compactFullMessage(message) {
  return {
    ...compactMessage(message),
    plainText: extractBody(message.payload, "text/plain").slice(0, 12000),
    htmlText: stripHtml(extractBody(message.payload, "text/html")).slice(0, 6000),
    attachments: listAttachments(message.payload)
  };
}

function headerMap(message) {
  const out = {};
  for (const header of message?.payload?.headers || []) {
    const key = String(header.name || "").toLowerCase();
    if (["from", "to", "cc", "subject", "date"].includes(key)) out[key] = header.value || "";
  }
  return out;
}

function groupByThread(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!map.has(message.threadId)) {
      map.set(message.threadId, { threadId: message.threadId, subject: message.subject, from: message.from, date: message.date, latestSnippet: message.snippet, messageIds: [] });
    }
    map.get(message.threadId).messageIds.push(message.id);
  }
  return [...map.values()];
}

function assistantRead(messages) {
  const latest = messages[messages.length - 1] || {};
  const combined = messages.map((m) => `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n${m.plainText || m.htmlText || m.snippet}`).join("\n\n---\n\n");
  return {
    latestFrom: latest.from || "",
    latestDate: latest.date || "",
    latestSubject: latest.subject || "",
    possibleClaimNumbers: uniqueMatches(combined, /\b(?:claim(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*)?([A-Z0-9]{2,4}[- ]?[A-Z0-9]{3,6}[- ]?[A-Z0-9]{2,6})\b/gi, 1).slice(0, 10),
    emails: uniqueMatches(combined, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, 1).slice(0, 20),
    phones: uniqueMatches(combined, /(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g, 1).slice(0, 20),
    attachmentCount: messages.reduce((sum, m) => sum + (m.attachments?.length || 0), 0)
  };
}

function extractBody(part, mimeType) {
  if (!part) return "";
  const chunks = [];
  walkParts(part, (item) => {
    if (item.mimeType === mimeType && item.body?.data) chunks.push(base64UrlDecode(item.body.data));
  });
  return chunks.join("\n\n").replace(/\r\n/g, "\n").trim();
}

function listAttachments(part) {
  const attachments = [];
  walkParts(part, (item) => {
    if (item.filename && item.body?.attachmentId) {
      attachments.push({ filename: item.filename, mimeType: item.mimeType || "", attachmentId: item.body.attachmentId, size: item.body.size || 0 });
    }
  });
  return attachments;
}

async function downloadThreadAttachments(config, thread, input) {
  const downloaded = [];
  for (const message of Array.isArray(thread?.messages) ? thread.messages : []) {
    for (const attachment of listAttachments(message.payload)) {
      if (input.includeNonDocuments !== true && !isOperationalDocument({
        filename: attachment.filename,
        content_type: attachment.mimeType
      })) continue;
      downloaded.push(await downloadGmailAttachment(config, {
        messageId: message.id,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        contentType: attachment.mimeType,
        subjectKey: input.subjectKey,
        fileLabel: input.fileLabel
      }));
    }
  }
  return downloaded;
}

export async function downloadGmailAttachment(config, input) {
  const messageId = required(input.messageId, "messageId");
  const attachmentId = required(input.attachmentId, "attachmentId");
  const filename = safeMimeFilename(required(input.filename, "filename"));
  const contentType = String(input.contentType || "application/octet-stream");
  const payload = await googleApi(
    config,
    GMAIL,
    `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  const bytes = base64UrlToBuffer(payload?.data || "");
  const [validated] = validateAttachments([{ filename, contentType, bytes }]);
  const directory = path.join(config.paths.workDir, "gmail", "inbound", safePathSegment(messageId));
  const sha256 = crypto.createHash("sha256").update(validated.bytes).digest("hex");
  fs.mkdirSync(directory, { recursive: true });
  const resolved = resolveOutputPath(directory, validated.filename, sha256);
  if (!resolved.reused) fs.writeFileSync(resolved.path, validated.bytes);
  const memoryCloseout = safeCloseoutAction(config, {
    channel: "gmail",
    action: "receive_attachment",
    status: "downloaded",
    subjectKey: String(input.subjectKey || ""),
    fileLabel: String(input.fileLabel || ""),
    summary: `Downloaded and validated Gmail attachment ${validated.filename} (${validated.bytes.length} bytes).`,
    externalId: `${messageId}:${attachmentId}`,
    evidence: [`gmail:${messageId}:${attachmentId}`, `sha256:${sha256}`]
  });
  return {
    messageId,
    attachmentId,
    filename: validated.filename,
    contentType: validated.contentType,
    bytes: validated.bytes.length,
    sha256,
    validated: true,
    path: resolved.path,
    reused: resolved.reused,
    memoryCloseout
  };
}

function walkParts(part, visitor) {
  visitor(part);
  for (const child of Array.isArray(part?.parts) ? part.parts : []) walkParts(child, visitor);
}

function buildRawEmail({ to, cc, bcc, subject, body }) {
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

// Create a Gmail DRAFT with file attachments (multipart/mixed). attachments:
// [{ filename, contentType, bytes: Buffer }]. Requires Google OAuth creds.
export async function createDraftWithAttachments(config, { to, cc, subject, body, attachments = [], memory = null }) {
  const raw = buildMultipartRaw({ to, cc, subject, body, attachments });
  const result = await googleApi(config, GMAIL, "/gmail/v1/users/me/drafts", { method: "POST", body: { message: { raw } } });
  const out = { id: result.id || "", messageId: result.message?.id || "" };
  if (memory) out.memoryCloseout = gmailCloseout(config, memory, "create_draft", out.id, memory.summary || `Gmail draft created with subject ${subject}.`, "drafted");
  return out;
}

// Same packet, but delivered. Gated on ALLOW_GMAIL_SEND — the caller must also
// pass Chance's explicit go-ahead, since this actually sends to the carrier.
export async function sendMessageWithAttachments(config, { to, cc, subject, body, attachments = [], memory = null }) {
  if (!config.google?.allowSend) {
    throw new Error("Sending is disabled (ALLOW_GMAIL_SEND=false). Enable it to send, or stage a draft instead.");
  }
  const raw = buildMultipartRaw({ to, cc, subject, body, attachments });
  const result = await googleApi(config, GMAIL, "/gmail/v1/users/me/messages/send", { method: "POST", body: { raw } });
  const out = { id: result.id || "", threadId: result.threadId || "" };
  if (memory) out.memoryCloseout = gmailCloseout(config, memory, "send_email", out.id, memory.summary || `Gmail message sent with subject ${subject}.`);
  return out;
}

function gmailCloseout(config, input, action, externalId, summary, status = "executed") {
  return safeCloseoutAction(config, {
    channel: "gmail",
    action,
    status,
    subjectKey: String(input.subjectKey || ""),
    fileLabel: String(input.fileLabel || input.query || ""),
    summary: String(input.memorySummary || input.summary || summary),
    externalId,
    followUps: input.followUps || [],
    evidence: externalId ? [`gmail:${externalId}`] : []
  });
}

export function buildMultipartRaw({ to, cc, subject, body, attachments = [] }) {
  const checkedAttachments = validateAttachments(attachments);
  const boundary = `wave_mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const parts = [];
  parts.push(`--${boundary}`);
  parts.push("Content-Type: text/plain; charset=utf-8");
  parts.push("");
  parts.push(body);
  for (const att of checkedAttachments) {
    const filename = safeMimeFilename(att.filename);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.contentType || "application/octet-stream"}; name="${filename}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${filename}"`);
    parts.push("");
    parts.push(wrapBase64(att.bytes));
  }
  parts.push(`--${boundary}--`);

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].filter(Boolean);

  const raw = base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`);
  verifyMultipartRaw(raw, checkedAttachments);
  return raw;
}

export function validateAttachments(attachments = []) {
  return attachments.map((attachment, index) => {
    const filename = safeMimeFilename(attachment?.filename || `attachment-${index + 1}`);
    const bytes = Buffer.isBuffer(attachment?.bytes) ? attachment.bytes : Buffer.from(attachment?.bytes || []);
    if (!bytes.length) throw new Error(`Attachment ${filename} is empty; refusing to draft/send.`);

    const contentType = String(attachment?.contentType || "application/octet-stream").trim();
    const isPdf = contentType === "application/pdf" || /\.pdf$/i.test(filename);
    if (isPdf) {
      if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error(`Attachment ${filename} is labeled as a PDF but has no PDF header.`);
      }
      const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
      if (!tail.includes("%%EOF")) {
        throw new Error(`Attachment ${filename} is missing the PDF end marker; refusing to draft/send a possibly truncated document.`);
      }
    }
    return { ...attachment, filename, contentType, bytes };
  });
}

function verifyMultipartRaw(raw, attachments) {
  const decoded = base64UrlDecode(raw);
  for (const attachment of attachments) {
    const filename = safeMimeFilename(attachment.filename);
    if (!decoded.includes(`filename="${filename}"`)) {
      throw new Error(`MIME self-check failed: ${filename} is missing from the attachment headers.`);
    }
    if (!decoded.includes(wrapBase64(attachment.bytes))) {
      throw new Error(`MIME self-check failed: ${filename} bytes are missing or changed.`);
    }
  }
}

function wrapBase64(bytes) {
  return Buffer.from(bytes).toString("base64").match(/.{1,76}/g)?.join("\r\n") || "";
}

function safeMimeFilename(value) {
  const clean = String(value || "attachment")
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim();
  return clean || "attachment";
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function base64UrlToBuffer(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function safePathSegment(value) {
  return String(value || "gmail").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 160) || "gmail";
}

function resolveOutputPath(directory, filename, sha256) {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  if (fs.existsSync(candidate) && fileSha256(candidate) === sha256) return { path: candidate, reused: true };
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}-${suffix}${parsed.ext}`);
    if (fs.existsSync(candidate) && fileSha256(candidate) === sha256) return { path: candidate, reused: true };
    suffix += 1;
  }
  return { path: candidate, reused: false };
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// RFC 2047 encoded-word for header values containing non-ASCII (em dashes, ·,
// accented names). Plain ASCII passes through untouched so common subjects stay
// human-readable in the raw source.
function encodeHeaderWord(value) {
  const str = String(value || "");
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stripHtml(value) {
  return String(value || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueMatches(text, pattern, group) {
  const out = new Set();
  for (const match of String(text || "").matchAll(pattern)) {
    const value = String(match[group] || "").trim();
    if (value) out.add(value);
  }
  return [...out];
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function required(value, name) {
  const text = typeof value === "string" ? value.trim() : value;
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { _: trimmed };
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
