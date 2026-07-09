// Gmail read + draft layer, ported from the jobnimbus-bridge branch.
// Reads are open; creating a draft requires execute:true (dry-run default);
// SENDING requires ALLOW_GMAIL_SEND=true AND execute:true. Drafts-first is the
// standing posture — Chance hits send.

import { googleApi } from "./googleAuth.js";

const GMAIL = "https://gmail.googleapis.com";

export async function runGmailTool(config, args) {
  const [tool, ...rest] = args;
  const input = parseInput(rest.join(" "));

  if (!tool || tool === "list") {
    printJson({
      tools: [
        { name: "search", input: { query: "gmail query string", limit: "number optional" }, note: "e.g. 'from:claims@claims.allstate.com newer_than:30d'" },
        { name: "thread", input: { threadId: "string" }, note: "full thread with assistant read (claim#/policy#/contacts extraction)" },
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
    printJson({ id: thread.id || threadId, messageCount: messages.length, messages, assistantRead: assistantRead(messages) });
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
      printJson({ mode: "executed", message: compactMessage(result) });
      return;
    }
    const result = await googleApi(config, GMAIL, "/gmail/v1/users/me/drafts", { method: "POST", body: { message: cleanObject({ raw, threadId: input.threadId }) } });
    printJson({ mode: "executed", draft: { id: result.id || "", message: result.message ? compactMessage(result.message) : null } });
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
    snippet: message.snippet || ""
  };
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

function walkParts(part, visitor) {
  visitor(part);
  for (const child of Array.isArray(part?.parts) ? part.parts : []) walkParts(child, visitor);
}

function buildRawEmail({ to, cc, bcc, subject, body }) {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8"
  ].filter(Boolean);
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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
