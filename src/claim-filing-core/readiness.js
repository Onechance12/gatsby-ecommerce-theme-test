// Carrier-aware filing readiness. Pure + dependency-free. A file is "ready to
// file" when the carrier can actually find and open the claim: insured name,
// property address, carrier, date of loss, and a filing phone. Policy number is
// NOT a universal blocker — the Wave playbook lets the carrier locate coverage
// by insured/address/phone — so it only hard-blocks carriers the directory flags
// requiresPolicyNumber. Also exposes the duplicate-new-claim guard so the bridge
// adapter gets the same protection the local CLI has.
import { cleanClaimNumber } from "./packet.js";

const isMissing = (v) => !v || /^missing/i.test(String(v));

// assessReadiness(packet, to, carrier)
//   packet  — from buildClaimCallPacket
//   to      — resolved filing phone (may be "")
//   carrier — carrier directory record (may be null) with requiresPolicyNumber
export function assessReadiness(packet, to, carrier) {
  const f = packet.verifiedFileFacts;
  const blockers = [];
  const warnings = [];

  if (isMissing(f.insuredName)) blockers.push("no insured name");
  if (isMissing(f.propertyAddress)) blockers.push("no property address");
  if (isMissing(f.carrier)) blockers.push("no carrier");
  if (isMissing(f.dateOfLoss)) blockers.push("no date of loss");
  if (!to && !carrier) blockers.push("no filing phone for this carrier");

  if (isMissing(f.policyNumber)) {
    if (carrier?.requiresPolicyNumber) blockers.push(`no policy number (${carrier.display} requires it to locate the policy)`);
    else warnings.push("no policy number — carrier will be asked to locate coverage by insured name/address/phone");
  }

  if (isMissing(f.stormTime)) warnings.push("no storm time (run DOL report / inspection capture)");
  if (!packet.damageSummary?.length || /^No specific/i.test(packet.damageSummary[0])) {
    warnings.push("no damage scope captured");
  }
  return { ready: blockers.length === 0, blockers, warnings };
}

// Duplicate-new-claim guard: a file that already carries a claim number should
// never open a NEW claim (that's a status follow-up, not a filing). Returns a
// blocker string when the guard trips, otherwise "".
export function existingClaimBlock(claimNumber, goal) {
  const existing = cleanClaimNumber(String(claimNumber || "").replace(/^missing.*/i, ""));
  if (goal === "file_new_claim" && existing) {
    return `file already has claim # ${existing} — use goal:"status_follow_up", not a new filing`;
  }
  return "";
}
