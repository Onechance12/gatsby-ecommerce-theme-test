// Canonical, machine-readable carrier filing directory for the portable claim
// core. Data-only + pure functions — no imports, no I/O, no process.env — so the
// Render bridge can copy this file verbatim. The file's carrier name maps
// straight to a filing phone number and its policy-number requirement, keeping
// the filing pipeline deterministic (no per-call human/LLM lookup).
//
// Sourced from the carrier dossiers in docs/carriers/ (built from real recorded
// filing calls). Add a carrier here when its dossier is confirmed.
//
// requiresPolicyNumber (default false): when true, a missing policy number HARD
// BLOCKS a new filing because this carrier cannot locate coverage any other way.
// When false, the Wave playbook lets the carrier locate coverage by insured
// name + property address + phone, so a missing policy number is only a warning.
const CARRIERS = [
  {
    key: "state farm",
    match: /state\s*farm/i,
    filingPhone: "+18444584300",
    display: "State Farm (fire claims)",
    dossier: "docs/carriers/state-farm.md",
    ivrType: "speech",
    requiresPolicyNumber: false,
    notes: "Speech IVR. 'File a new claim' path. Alt line 866-787-8676."
  },
  {
    key: "allstate",
    match: /allstate/i,
    filingPhone: "+18005478676",
    display: "Allstate (National Catastrophe Team)",
    dossier: "docs/carriers/allstate.md",
    ivrType: "speech",
    requiresPolicyNumber: false,
    notes: "Speech IVR routes to a live rep to open the claim; policy-number verification; injury question = No."
  },
  {
    key: "national general",
    match: /national\s+general/i,
    filingPhone: "+18003251088",
    display: "National General (homeowners claims)",
    dossier: "docs/carriers/national-general.md",
    ivrType: "dtmf",
    requiresPolicyNumber: false,
    notes: "Verified by National General callback on 2026-07-10. Lender services is 800-211-4533; homeowners claims is 800-325-1088."
  }
];

// Returns the matching carrier record (with requiresPolicyNumber) or null if the
// carrier has no confirmed filing method yet (caller must supply carrierPhone).
export function lookupCarrier(carrierName) {
  const name = String(carrierName || "").trim();
  if (!name) return null;
  return CARRIERS.find((c) => c.match.test(name)) || null;
}

export function knownCarriers() {
  return CARRIERS.map((c) => ({
    display: c.display,
    filingPhone: c.filingPhone,
    dossier: c.dossier,
    requiresPolicyNumber: Boolean(c.requiresPolicyNumber)
  }));
}
