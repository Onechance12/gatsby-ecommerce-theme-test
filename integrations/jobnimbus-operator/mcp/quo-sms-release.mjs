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
    || release.policyId !== "chance-58-files-sms-v1"
    || !/^[a-f0-9]{64}$/.test(release.policySha256 || "")
    || !/^[a-f0-9]{40}$/.test(release.bridgeCommit || "")
  ) {
    throw new Error("Quo SMS requires reviewed exact release pins; automatic activation is forbidden.");
  }
  return true;
}

export const QUO_SMS_ENABLED = validateQuoSmsRelease(QUO_SMS_RELEASE);
