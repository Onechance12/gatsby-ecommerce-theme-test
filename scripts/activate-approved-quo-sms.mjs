// Explicitly approved, two-variable Quo SMS release migration. No credential
// output, provider message, roster change, or automatic deployment.
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";

import {
  CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES,
  loadChanceOperatorRunManifest
} from "../src/operations/thresher-policy.js";
import { CHANCE_LEGACY_ISOLATION_ENTRIES } from "../integrations/jobnimbus-operator/mcp/scope.mjs";

const serviceId = "srv-d9410cpo3t8c73a06dag";
const priorSha = "20662ee280750145517fc0544280d7279233121917b3a5b35dcec9389c70a775";
const keys = ["CHANCE_OPERATOR_RUN_MANIFEST_JSON", "CHANCE_OPERATOR_LEGACY_ISOLATION_JSON"];
const mode = process.argv[2] || "preview";
if (!["preview", "activate"].includes(mode)) throw new Error("Use preview or activate.");

const credential = JSON.parse(execFileSync("ruby", [
  "-ryaml",
  "-rjson",
  "-e",
  'x=YAML.load_file("/Users/chancepearson/.render/cli.yaml"); puts JSON.generate({key:x.fetch("api").fetch("key")})'
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
if (typeof credential.key !== "string" || !credential.key) {
  throw new Error("Render CLI authentication unavailable.");
}

async function request(key, method = "GET", value) {
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${key}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential.key}`,
      "Content-Type": "application/json"
    },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Render ${method} ${key}: HTTP ${response.status}`);
  const data = await response.json();
  const found = data.value ?? data.envVar?.value;
  if (typeof found !== "string") throw new Error(`Render ${key}: expected value missing.`);
  return found;
}

const originals = [];
for (const key of keys) originals.push(await request(key));
const priorInput = JSON.parse(originals[0]);
const prior = loadChanceOperatorRunManifest(priorInput);
if (prior.id !== "chance-58-files-pdf-v1" || prior.sha256 !== priorSha) {
  throw new Error("Live policy differs from the reviewed PDF predecessor. Stop for review.");
}

const isolation = JSON.parse(originals[1]);
if (
  isolation.runPolicyId !== prior.id
  || isolation.runPolicySha256 !== prior.sha256
  || isolation.id !== "chance-58-prelock-receipts-v1"
  || isolation.entries?.length !== 6
) {
  throw new Error("Historical isolation differs from the reviewed policy. Stop for review.");
}
const fingerprints = (rows) => rows
  .map(({ batchId, rawRowSha256 }) => ({ batchId, rawRowSha256 }))
  .sort((left, right) => left.batchId.localeCompare(right.batchId));
deepStrictEqual(
  fingerprints(isolation.entries),
  fingerprints(CHANCE_LEGACY_ISOLATION_ENTRIES),
  "Historical receipt fingerprints do not match the immutable reviewed six entries."
);

const nextInput = {
  ...priorInput,
  id: "chance-58-files-sms-v1",
  allowedActionTypes: [...priorInput.allowedActionTypes, "quo.send_text"]
};
const next = loadChanceOperatorRunManifest(nextInput);
deepStrictEqual(next.allowedActionTypes, CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES);
deepStrictEqual(next.files, prior.files, "The 58-file roster changed during SMS migration.");
deepStrictEqual(next.excludedFileNumbers, prior.excludedFileNumbers);
deepStrictEqual(next.allowedContactFields, prior.allowedContactFields);
deepStrictEqual(next.allowedStageEvidenceSources, prior.allowedStageEvidenceSources);
if (
  next.fileCount !== 58
  || next.operatorScope !== prior.operatorScope
  || next.expiresAt !== prior.expiresAt
) {
  throw new Error("The SMS migration changed a protected manifest boundary.");
}

const nextIsolation = {
  ...isolation,
  runPolicyId: next.id,
  runPolicySha256: next.sha256
};
const updates = [JSON.stringify(nextInput), JSON.stringify(nextIsolation)];
const summary = {
  serviceId,
  mode,
  priorPolicySha256: prior.sha256,
  policyId: next.id,
  policySha256: next.sha256,
  fileCount: next.fileCount,
  excludedFileNumbers: next.excludedFileNumbers,
  expiresAt: next.expiresAt,
  isolationEntryCount: nextIsolation.entries.length,
  immutableFingerprintsVerified: true,
  unchangedRosterVerified: true,
  addedAction: "quo.send_text",
  genericQuoGateChangeRequired: false
};

if (mode === "activate") {
  if (process.argv[3] !== next.sha256) {
    throw new Error("Activation requires the reviewed preview hash argument.");
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (await request(keys[index]) !== originals[index]) {
      throw new Error("Concurrent policy change detected. No activation performed.");
    }
  }
  let attempted = 0;
  try {
    for (let index = 0; index < keys.length; index += 1) {
      attempted = index + 1;
      await request(keys[index], "PUT", updates[index]);
    }
    for (let index = 0; index < keys.length; index += 1) {
      if (await request(keys[index]) !== updates[index]) {
        throw new Error("Saved policy readback did not match.");
      }
    }
  } catch (error) {
    // Restore only this attempt's exact writes. Never overwrite concurrent edits.
    for (let index = attempted - 1; index >= 0; index -= 1) {
      if (await request(keys[index]) === updates[index]) {
        await request(keys[index], "PUT", originals[index]);
      }
    }
    throw error;
  }
  summary.savedAndVerified = true;
  summary.deploymentStillRequired = true;
}

console.log(JSON.stringify(summary));
