// Machine-readable carrier filing directory. Keeps the claim-filing pipeline
// deterministic: the file's carrier name maps straight to a filing phone number,
// so no human/Claude lookup is needed per call. Sourced from the carrier dossiers
// in docs/carriers/ (built from real recorded filing calls). Add a carrier here
// when its dossier is confirmed.
const CARRIERS = [
  {
    key: "state farm",
    match: /state\s*farm/i,
    filingPhone: "+18444584300",
    display: "State Farm (fire claims)",
    dossier: "docs/carriers/state-farm.md",
    ivrType: "speech",
    notes: "Speech IVR. 'File a new claim' path. Alt line 866-787-8676."
  },
  {
    key: "allstate",
    match: /allstate/i,
    filingPhone: "+18005478676",
    display: "Allstate (National Catastrophe Team)",
    dossier: "docs/carriers/allstate.md",
    ivrType: "speech",
    notes: "Speech IVR routes to a live rep to open the claim; policy-number verification; injury question = No."
  }
];

// Returns { filingPhone, display, dossier, ... } or null if the carrier has no
// confirmed filing method yet (caller must supply carrierPhone explicitly).
export function lookupCarrier(carrierName) {
  const name = String(carrierName || "").trim();
  if (!name) return null;
  return CARRIERS.find((c) => c.match.test(name)) || null;
}

export function knownCarriers() {
  return CARRIERS.map((c) => ({ display: c.display, filingPhone: c.filingPhone, dossier: c.dossier }));
}
