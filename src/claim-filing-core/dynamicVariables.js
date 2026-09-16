// Retell dynamic-variable assembly. Pure + dependency-free. Every {{placeholder}}
// referenced in the Retell prompt (retellPrompt.js) must get a value here, or it
// would be spoken literally ("curly brace insured name"), so we default them all.
// Keep PROMPT_PLACEHOLDERS limited to the placeholders actually rendered by
// renderRetellPrompt. Other bridge-only variables (for example the callback
// guard's batch counters) may still ride in the packet without becoming model
// instructions.
export const PROMPT_PLACEHOLDERS = [
  "goal",
  "objective",
  "insuredName",
  "propertyAddress",
  "homeownerPhoneForSpeech",
  "homeownerEmail",
  "carrier",
  "policyNumberForSpeech",
  "claimNumberForSpeech",
  "dateOfLossForSpeech",
  "stormTime",
  "causeOfLoss",
  "adjuster",
  "mortgageCompany",
  "damageOpening",
  "damageDetails",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "occupancy",
  "damageDiscovered",
  "propertyStories",
  "roofAccessibility",
  "damagedRooms",
  "damagedRoomCount",
  "contractorPhoneForSpeech",
  "directionMode",
  "callbackMatch",
  "callbackCarrier",
  "callbackInsuredName",
  "callbackPropertyAddress",
  "callbackPolicyNumberForSpeech",
  "callbackClaimNumberForSpeech",
  "callbackPacketStatus",
  "pendingCallbackCases"
];

export function flattenFactsForDynamicVariables(packet) {
  const out = {};
  for (const [key, value] of Object.entries(packet.verifiedFileFacts || {})) {
    out[key] = String(value ?? "");
  }
  out.objective = String(packet.objective ?? "");
  out.damageOpening = String(packet.damageOpening || "");
  out.damageDetails = (packet.damageDetails || packet.damageSummary || []).join(", ");
  out.policyNumberSpoken = spokenPolicyNumber(out.policyNumber);
  // Keep the raw identifiers above for matching, receipts, and callback
  // ownership. These parallel values are deliberately pre-rendered for TTS so
  // Retell never has to decide whether a compact identifier is one large
  // number or a sequence of characters.
  out.policyNumberForSpeech = spokenIdentifierForAudio(out.policyNumberSpoken);
  out.homeownerPhoneForSpeech = spokenPhoneNumber(out.homeownerPhone);
  out.claimNumberForSpeech = spokenIdentifierForAudio(out.claimNumber);
  out.dateOfLossForSpeech = spokenDate(out.dateOfLoss);
  out.contractorPhoneForSpeech = spokenPhoneNumber(out.contractorPhone);
  out.directionMode = "outbound_claim_call";
  out.callbackMatch = "not_applicable";
  out.callbackCarrier = "Missing";
  out.callbackInsuredName = "Missing";
  out.callbackPropertyAddress = "Missing";
  out.callbackPolicyNumber = "Missing";
  out.callbackPolicyNumberForSpeech = "Missing";
  out.callbackClaimNumber = "Missing";
  out.callbackClaimNumberForSpeech = "Missing";
  out.callbackPacketStatus = "not_applicable";
  out.pendingCallbackCases = "Missing";
  out.batchClaimCount = "0";
  out.batchClaims = "None";
  out.availabilityStatus = "NOT_REQUESTED";
  out.availableAppointmentWindows = "None. Do not schedule an appointment.";
  out.availabilityTimeZone = "America/Chicago";
  out.appointmentDurationMinutes = "120";
  out.availabilitySources = "Not checked for this call";
  // The goal rides along so post-call extraction can tell a new filing from a
  // status follow-up even without call metadata.
  if (packet.goal) out.goal = String(packet.goal);
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!out[key]) out[key] = "Missing";
  }
  return out;
}

export function spokenPolicyNumber(value) {
  const raw = String(value || "").trim();
  if (!raw || /^missing/i.test(raw)) return "Missing";

  // Mortgage declarations often combine a usable policy identifier with
  // control and loan references. Give only the policy itself unless a carrier
  // representative explicitly asks for another identifier.
  const master = raw.match(/\bmaster\s+policy\s*[:#]?\s+([a-z0-9-]+)/i);
  const policy = raw.match(/\bpolicy(?:\s+number|\s*#)?\s*[:#]?\s+([a-z0-9-]+)/i);
  const slashPrefix = raw.split(/\s*\/\s*/)[0].trim();
  const standalone = /^[a-z0-9-]+$/i.test(slashPrefix) ? slashPrefix : "";
  const identifier = raw.match(/\b(?=[a-z0-9-]*\d)[a-z0-9-]{5,}\b/i);
  const selected = String(master?.[1] || policy?.[1] || standalone || identifier?.[0] || "").trim();

  return selected || "Missing";
}

const SPOKEN_DIGITS = Object.freeze({
  0: "zero",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine"
});

// Retell's Read Slowly guidance recommends digit words separated into groups
// with spaces around a hyphen. The TTS treats the spaced hyphen as a pause. We
// generate that form deterministically instead of relying on prompt compliance.
export function spokenIdentifierForAudio(value) {
  const raw = String(value || "").trim();
  if (!raw || /^missing/i.test(raw)) return "Missing";

  const explicitGroups = raw
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const compact = explicitGroups.join("");
  if (!compact) return "Missing";
  const groups = explicitGroups.length > 1
    ? explicitGroups
    : balancedSpeechGroups(compact);
  return groups
    .map((group) => [...group].map((character) => SPOKEN_DIGITS[character] || character).join(" "))
    .join(" - ");
}

export function spokenPhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "Missing";
  const groups = digits.length === 10
    ? [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
    : digits.length === 11 && digits.startsWith("1")
      ? [digits.slice(0, 1), digits.slice(1, 4), digits.slice(4, 7), digits.slice(7)]
      : balancedSpeechGroups(digits);
  return groups
    .map((group) => [...group].map((digit) => SPOKEN_DIGITS[digit]).join(" "))
    .join(" - ");
}

export function spokenDate(value) {
  const raw = String(value || "").trim();
  if (!raw || /^missing/i.test(raw)) return "Missing";
  const match = raw.match(/^(?:(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{1,2})-(\d{1,2}))$/);
  if (!match) return raw;
  const month = Number(match[1] || match[5]);
  const day = Number(match[2] || match[6]);
  const year = String(match[3] || match[4]);
  const monthName = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ][month - 1];
  if (!monthName || day < 1 || day > 31) return raw;
  return `${monthName} ${ordinalWord(day)}, ${spokenYear(year)}`;
}

function balancedSpeechGroups(compact) {
  if (compact.length <= 4) return [compact];
  if (compact.length === 5) return [compact.slice(0, 2), compact.slice(2)];
  if (compact.length === 6) return [compact.slice(0, 3), compact.slice(3)];
  if (compact.length === 7) return [compact.slice(0, 3), compact.slice(3)];
  if (compact.length === 8) return [compact.slice(0, 4), compact.slice(4)];
  if (compact.length === 9) return [compact.slice(0, 3), compact.slice(3, 6), compact.slice(6)];
  if (compact.length === 10) return [compact.slice(0, 3), compact.slice(3, 6), compact.slice(6)];
  const groups = [];
  for (let index = 0; index < compact.length; index += 4) groups.push(compact.slice(index, index + 4));
  return groups;
}

function ordinalWord(day) {
  return [
    "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
    "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth",
    "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty first", "twenty second",
    "twenty third", "twenty fourth", "twenty fifth", "twenty sixth", "twenty seventh",
    "twenty eighth", "twenty ninth", "thirtieth", "thirty first"
  ][day];
}

function spokenYear(year) {
  const number = Number(year);
  if (!Number.isInteger(number)) return year;
  if (number >= 2000 && number <= 2009) {
    return `two thousand${number === 2000 ? "" : ` ${numberToWords(number - 2000)}`}`;
  }
  if (number >= 2010 && number <= 2099) {
    return `twenty ${numberToWords(number - 2000)}`;
  }
  return [...year].map((digit) => SPOKEN_DIGITS[digit]).join(" ");
}

function numberToWords(number) {
  const underTwenty = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen"
  ];
  if (number < 20) return underTwenty[number];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const ones = number % 10;
  return ones ? `${tens[Math.floor(number / 10)]} ${underTwenty[ones]}` : tens[Math.floor(number / 10)];
}
