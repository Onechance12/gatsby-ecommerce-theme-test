// INACTIVE candidate. A new versioned native release must pin the deployed
// bridge and unchanged live-assigned policy. No environment/runtime override.
export const PDF_RECEIPT_RESOLUTION_RELEASE = Object.freeze({
  enabled: false, bridgeCommit: "", policyId: "chance-live-assigned-sms-v1", policySha256: ""
});

export function pdfReceiptResolutionEnabled(build, policy) {
  return validatePdfReceiptResolutionRelease(PDF_RECEIPT_RESOLUTION_RELEASE, build, policy);
}

export function validatePdfReceiptResolutionRelease(release, build, policy) {
  if (release.enabled === false) return false;
  if (release.enabled !== true || !/^[a-f0-9]{40}$/.test(release.bridgeCommit)
    || !/^[a-f0-9]{64}$/.test(release.policySha256) || release.policyId !== "chance-live-assigned-sms-v1"
    || build?.sourceCommit !== release.bridgeCommit || policy?.id !== release.policyId || policy?.sha256 !== release.policySha256) {
    throw new Error("PDF receipt resolution requires its separately reviewed exact native build/policy pins.");
  }
  return true;
}
