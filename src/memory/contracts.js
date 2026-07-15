// Memory contracts — the rules every memory record must obey. Pure + dependency
// free. Ported (contracts only, no code) from the evidence-backed memory design
// in Onechance12/Jobrolo (src/lib/memory/contracts.ts, commit 53fbfcd): typed
// kinds, a status lifecycle with supersession, confidence + importance, and
// REQUIRED evidence references. Jobrolo is reference-only — never modified.
//
// Two lanes, and the split is a PII firewall, not a style choice:
//   company — operating knowledge (policies, wording, carrier quirks, lessons).
//             Stored in memory/company.jsonl, which IS COMMITTED to a PUBLIC
//             repo. Client names/claims/addresses are forbidden here and
//             enforced by assertCompanyLaneSafe().
//   client  — per-homeowner/per-file facts. Stored under data/memory/ which is
//             gitignored. Never pushed anywhere.

export const MEMORY_LANES = ["company", "client"];

export const MEMORY_KINDS = [
  "fact",        // verifiable statement about the world
  "decision",    // a choice Chance made ("don't send Part B in direct-to-pay")
  "preference",  // how Chance likes things done
  "commitment",  // something promised and still open
  "lesson",      // hard-won operational learning (mistakes included)
  "correction",  // Chance corrected the assistant — highest teaching value
  "outcome"      // how something actually turned out (closes the loop)
];

export const MEMORY_STATUSES = ["candidate", "verified", "disputed", "superseded", "expired"];

// Evidence verification tiers, ranked. A memory upgraded by better evidence
// keeps the strongest tier (mirrors Jobrolo's derived<observed<confirmed).
export const EVIDENCE_RANK = { derived: 0, observed: 1, confirmed: 2 };

export const PROPOSAL_STATUSES = ["candidate", "approved", "rejected", "executed", "obsolete"];
export const PROPOSAL_TYPES = ["recommendation", "risk", "opportunity", "process_change"];

// Normalize + validate a draft into a storable record. Throws on contract
// violations so bad memories never reach disk.
export function normalizeMemoryDraft(draft = {}) {
  const lane = String(draft.lane || "client").toLowerCase();
  if (!MEMORY_LANES.includes(lane)) throw new Error(`lane must be one of ${MEMORY_LANES.join("/")}`);
  const kind = String(draft.kind || "").toLowerCase();
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`kind must be one of ${MEMORY_KINDS.join("/")}`);
  const content = String(draft.content || "").trim();
  if (content.length < 8) throw new Error("content too short to be a useful memory");
  if (content.length > 1200) throw new Error("content too long — split it into separate memories");

  const evidence = normalizeEvidence(draft.evidence);
  if (!evidence.length) throw new Error("memory requires at least one evidence ref ({type,id} or {type,note})");

  const confidence = clampNumber(draft.confidence, 0, 1, 0.6);
  const importance = clampNumber(draft.importance, 1, 10, 5);

  return {
    lane,
    kind,
    content,
    subjectKey: String(draft.subjectKey || "").trim(),  // e.g. file jnid, "gmail", "jobnimbus-api"
    status: "candidate",
    confidence,
    importance,
    evidence,
    dedupKey: draft.dedupKey ? String(draft.dedupKey) : defaultDedupKey(lane, kind, content),
    supersedesId: draft.supersedesId ? String(draft.supersedesId) : "",
    expiresAt: draft.expiresAt ? String(draft.expiresAt) : ""
  };
}

// Evidence refs: where did this memory come from. {type,id} points at a real
// artifact (gmail message, jobnimbus activity, quo message, git commit, file
// path); {type:"chance",note} records direct instruction from Chance, which
// counts as confirmed.
export function normalizeEvidence(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => {
    if (typeof item === "string") return { type: "note", id: "", note: item, verification: "derived" };
    const type = String(item.type || "note").toLowerCase();
    const verification = EVIDENCE_RANK[item.verification] !== undefined
      ? item.verification
      : type === "chance" ? "confirmed" : "observed";
    return { type, id: String(item.id || ""), note: String(item.note || ""), verification };
  }).filter((item) => item.id || item.note).slice(0, 12);
}

export function normalizeProposalDraft(draft = {}) {
  const type = String(draft.type || "").toLowerCase();
  if (!PROPOSAL_TYPES.includes(type)) throw new Error(`proposal type must be one of ${PROPOSAL_TYPES.join("/")}`);
  const title = String(draft.title || "").trim();
  if (title.length < 3) throw new Error("proposal needs a title");
  const detail = String(draft.detail || "").trim();
  if (detail.length < 8) throw new Error("proposal needs detail");
  const memoryIds = (Array.isArray(draft.memoryIds) ? draft.memoryIds : []).map(String).filter(Boolean);
  if (!memoryIds.length) throw new Error("proposal must cite at least one memory id it is based on");
  return {
    type,
    title,
    detail,
    memoryIds,
    priority: ["low", "normal", "high", "urgent"].includes(draft.priority) ? draft.priority : "normal",
    confidence: clampNumber(draft.confidence, 0, 1, 0.5),
    status: "candidate",
    dedupKey: draft.dedupKey ? String(draft.dedupKey) : defaultDedupKey("proposal", type, title)
  };
}

// The PII firewall for the tracked company lane. Pattern-based and fail-closed
// (per Codex review on PR #4): emails, phone numbers, street addresses, long
// numbers, and person-name references near client words are all blocked WITHOUT
// relying on the optional customerNames list. Conservative on purpose: a
// blocked save can always go to the client lane.
export function assertCompanyLaneSafe(content, customerNames = []) {
  const text = String(content || "");
  if (/\b\d{7,}\b/.test(text)) {
    throw new Error("company-lane memory contains a long number (claim/policy/phone?). Put client facts in the client lane.");
  }
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) {
    throw new Error("company-lane memory contains an email address. Put contact details in the client lane.");
  }
  if (/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b/.test(text)) {
    throw new Error("company-lane memory contains a phone number. Put contact details in the client lane.");
  }
  if (/\b\d{1,6}\s+[A-Za-z][A-Za-z ]{2,30}\s?(?:st|street|dr|drive|ln|lane|ave|avenue|rd|road|ct|court|blvd|boulevard|way|cir|circle|pkwy|parkway|pl|place|trl|trail)\b\.?/i.test(text)) {
    throw new Error("company-lane memory contains what looks like a street address. Put property details in the client lane.");
  }
  if (/(?:policyholder|insured|homeowner|client|customer)s?\s*(?:named|name is|:|-)?\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text)) {
    throw new Error("company-lane memory appears to reference a client by name. Put client facts in the client lane.");
  }
  for (const name of customerNames) {
    const clean = String(name || "").trim();
    if (clean.length < 5) continue;
    // match full name or distinctive last word (len>=5) as whole words
    const parts = clean.split(/\s+/).filter((p) => p.length >= 5);
    for (const part of [clean, ...parts]) {
      const re = new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(text)) {
        throw new Error(`company-lane memory mentions "${part}" which matches a client name. Use lane:"client".`);
      }
    }
  }
}

export function defaultDedupKey(lane, kind, content) {
  const slug = String(content).toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 10).join("-");
  return `${lane}:${kind}:${slug}`;
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function memoryId() {
  // time-sortable, dependency-free id
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
