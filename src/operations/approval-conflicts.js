import { createHash } from "node:crypto";

// Input is a SERVER-RESOLVED scope, never caller-supplied file or action hints.
// Unknown/legacy scopes keep conservative global supersession. Only the Mac
// assigned lane opts in; no HCN console/company authorization changes.
export function approvalConflictKeys(scope, kind) {
  if (!scope?.runPolicyId || !scope?.runPolicySha256 || !Array.isArray(scope.files)
    || !scope.files.length || scope.files.length > 5) return null;
  const keys = [];
  for (const file of scope.files) {
    if (!file.id || !Array.isArray(file.operationTypes) || !file.operationTypes.length) return null;
    for (const type of file.operationTypes) {
      if (typeof type !== "string" || !type) return null;
      keys.push(createHash("sha256").update(JSON.stringify([
        "approval-conflict-v1", String(file.id), kind, type
      ])).digest("hex"));
    }
  }
  return [...new Set(keys)].sort();
}

export function approvalScopesConflict(previous, current) {
  if (!Array.isArray(previous) || !previous.length || !Array.isArray(current) || !current.length) return true;
  return previous.some(key => current.includes(key));
}
