import { createHash } from "node:crypto";

export function approvedNoteContentHash(note) {
  return createHash("sha256").update(note, "utf8").digest("hex");
}

export function approvedNoteMentionIntent(note) {
  if (!note.includes("@")) return { mentionRequested: false, intendedRecipient: null };
  if ((note.match(/@/g) || []).length !== 1 || !/(^|\s)@RichardR(?=$|[\s.,!?;:])/u.test(note)) {
    throw new Error("Only the exact canonical @RichardR tag is supported, once. Its notification delivery is not verified; all other mentions are blocked.");
  }
  // Verified UI evidence establishes this exact tag and recipient, not API
  // notification delivery. Persist the request without claiming notification.
  return {
    mentionRequested: true,
    intendedRecipient: { id: "kyd3walzugh6dlji6wpygdj", displayName: "Richard R", tag: "@RichardR" }
  };
}

export function approvedNoteCreatedId(response) {
  const values = [response?.jnid, response?.id].filter((value) => value !== undefined);
  if (!values.length) return "";
  // Accept the established top-level response, but never silently choose it
  // over a conflicting legacy envelope's identifier.
  for (const key of ["data", "activity", "note", "message", "contact"]) {
    const nested = response?.[key];
    if (nested && typeof nested === "object") {
      values.push(...[nested.jnid, nested.id].filter((value) => value !== undefined));
    }
  }
  if (values.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value))) return "";
  return new Set(values).size === 1 ? values[0] : "";
}

export function validateApprovedNotePayload(payload) {
  const keys = Object.keys(payload || {});
  if (!keys.includes("query") || !keys.includes("note")
    || keys.some((key) => !["query", "note", "operatorScope"].includes(key))
    || (keys.includes("operatorScope") && payload.operatorScope !== "assigned")) {
    throw new Error("Approved note payload must contain only {query,note} plus the coordinator-injected assigned scope. Recipient and notification fields cannot be supplied separately.");
  }
  if (typeof payload.query !== "string" || !/^#?\d+$/.test(payload.query)) {
    throw new Error("Approved note requires one exact numeric JobNimbus file query.");
  }
  const note = payload.note;
  if (typeof note !== "string" || !note.trim() || note.length > 4000
    || note !== note.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)
    || /<[^>]*>/.test(note)) {
    throw new Error("Approved note must be exact plain text, 1–4000 characters, with no surrounding whitespace, control characters, or HTML.");
  }
  return { note, noteSha256: approvedNoteContentHash(note), ...approvedNoteMentionIntent(note) };
}

export function approvedNoteRecordMatches(record, { id, fileId, note }) {
  const recordId = approvedNoteCreatedId(record);
  const active = !["is_active", "isActive", "active"].some((key) => (
    [false, 0, "false", "0"].includes(record?.[key])
  ));
  const removed = ["is_deleted", "isDeleted", "deleted", "is_archived", "isArchived", "archived"]
    .some((key) => [true, 1, "true", "1"].includes(record?.[key]));
  return Boolean(/^[A-Za-z0-9_-]{8,100}$/.test(recordId) && (!id || recordId === id)
    && String(record?.record_type_name || "").toLowerCase() === "note"
    && String(record?.primary?.id || "") === fileId
    && record?.note === note && active && !removed);
}

export function approvedNoteIntentMatches(intent, fileId, note) {
  let mention;
  try { mention = approvedNoteMentionIntent(note); } catch { return false; }
  return typeof note === "string" && intent?.type === "jobnimbus.create_note"
    && intent.fileId === fileId
    && intent.reconciliation?.note === note
    && intent.reconciliation?.noteSha256 === approvedNoteContentHash(note)
    && intent.reconciliation?.mentionRequested === mention.mentionRequested
    && JSON.stringify(intent.reconciliation?.intendedRecipient) === JSON.stringify(mention.intendedRecipient);
}
