import path from "node:path";
import { runChanceSweep } from "../sweep/runChanceSweep.js";
import { writeJson, writeText } from "../lib/io.js";
import { loadChanceReviews } from "./chanceQueue.js";

export async function runChanceReviewPackets(config, args) {
  const input = parseInput(args.join(" "));
  const refresh = input.refresh === undefined ? true : truthy(input.refresh);
  const limit = Number(input.limit ?? 0);
  const query = String(input.query || input._ || "").trim();

  if (refresh) {
    await runChanceSweep(config);
  }

  const reviews = loadChanceReviews(config);
  const allPackets = reviews.map(buildPacket);
  let packets = allPackets;
  if (query) {
    const exactPackets = allPackets.filter((packet) => exactMatchesPacket(packet, query));
    packets = exactPackets.length ? exactPackets : allPackets.filter((packet) => matchesPacket(packet, query));
  }
  const report = {
    owner: "Chance Pearson",
    generatedAt: new Date().toISOString(),
    source: refresh ? "fresh Chance-only JobNimbus sweep" : "existing local Chance sweep",
    purpose: "Evidence packet for human/Codex review. This does not decide or execute next actions.",
    query: query || "",
    totalFileCount: allPackets.length,
    fileCount: packets.length,
    packets
  };

  if (query) {
    writeJson(path.join(config.paths.reportsDir, "chance-review-packets-last-query.json"), report);
    writeText(path.join(config.paths.reportsDir, "chance-review-packets-last-query.md"), renderMarkdown(report));
  } else {
    writeJson(path.join(config.paths.reportsDir, "chance-review-packets.json"), report);
    writeText(path.join(config.paths.reportsDir, "chance-review-packets.md"), renderMarkdown(report));
  }

  const printablePackets = limit > 0 ? packets.slice(0, limit) : packets;
  console.log(JSON.stringify({
    ...report,
    displayedPacketCount: printablePackets.length,
    packets: printablePackets
  }, null, 2));
}

function buildPacket(review) {
  const file = review.file;
  const currentFields = {
    status: file.status || "",
    thresherPhase: review.thresherPhase || "",
    workflowLane: review.workflowLane || "",
    ownerLane: review.ownerLane || "",
    priority: review.priority || "",
    daysInPhase: review.daysInPhase,
    lastActivityDate: file.lastActivityDate || "",
    address: file.address || "",
    phone: file.phone || file.mobilePhone || file.homePhone || "",
    email: file.email || "",
    carrier: file.carrier || "",
    claimNumber: file.claimNumber || "",
    policyNumber: file.policyNumber || "",
    dateOfLoss: file.dateOfLoss || "",
    typeOfLoss: file.typeOfLoss || "",
    deductibleAmount: file.deductibleAmount || "",
    adjuster: {
      name: file.adjuster?.name || "",
      phone: file.adjuster?.phone || "",
      email: file.adjuster?.email || ""
    }
  };

  return {
    id: file.id,
    name: file.customer,
    number: file.number || "",
    currentFields,
    evidenceFlags: {
      categories: review.categories || [],
      missingInfo: review.missingInfo || [],
      signals: review.signals || [],
      contradictions: findContradictions(review)
    },
    openTasks: (file.openTasks || []).map((task) => ({
      title: task.title || "",
      dueDate: task.dueDate || "",
      assignedTo: task.assignedTo || "",
      description: clean(task.description)
    })),
    appointmentAccess: review.appointmentAccess || {},
    documents: classifyDocuments(file.documents || []),
    payments: file.payments || [],
    recentTimeline: buildTimeline(file).slice(0, 20),
    recentNotes: (file.notes || []).slice(0, 12).map((note) => ({
      date: formatDateValue(note.createdAt),
      body: clean(note.body)
    })),
    reviewInstruction: "Use this packet as evidence only. Do not treat categories as final next actions without reviewing notes/docs/context."
  };
}

function classifyDocuments(documents) {
  return documents.map((document) => {
    const name = document.name || "";
    return {
      name,
      type: document.type || "",
      date: formatDateValue(document.createdAt || document.date),
      kind: documentKind(name),
      includeForReview: documentKind(name) !== "photo/site image"
    };
  });
}

function documentKind(name) {
  if (/\.(jpe?g|png|heic|gif|webp)$/i.test(name) || /\bphoto\b/i.test(name)) return "photo/site image";
  if (/estimate|scope|deprec|depreciation|final[\s_-]*draft|xactimate|\.esx$/i.test(name)) return "estimate/scope";
  if (/\b(policy|dec|declarations?)\b/i.test(name)) return "policy/dec";
  if (/\b(lor|letter of representation)\b/i.test(name)) return "LOR";
  if (/\b(tdi|fin535|part b|contract|pa contract)\b/i.test(name)) return "representation/contract";
  if (/\b(carrier|allstate|state farm|travelers|liberty|farmers|usaa|progressive|foremost)\b/i.test(name)) return "carrier document";
  return "other document";
}

function findContradictions(review) {
  const file = review.file;
  const notesText = clean((file.notes || []).map((note) => note.body).join(" ")).toLowerCase();
  const contradictions = [];

  if (file.claimNumber && /\bclaim not filed\b/i.test(notesText)) {
    contradictions.push("Historical note says claim not filed, but current claim number is populated.");
  }
  if (/submitted awaiting confirmation/i.test(file.status || "") && !file.claimNumber) {
    contradictions.push("Status says submitted awaiting confirmation, but claim number is missing.");
  }
  if ((review.categories || []).includes("Policy/coverage lookup failed") && file.policyNumber) {
    contradictions.push("Policy number exists, but notes indicate carrier could not locate active coverage/current policy.");
  }
  if (/appraisal/i.test(file.status || "") && !file.claimNumber) {
    contradictions.push("Appraisal-stage status exists, but claim number is missing.");
  }
  if ((review.categories || []).includes("Photo file / estimate needed") && hasEstimateDocument(file)) {
    contradictions.push("Status says photo/estimate needed, but estimate/scope document metadata exists.");
  }

  return contradictions;
}

function hasEstimateDocument(file) {
  return (file.documents || []).some((document) => /estimate|scope|deprec|depreciation|final[\s_-]*draft|\.esx$/i.test(document.name || ""));
}

function buildTimeline(file) {
  const items = [];
  for (const note of file.notes || []) {
    items.push({ date: formatDateValue(note.createdAt), sortValue: sortDateValue(note.createdAt), kind: "note", text: clean(note.body) });
  }
  for (const task of file.openTasks || []) {
    items.push({ date: formatDateValue(task.dueDate), sortValue: sortDateValue(task.dueDate), kind: "open_task", text: clean(`${task.title || ""}${task.assignedTo ? ` | ${task.assignedTo}` : ""}`) });
  }
  for (const document of file.documents || []) {
    const date = document.createdAt || document.date;
    items.push({ date: formatDateValue(date), sortValue: sortDateValue(date), kind: "document", text: clean(document.name) });
  }
  return items
    .filter((item) => item.text)
    .sort((a, b) => b.sortValue - a.sortValue)
    .map(({ sortValue, ...item }) => item);
}

function renderMarkdown(report) {
  const lines = [
    `# Chance Review Evidence Packets`,
    "",
    `Generated: ${report.generatedAt}`,
    `Files: ${report.fileCount}`,
    "",
    "These packets are evidence for review. They are not approval decisions.",
    ""
  ];

  for (const packet of report.packets) {
    lines.push(`## ${packet.name}`);
    lines.push(`- JobNimbus id: ${packet.id}`);
    lines.push(`- Status: ${packet.currentFields.status}`);
    lines.push(`- Phase: ${packet.currentFields.thresherPhase}`);
    lines.push(`- Address: ${packet.currentFields.address || "Missing"}`);
    lines.push(`- Carrier / claim / policy / DOL: ${packet.currentFields.carrier || "Missing"} / ${packet.currentFields.claimNumber || "Missing"} / ${packet.currentFields.policyNumber || "Missing"} / ${packet.currentFields.dateOfLoss || "Missing"}`);
    lines.push(`- Missing info: ${packet.evidenceFlags.missingInfo.join(", ") || "None obvious"}`);
    if (packet.evidenceFlags.contradictions.length) {
      lines.push(`- Contradictions: ${packet.evidenceFlags.contradictions.join("; ")}`);
    }
    lines.push(`- Open tasks: ${packet.openTasks.map((task) => task.title).filter(Boolean).join("; ") || "None"}`);
    lines.push(`- Review docs: ${packet.documents.filter((doc) => doc.includeForReview).map((doc) => `${doc.name} (${doc.kind})`).join("; ") || "None"}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function matchesPacket(packet, query) {
  const haystack = normalizeForSearch(JSON.stringify({
    id: packet.id,
    name: packet.name,
    number: packet.number,
    currentFields: packet.currentFields,
    documents: packet.documents.map((document) => document.name),
    recentTimeline: packet.recentTimeline.slice(0, 10)
  }));
  return haystack.includes(normalizeForSearch(query));
}

function exactMatchesPacket(packet, query) {
  const term = normalizeForSearch(query);
  return [
    packet.id,
    packet.number,
    packet.currentFields.claimNumber,
    packet.currentFields.policyNumber,
    packet.currentFields.phone,
    packet.currentFields.email
  ].some((value) => normalizeForSearch(value) === term);
}

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return { _: trimmed };
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatDateValue(value) {
  if (!value) return "";
  const date = parseDateValue(value);
  if (!date) return String(value);
  return date.toISOString().slice(0, 10);
}

function sortDateValue(value) {
  const date = parseDateValue(value);
  return date ? date.getTime() : 0;
}

function parseDateValue(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return parseDateValue(Number(text));
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
