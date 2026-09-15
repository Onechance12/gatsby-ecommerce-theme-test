const COVERAGE_QUESTION = /\b(?:confirm|verify)\b.{0,120}\b(?:policy|coverage|term)\b.{0,120}\b(?:active|in force|effective|cover(?:ed|age)?)\b.{0,140}\b(?:date of loss|loss date|that date|on\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b|\b(?:policy|coverage|term)\b.{0,120}\b(?:active|in force|effective|cover(?:ed|age)?)\b.{0,140}\b(?:date of loss|loss date|that date)\b.{0,120}\b(?:confirm|correct|right)\b/i;
const EXPLICIT_COVERAGE = /\b(?:policy|coverage|term)\b.{0,120}\b(?:is|was|shows as|remains)\s+(?:active|in force|effective|covered)\b.{0,140}\b(?:date of loss|loss date|that date|on\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b|\b(?:active|in force|effective|covered)\b.{0,140}\b(?:date of loss|loss date|that date)\b/i;
const AFFIRMATIVE = /^(?:yes|correct|that(?:'s| is) correct|it is|it was|we do|confirmed|absolutely)\b/i;
const COVERAGE_CONTRADICTION = /\b(?:not|isn't|wasn't|doesn't|didn't|cannot|can't|unable|expired|lapsed|cancelled|canceled|terminated)\b.{0,90}\b(?:active|in force|effective|covered|cover|coverage|policy|date of loss|loss date)\b|\b(?:active|in force|effective|covered|coverage|policy)\b.{0,90}\b(?:not|isn't|wasn't|doesn't|didn't|expired|lapsed|cancelled|canceled|terminated|outside|after|before)\b.{0,90}\b(?:date of loss|loss date|that date|term|coverage)?\b|\b(?:but|however|except)\b.{0,100}\b(?:not|isn't|wasn't|doesn't|didn't|cannot|can't|outside|expired|lapsed|cancelled|canceled)\b/i;

// Returns transcript-backed proof that one exact policy identifier was active
// for the loss date. Retell analysis and a model's tool arguments are claims,
// not evidence; only speaker-attributed carrier words can satisfy this gate.
export function verifyActiveCoverage(call = {}, policyNumber = "") {
  const normalizedPolicy = normalizeIdentifier(policyNumber);
  if (normalizedPolicy.length < 4) return unverified("missing_active_policy_number");

  const turns = attributedTurns(call);
  if (!turns.length) return unverified("missing_speaker_attribution");

  let confirmation = null;
  let contradictedAfterConfirmation = false;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== "carrier") continue;
    const statement = turn.content;
    if (COVERAGE_CONTRADICTION.test(statement)) {
      // Carrier corrections control over an earlier yes. Keep scanning so a
      // later, equally explicit re-confirmation can restore proof, but never
      // return on the first affirmative and ignore a later correction.
      if (confirmation) {
        confirmation = null;
        contradictedAfterConfirmation = true;
      }
      continue;
    }

    if (EXPLICIT_COVERAGE.test(statement) && identifierAppears(normalizedPolicy, statement)) {
      confirmation = verified(policyNumber, "carrier_explicit_confirmation");
      contradictedAfterConfirmation = false;
      continue;
    }

    const previous = turns[index - 1];
    if (
      previous?.role === "agent"
      && COVERAGE_QUESTION.test(previous.content)
      && identifierAppears(normalizedPolicy, previous.content)
      && AFFIRMATIVE.test(statement)
    ) {
      confirmation = verified(policyNumber, "carrier_affirmed_exact_policy_question");
      contradictedAfterConfirmation = false;
    }
  }

  if (confirmation) return confirmation;
  return unverified(contradictedAfterConfirmation
    ? "later_carrier_coverage_contradiction"
    : "no_exact_carrier_confirmation");
}

export function hasTranscriptBackedActiveCoverage(call = {}, policyNumber = "") {
  return verifyActiveCoverage(call, policyNumber).confirmed;
}

function attributedTurns(call) {
  const source = call?.raw && typeof call.raw === "object" ? call.raw : call;
  if (Array.isArray(source?.transcript_object)) {
    return source.transcript_object
      .map((turn) => ({
        role: speakerRole(turn?.role),
        content: String(turn?.content || turn?.text || "").trim()
      }))
      .filter((turn) => turn.role && turn.content);
  }

  const transcript = String(source?.transcript || call?.transcript || "").trim();
  if (!transcript) return [];
  const turns = transcript.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(agent|assistant|bot|caller|user|callee|representative|human)\s*:\s*(.*)$/i);
    return match ? { role: speakerRole(match[1]), content: String(match[2] || "").trim() } : null;
  });
  if (turns.some((turn) => !turn)) return [];
  return turns.filter((turn) => turn.role && turn.content);
}

function speakerRole(role) {
  const normalized = String(role || "").toLowerCase();
  if (["agent", "assistant", "bot", "caller"].includes(normalized)) return "agent";
  if (["user", "callee", "representative", "human"].includes(normalized)) return "carrier";
  return "";
}

function normalizeIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function identifierAppears(normalizedIdentifier, value) {
  if (!normalizedIdentifier) return false;
  if (normalizeIdentifier(value).includes(normalizedIdentifier)) return true;
  return spokenIdentifierSequences(value).some((sequence) => sequence.includes(normalizedIdentifier));
}

function spokenIdentifierSequences(value) {
  const digitWords = {
    zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9"
  };
  const prepared = String(value || "")
    .toLowerCase()
    .replace(/\b([a-z])\s+as\s+in\s+[a-z]+\b/g, " $1 ");
  const sequences = [];
  let current = "";
  for (const token of prepared.match(/[a-z0-9]+/g) || []) {
    const encoded = digitWords[token] || (/^[a-z0-9]$/.test(token) ? token.toUpperCase() : "");
    if (encoded) current += encoded;
    else if (current) {
      if (current.length >= 4) sequences.push(current);
      current = "";
    }
  }
  if (current.length >= 4) sequences.push(current);
  return sequences;
}

function verified(policyNumber, source) {
  return { confirmed: true, activePolicyNumber: String(policyNumber || "").trim(), source, reason: "" };
}

function unverified(reason) {
  return { confirmed: false, activePolicyNumber: "", source: "none", reason };
}
