// Explicitly approved, two-variable release migration. No credential output,
// provider document writes, roster changes, or automatic deployment.
import { execFileSync } from "node:child_process";
import { deepStrictEqual } from "node:assert";
import { loadChanceOperatorRunManifest } from "../src/operations/thresher-policy.js";
import { CHANCE_LEGACY_ISOLATION_ENTRIES } from "../integrations/jobnimbus-operator/mcp/scope.mjs";

const serviceId = "srv-d9410cpo3t8c73a06dag";
const priorSha = "08490f603cf1c6d451e49f9cf4a195d8ca52b2253e06e2572b08a82a3a43ab1d";
const keys = ["CHANCE_OPERATOR_RUN_MANIFEST_JSON", "CHANCE_OPERATOR_LEGACY_ISOLATION_JSON"];
const mode = process.argv[2] || "preview";
if (!["preview", "activate"].includes(mode)) throw new Error("Use preview or activate.");
const credential = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
  'x=YAML.load_file("/Users/chancepearson/.render/cli.yaml"); puts JSON.generate({key:x.fetch("api").fetch("key")})'],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
if (typeof credential.key !== "string" || !credential.key) throw new Error("Render CLI authentication unavailable.");
async function request(key, method = "GET", value) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${key}`, {
    method, headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
    redirect: "error", signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Render ${method} ${key}: HTTP ${response.status}`);
  const data = await response.json();
  const found = data.value ?? data.envVar?.value;
  if (typeof found !== "string") throw new Error(`Render ${key}: expected value missing.`);
  return found;
}
const originals = await Promise.all(keys.map(key => request(key)));
const priorInput = JSON.parse(originals[0]);
const prior = loadChanceOperatorRunManifest(priorInput);
if (prior.id !== "chance-58-files-notes-v1" || prior.sha256 !== priorSha) {
  throw new Error("Live policy differs from the reviewed notes predecessor. Stop for review.");
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
const nextInput = { ...priorInput, id: "chance-58-files-pdf-v1",
  allowedActionTypes: [...priorInput.allowedActionTypes, "jobnimbus.upload_pdf"] };
const next = loadChanceOperatorRunManifest(nextInput);
const nextIsolation = { ...isolation, runPolicyId: next.id, runPolicySha256: next.sha256 };
const updates = [JSON.stringify(nextInput), JSON.stringify(nextIsolation)];
const summary = { serviceId, mode, priorPolicySha256: prior.sha256, policyId: next.id,
  policySha256: next.sha256, fileCount: next.fileCount, excludedFileNumbers: next.excludedFileNumbers,
  expiresAt: next.expiresAt, isolationEntryCount: nextIsolation.entries.length,
  immutableFingerprintsVerified: true, addedAction: "jobnimbus.upload_pdf" };
if (mode === "activate") {
  if (process.argv[3] !== next.sha256) throw new Error("Activation requires the reviewed preview hash argument.");
  for (let i = 0; i < keys.length; i++) {
    if (await request(keys[i]) !== originals[i]) throw new Error("Concurrent policy change detected. No activation performed.");
  }
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
    // Restore only this attempt's exact writes. Do not overwrite concurrent edits.
    // No deployment or provider upload has been made by this helper.
    for (let i = attempted - 1; i >= 0; i--) {
      if (await request(keys[i]) === updates[i]) await request(keys[i], "PUT", originals[i]);
    }
    throw error;
  }
  summary.savedAndVerified = true;
  summary.deploymentStillRequired = true;
}
console.log(JSON.stringify(summary));
