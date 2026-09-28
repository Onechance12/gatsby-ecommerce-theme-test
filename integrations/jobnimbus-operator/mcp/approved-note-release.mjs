// Reviewed installed release. Never derive these pins from a tool request,
// environment variable, or provider response. Enable only after a reviewed,
// coordinated bridge/manifest/legacy-isolation release.
export const APPROVED_NOTE_RELEASE = Object.freeze({
  enabled: true,
  policyId: "chance-58-files-notes-v1",
  policySha256: "08490f603cf1c6d451e49f9cf4a195d8ca52b2253e06e2572b08a82a3a43ab1d",
  bridgeCommit: "c81d30343e608331160ab6246ba1a5ae8dc2de8a"
});

export function validateApprovedNoteRelease(release) {
  if (!release || release.enabled === false) return false;
  if (
    release.enabled !== true
    || release.policyId !== "chance-58-files-notes-v1"
    || !/^[a-f0-9]{64}$/.test(release.policySha256 || "")
    || !/^[a-f0-9]{40}$/.test(release.bridgeCommit || "")
  ) {
    throw new Error("Approved notes require a reviewed exact manifest hash and bridge commit; no automatic activation is allowed.");
  }
  return true;
}

export const APPROVED_NOTES_ENABLED = validateApprovedNoteRelease(APPROVED_NOTE_RELEASE);

export const RICHARD_MENTION_RECIPIENT = Object.freeze({
  id: "kyd3walzugh6dlji6wpygdj",
  displayName: "Richard R",
  tag: "@RichardR"
});

export function approvedNoteMentionIntent(note) {
  const text = typeof note === "string" ? note : "";
  if (!text.includes("@")) return { mentionRequested: false, intendedRecipient: null };
  if ((text.match(/@/g) || []).length !== 1 || !/(^|\s)@RichardR(?=$|[\s.,!?;:])/u.test(text)) {
    throw new Error("Only one exact @RichardR mention request is supported. Other @ text and repeated tags are forbidden; notification delivery remains unverified.");
  }
  return { mentionRequested: true, intendedRecipient: { ...RICHARD_MENTION_RECIPIENT } };
}

export function matchesApprovedNoteMentionIntent(value, expected) {
  if (!value || value.mentionRequested !== expected.mentionRequested) return false;
  if (!expected.mentionRequested) return value.intendedRecipient === null;
  const recipient = value.intendedRecipient;
  return Boolean(recipient && Object.getPrototypeOf(recipient) === Object.prototype
    && Object.keys(recipient).length === 3
    && recipient.id === RICHARD_MENTION_RECIPIENT.id
    && recipient.displayName === RICHARD_MENTION_RECIPIENT.displayName
    && recipient.tag === RICHARD_MENTION_RECIPIENT.tag);
}

export function validateApprovedNoteOperation(operations, operatorScope, { enabled = APPROVED_NOTES_ENABLED } = {}) {
  const notes = operations.filter((operation) => operation?.type === "jobnimbus.create_note");
  if (!notes.length) return;
  if (!enabled) throw new Error("Approved JobNimbus notes are not activated in this plugin release.");
  if (operatorScope !== "assigned" || operations.length !== 1 || notes.length !== 1) {
    throw new Error("A JobNimbus note must be the sole exact assigned-file operation.");
  }
  const payload = notes[0].payload;
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error("A note payload must be exactly {query,note}.");
  }
  const keys = Object.keys(payload).sort();
  if (
    keys.length !== 2 || keys[0] !== "note" || keys[1] !== "query"
    || typeof payload.query !== "string" || !/^#?\d+$/.test(payload.query)
    || payload.query.replace(/^#/, "") === "2628"
    || typeof payload.note !== "string" || !payload.note.trim()
    || payload.note !== payload.note.trim() || /<[^>]*>/.test(payload.note)
    || payload.note.length > 4000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.note)
  ) {
    throw new Error("A note requires one exact allowed numeric file and 1–4000 characters of plain text; extra fields are forbidden.");
  }
  approvedNoteMentionIntent(payload.note);
}
