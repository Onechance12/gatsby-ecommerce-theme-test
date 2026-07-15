// The canonical input contract for the portable claim core. Pure + dependency
// free. The caller (local CLI wrapper or the Render bridge adapter) is
// responsible for resolving ONE live Chance file from JobNimbus and shaping it
// to this contract; the core never reads JobNimbus, the filesystem, or env.
//
// Shape (all fields optional; normalizeClaimFileInput fills safe defaults):
//   {
//     file: {
//       id, customer, address, carrier, policyNumber, claimNumber, dateOfLoss,
//       typeOfLoss, status, mortgageCompany,
//       contact: { <raw JobNimbus contact fields for phone/email> },
//       adjuster: { name, phone, email }
//     },
//     evidence: {                     // free-text signals for damage/cause
//       categories: [string],
//       recommendedNextAction: string,
//       bottleneck: string,
//       documents: [{ name }],
//       notes: [{ body }],
//       tasks: [{ title }]            // carried for the adapter; not used by packet math
//     },
//     captured: { stormTime, occupancy, damageDiscovered },   // inspection capture
//     overrides: {                    // approved per-call answers/goal
//       goal, carrierPhone,
//       injuries, homeLivable, temporaryRepairs, contractorHired,
//       occupancy, damageDiscovered, stormTime, damageOpening, damageDetails
//     }
//   }
export function normalizeClaimFileInput(raw = {}) {
  const file = raw.file || {};
  const evidence = raw.evidence || {};
  const captured = raw.captured || {};
  const overrides = raw.overrides || {};
  return {
    file: {
      id: file.id || "",
      customer: file.customer || "",
      address: file.address || "",
      carrier: file.carrier || "",
      policyNumber: file.policyNumber || "",
      claimNumber: file.claimNumber || "",
      dateOfLoss: file.dateOfLoss || "",
      typeOfLoss: file.typeOfLoss || "",
      status: file.status || "",
      mortgageCompany: file.mortgageCompany || "",
      contact: file.contact || file.source?.contact || {},
      adjuster: file.adjuster || {},
      // documents/notes may be attached to the file itself as well as evidence
      documents: file.documents || [],
      notes: file.notes || []
    },
    evidence: {
      categories: evidence.categories || [],
      recommendedNextAction: evidence.recommendedNextAction || "",
      bottleneck: evidence.bottleneck || "",
      // Documents/notes may live on the file record OR here; the damage/cause
      // inference MERGES both (see standardAnswers.js), so keep these distinct
      // rather than copying file.* in — copying would double-count the same items.
      documents: evidence.documents || [],
      notes: evidence.notes || [],
      tasks: evidence.tasks || []
    },
    captured: {
      stormTime: captured.stormTime || "",
      occupancy: captured.occupancy || "",
      damageDiscovered: captured.damageDiscovered || ""
    },
    overrides: { ...overrides }
  };
}
