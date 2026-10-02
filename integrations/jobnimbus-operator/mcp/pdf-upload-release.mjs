// INACTIVE candidate. Activation requires a separately reviewed coordinated
// bridge commit, manifest and legacy-isolation migration. No runtime override.
export const PDF_UPLOAD_RELEASE = Object.freeze({
  enabled: false,
  policyId: "chance-58-files-pdf-v1",
  policySha256: "",
  bridgeCommit: ""
});

export function validatePdfRelease(release) {
  if (release?.enabled === false) return false;
  if (release?.enabled !== true || release.policyId !== "chance-58-files-pdf-v1"
    || !/^[a-f0-9]{64}$/.test(release.policySha256 || "")
    || !/^[a-f0-9]{40}$/.test(release.bridgeCommit || "")) {
    throw new Error("PDF upload requires reviewed exact release pins; automatic activation is forbidden.");
  }
  return true;
}
export const PDF_UPLOADS_ENABLED = validatePdfRelease(PDF_UPLOAD_RELEASE);
