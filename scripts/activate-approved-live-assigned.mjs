// Chance explicitly approved the coordinated live-assignment release.
// Only two existing policy variables may change. No credentials/client writes,
// receipt edits, new effect gates, or deployment are performed by this helper.
import { execFileSync } from "node:child_process";
import { deepStrictEqual } from "node:assert";
import { loadChanceOperatorRunManifest } from "../src/operations/thresher-policy.js";
import { CHANCE_LEGACY_ISOLATION_ENTRIES } from "../integrations/jobnimbus-operator/mcp/scope.mjs";

const serviceId = "srv-d9410cpo3t8c73a06dag";
const priorSha = "b6f98d5e06152cd10857a70623c8accc3c60fa74ae4fd88f715b4a33ea856d1f";
const ownerId = "fc95a213f70e4c9daddc5fa366be9941";
const keys = ["CHANCE_OPERATOR_RUN_MANIFEST_JSON", "CHANCE_OPERATOR_LEGACY_ISOLATION_JSON"];
const mode = process.argv[2] || "preview";
if (!["preview", "activate"].includes(mode)) throw new Error("Use preview or activate.");
const credential = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
  'x=YAML.load_file("/Users/chancepearson/.render/cli.yaml"); puts JSON.generate({key:x.fetch("api").fetch("key")})'],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
if (typeof credential.key !== "string" || !credential.key) throw new Error("Render CLI authentication unavailable.");
async function request(key, method = "GET", value, optional = false) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${key}`, {
    method, headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
    redirect: "error", signal: AbortSignal.timeout(20000)
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`Render ${method} ${key}: HTTP ${response.status}`);
  const data = await response.json();
  const found = data.value ?? data.envVar?.value;
  if (typeof found !== "string") throw new Error(`Render ${key}: expected value missing.`);
  return found;
}
const originals = await Promise.all(keys.map(key => request(key)));
// The reviewed server defaults this exact owner when the override is absent;
// both pre-release native attestation and post-release attestation also bind it.
const configuredOwner = async () => (await request("CHANCE_JOBNIMBUS_OWNER_ID", "GET", undefined, true)) || ownerId;
if (await configuredOwner() !== ownerId) {
  throw new Error("The configured owner differs from the reviewed Chance assignment owner.");
}
const priorInput = JSON.parse(originals[0]);
const prior = loadChanceOperatorRunManifest(priorInput);
if (prior.id !== "chance-58-files-sms-v1" || prior.sha256 !== priorSha) {
  throw new Error("Live policy differs from the reviewed SMS predecessor. Stop for review.");
}
const isolation = JSON.parse(originals[1]);
if (isolation.runPolicyId !== prior.id || isolation.runPolicySha256 !== prior.sha256
  || isolation.id !== "chance-58-prelock-receipts-v1" || isolation.entries?.length !== 6) {
  throw new Error("Historical isolation differs from the reviewed policy. Stop for review.");
}
const fingerprints = rows => rows.map(({ batchId, rawRowSha256 }) => ({ batchId, rawRowSha256 }))
  .sort((a, b) => a.batchId.localeCompare(b.batchId));
try { deepStrictEqual(fingerprints(isolation.entries), fingerprints(CHANCE_LEGACY_ISOLATION_ENTRIES)); }
catch { throw new Error("Historical receipt fingerprints do not match the immutable reviewed six entries."); }
const nextInput = {
  schemaVersion: 2, id: "chance-live-assigned-sms-v1", operatorScope: "assigned",
  assignmentMode: "live_assigned", assignmentOwnerId: ownerId,
  expiresAt: priorInput.expiresAt, excludedFileNumbers: priorInput.excludedFileNumbers,
  allowedActionTypes: priorInput.allowedActionTypes, allowedContactFields: priorInput.allowedContactFields,
  receiptPredecessor: priorInput
};
const next = loadChanceOperatorRunManifest(nextInput);
deepStrictEqual(next.allowedActionTypes, prior.allowedActionTypes);
deepStrictEqual(next.allowedContactFields, prior.allowedContactFields);
deepStrictEqual(next.excludedFileNumbers, prior.excludedFileNumbers);
if (next.receiptPredecessor.sha256 !== prior.sha256 || next.expiresAt !== prior.expiresAt
  || next.fileCount !== null) throw new Error("The migration changed an unapproved boundary.");
const nextIsolation = { ...isolation, runPolicyId: next.id, runPolicySha256: next.sha256 };
const updates = [JSON.stringify(nextInput), JSON.stringify(nextIsolation)];
const summary = { serviceId, mode, priorPolicySha256: prior.sha256, policyId: next.id,
  policySha256: next.sha256, schemaVersion: next.schemaVersion,
  assignmentMode: next.assignmentMode, assignmentOwnerId: next.assignmentOwnerId,
  fileCount: next.fileCount, excludedFileNumbers: next.excludedFileNumbers,
  expiresAt: next.expiresAt, isolationEntryCount: nextIsolation.entries.length,
  immutableFingerprintsVerified: true, receiptPredecessorPreserved: true,
  actionAndFieldAllowlistsUnchanged: true };
if (mode === "activate") {
  if (process.argv[3] !== next.sha256) throw new Error("Activation requires the reviewed preview hash argument.");
  for (let i = 0; i < keys.length; i++) {
    if (await request(keys[i]) !== originals[i]) throw new Error("Concurrent policy change detected. No activation performed.");
  }
  if (await configuredOwner() !== ownerId) throw new Error("Assignment owner changed before activation.");
  let attempted = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
      attempted = i + 1;
      await request(keys[i], "PUT", updates[i]);
    }
    for (let i = 0; i < keys.length; i++) {
      if (await request(keys[i]) !== updates[i]) throw new Error("Saved policy readback did not match.");
    }
  } catch (error) {
    // Restore only this attempt's exact writes; never overwrite concurrent edits.
    for (let i = attempted - 1; i >= 0; i--) {
      if (await request(keys[i]) === updates[i]) await request(keys[i], "PUT", originals[i]);
    }
    throw error;
  }
  summary.savedAndVerified = true;
  summary.deploymentStillRequired = true;
}
console.log(JSON.stringify(summary));
