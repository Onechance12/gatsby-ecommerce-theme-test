// Operator-only release helper. Reads only the two policy variables below;
// never enumerates Render secrets or writes credentials to disk/stdout.
import { execFileSync } from "node:child_process";
import { loadChanceOperatorRunManifest } from "../src/operations/thresher-policy.js";

const serviceId = "srv-d9410cpo3t8c73a06dag";
const priorSha = "40c8a7d418d9349b0b3315b693ce70486040092dcef250043f3397dc10a1c458";
const keys = ["CHANCE_OPERATOR_RUN_MANIFEST_JSON", "CHANCE_OPERATOR_LEGACY_ISOLATION_JSON"];
const mode = process.argv[2] || "preview";
if (!["preview", "activate"].includes(mode)) throw new Error("Use preview or activate.");
const credential = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
  'x=YAML.load_file("/Users/chancepearson/.render/cli.yaml"); puts JSON.generate({key:x.fetch("api").fetch("key")})'], { encoding: "utf8" }));
if (typeof credential.key !== "string" || !credential.key) throw new Error("Render CLI authentication unavailable.");
async function request(key, method = "GET", value) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${key}`, {
    method, headers: { Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
    signal: AbortSignal.timeout(20000)
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
if (prior.id !== "chance-58-files-v1" || prior.sha256 !== priorSha) throw new Error("Live policy differs from reviewed predecessor. Stop for review.");
const isolation = JSON.parse(originals[1]);
if (isolation.runPolicyId !== prior.id || isolation.runPolicySha256 !== prior.sha256
  || isolation.id !== "chance-58-prelock-receipts-v1" || isolation.entries?.length !== 6) {
  throw new Error("Historical isolation differs from reviewed policy. Stop for review.");
}
const nextInput = { ...priorInput, id: "chance-58-files-notes-v1", allowedActionTypes: [...priorInput.allowedActionTypes, "jobnimbus.create_note"] };
const next = loadChanceOperatorRunManifest(nextInput);
const nextIsolation = { ...isolation, runPolicyId: next.id, runPolicySha256: next.sha256 };
const updates = [JSON.stringify(nextInput), JSON.stringify(nextIsolation)];
const summary = { serviceId, mode, priorPolicySha256: prior.sha256, policyId: next.id,
  policySha256: next.sha256, fileCount: next.fileCount, excludedFileNumbers: next.excludedFileNumbers,
  expiresAt: next.expiresAt, isolationEntryCount: nextIsolation.entries.length };
if (mode === "activate") {
  if (process.argv[3] !== next.sha256) throw new Error("Activation requires the reviewed preview hash argument.");
  // Prevent overwriting a policy change made after the initial read.
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
    // Restore only our exact writes, never overwrite a concurrent edit.
    for (let i = attempted - 1; i >= 0; i--) {
      if (await request(keys[i]) === updates[i]) await request(keys[i], "PUT", originals[i]);
    }
    throw error;
  }
  summary.savedAndVerified = true;
  summary.deploymentStillRequired = true;
}
console.log(JSON.stringify(summary));
