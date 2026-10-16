// INACTIVE candidate. Activation requires a separately reviewed coordinated
// bridge commit, manifest and installed Operator package pin. No runtime override.
export const QUO_SMS_RELEASE = Object.freeze({
  enabled: false,
  policyId: "chance-58-files-sms-v1",
  policySha256: "",
  bridgeCommit: ""
});

export function validateQuoSmsRelease(release) {
  if (release?.enabled === false) return false;
  if (
    release?.enabled !== true
    || !["chance-58-files-sms-v1", "chance-live-assigned-sms-v1"].includes(release.policyId)
    || !/^[a-f0-9]{64}$/.test(release.policySha256 || "")
    || !/^[a-f0-9]{40}$/.test(release.bridgeCommit || "")
  ) {
    throw new Error("Quo SMS requires reviewed exact release pins; automatic activation is forbidden.");
  }
  if (release.policyId === "chance-live-assigned-sms-v1"
    && (release.assignmentMode !== "live_assigned"
      || !/^[a-zA-Z0-9_-]{8,100}$/.test(release.assignmentOwnerId || ""))) {
    throw new Error("Live-assigned SMS requires the separately reviewed exact owner and assignment-mode pins.");
  }
  if (release.policyId === "chance-58-files-sms-v1"
    && (release.assignmentMode || release.assignmentOwnerId)) {
    throw new Error("The fixed-file SMS release cannot silently acquire live-assignment scope.");
  }
  return true;
}

export const QUO_SMS_ENABLED = validateQuoSmsRelease(QUO_SMS_RELEASE);
