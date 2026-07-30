import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHcnGoogleGrantStore } from "../auth/hcn-google-grant-store.js";
import {
  HcnConsoleReferenceConfigurationError,
  loadHcnConsoleReferenceConfiguration
} from "../hcn-console/reference-config.js";

const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../", import.meta.url)
);
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "src");
const SERVER_PATH = path.join(SOURCE_ROOT, "server.js");
const AUTHORIZATION_PATH = path.join(
  SOURCE_ROOT,
  "auth",
  "google-user.js"
);
const CAPABILITIES_PATH = path.join(
  SOURCE_ROOT,
  "platform",
  "capabilities.js"
);
const RENDER_PATH = path.join(REPOSITORY_ROOT, "render.yaml");
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, "package.json");
const DOCKERFILE_PATH = path.join(REPOSITORY_ROOT, "Dockerfile");
const DOCKERIGNORE_PATH = path.join(REPOSITORY_ROOT, ".dockerignore");

const LEGACY_ROUTES = Object.freeze([
  "/brain/context",
  "/memory/file-actions",
  "/memory/persistence-check"
]);

const LEGACY_OPENAPI_NAMES = Object.freeze([
  "BrainContextRequest",
  "MemoryFileActionsRequest",
  "MemoryPersistenceCheckRequest",
  "readWaveJobNimbusBrain",
  "readChanceFileActionReceipts",
  "checkRenderMemoryPersistence"
]);

const LEGACY_ENVIRONMENT_PATTERNS = Object.freeze([
  /\bMEMORY_ROOT\b/,
  /\bALLOW_LEGACY_CLIENT_MEMORY_WRITES\b/,
  /\b(?:CHANCE_BRAIN|JOBROLO)_[A-Z0-9_]+\b/,
  /\bOPENAI_OPERATIONAL_MODEL\b/,
  /\bZAI_API_KEY\b/,
  /\bZAI_OPERATIONAL_MODEL\b/,
  /\bOPERATIONAL_LLM_[A-Z0-9_]+\b/,
  /\bQUO_LINE_LINK_STORE_PATH\b/,
  /\bQUO_LINE_CHALLENGE_STORE_PATH\b/
]);

const HCN_SECRET_NAMES = Object.freeze([
  "HCN_REFERENCE_KEY",
  "HCN_GOOGLE_GRANT_KEY",
  "HCN_QUO_LINK_KEY",
  "HCN_THRESHER_STORE_KEY",
  "HCN_THRESHER_REFERENCE_KEY",
  "HCN_THRESHER_SIGNING_KEY"
]);

const HCN_PERSISTENT_PATH_NAMES = Object.freeze([
  "HCN_GOOGLE_GRANT_STORE_PATH",
  "HCN_THRESHER_STORE_PATH",
  "CLAIM_CALL_STORE_PATH",
  "ACTION_BATCH_STORE_PATH",
  "ACTION_APPROVAL_STORE_PATH",
  "HCN_ACTION_RECEIPT_STORE_PATH",
  "OUTBOUND_SEND_STORE_PATH",
  "HCN_QUO_LINE_STORE_PATH",
  "AUTO_ENROLLED_USER_STORE_PATH"
]);

test("deployable HCN JavaScript cannot import quarantined memory modules", () => {
  const violations = [];

  for (const filePath of deployableJavaScriptFiles()) {
    const source = readFileSync(filePath, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (isMemoryModuleSpecifier(specifier)) {
        violations.push(
          `${path.relative(REPOSITORY_ROOT, filePath)} -> ${specifier}`
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `deployable source imports quarantined memory modules:\n${violations.join("\n")}`
  );
});

test("legacy Brain and memory routes are absent from executable API surfaces", () => {
  const executableSources = new Map([
    ["server", readFileSync(SERVER_PATH, "utf8")],
    ["authorization", readFileSync(AUTHORIZATION_PATH, "utf8")],
    ["capabilities", readFileSync(CAPABILITIES_PATH, "utf8")]
  ]);

  for (const [label, source] of executableSources) {
    for (const route of LEGACY_ROUTES) {
      assert.equal(
        source.includes(route),
        false,
        `${label} still exposes legacy route ${route}`
      );
    }
  }

  const server = executableSources.get("server");
  for (const name of LEGACY_OPENAPI_NAMES) {
    assert.equal(
      server.includes(name),
      false,
      `server OpenAPI still exposes legacy operation/schema ${name}`
    );
  }
});

test("server, Render, and package surfaces contain no legacy root or credential environment names", () => {
  const packageManifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  const inspectedSources = new Map([
    ["server.js", readFileSync(SERVER_PATH, "utf8")],
    ["render.yaml", readFileSync(RENDER_PATH, "utf8")],
    ["package.json", JSON.stringify(packageManifest)]
  ]);

  for (const [label, source] of inspectedSources) {
    for (const pattern of LEGACY_ENVIRONMENT_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${label} contains a legacy root or credential environment name`
      );
    }
  }

  const scripts = packageManifest.scripts || {};
  assert.equal(
    Object.hasOwn(scripts, "memory"),
    false,
    "package.json must not expose the legacy memory CLI"
  );
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(
      String(command),
      /(?:^|[\\/])src[\\/]memory(?:[\\/]|$)/,
      `package script ${name} includes quarantined memory code`
    );
  }
});

test("Docker build context and recipe exclude quarantined memory code and data", () => {
  const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
  const ignoreRules = dockerIgnoreRules(
    readFileSync(DOCKERIGNORE_PATH, "utf8")
  );

  for (const requiredRule of [
    "src/memory/",
    "memory/",
    "data/memory/"
  ]) {
    assert.equal(
      ignoreRules.includes(requiredRule),
      true,
      `.dockerignore is missing ${requiredRule}`
    );
  }

  assert.equal(
    ignoreRules.some((rule) => rule.startsWith("!")),
    false,
    "Docker ignore negations require a fresh isolation review"
  );
  assert.doesNotMatch(
    dockerfile,
    /(?:^|[\\/\s])(?:src[\\/]memory|data[\\/]memory|memory[\\/])(?:[\\/\s]|$)/m,
    "Dockerfile explicitly copies quarantined memory content"
  );
  assert.match(
    dockerfile,
    /^\s*COPY\s+src\s+\.\/src\s*$/m,
    "the reviewed Docker recipe must copy src through the guarded build context"
  );
});

test("Render assigns distinct HCN roots, paths, and secret names", () => {
  const manifest = readFileSync(RENDER_PATH, "utf8");
  const environment = parseRenderEnvironment(manifest);
  const operationsRoot = requiredRenderValue(
    environment,
    "HCN_OPERATIONS_ROOT"
  );
  const thresherStore = requiredRenderValue(
    environment,
    "HCN_THRESHER_STORE_PATH"
  );
  const diskMount = requiredManifestCapture(
    manifest,
    /^\s+mountPath:\s+(\S+)\s*$/m,
    "Render disk mountPath"
  );
  const diskName = requiredManifestCapture(
    manifest,
    /^\s+name:\s+(hcn-operations-data)\s*$/m,
    "HCN disk name"
  );

  assert.equal(diskName, "hcn-operations-data");
  assert.equal(operationsRoot, "/var/data/hcn-operations");
  assert.equal(diskMount, operationsRoot);
  assert.notEqual(operationsRoot, "/var/data");
  assert.equal(
    isPosixDescendant(operationsRoot, thresherStore),
    true,
    "Thresher store must resolve beneath HCN_OPERATIONS_ROOT"
  );
  assert.equal(
    thresherStore.startsWith(`${operationsRoot}/thresher/`),
    true,
    "Thresher state must use its dedicated HCN subtree"
  );

  for (const name of HCN_PERSISTENT_PATH_NAMES) {
    const storePath = requiredRenderValue(environment, name);
    assert.equal(
      isPosixDescendant(operationsRoot, storePath),
      true,
      `${name} must resolve beneath HCN_OPERATIONS_ROOT`
    );
    if (name !== "HCN_THRESHER_STORE_PATH") {
      assert.equal(
        storePath.startsWith(`${operationsRoot}/platform/`),
        true,
        `${name} must stay in the HCN platform subtree`
      );
      assert.notEqual(
        storePath,
        thresherStore,
        `${name} cannot share the Thresher state file`
      );
    }
  }

  assert.equal(
    new Set(HCN_SECRET_NAMES).size,
    HCN_SECRET_NAMES.length,
    "HCN secret environment names must be unique"
  );
  for (const name of HCN_SECRET_NAMES) {
    const entry = requiredRenderEntry(environment, name);
    assert.equal(
      entry.sync,
      "false",
      `${name} must be supplied by the production secret manager`
    );
    assert.equal(
      entry.value,
      undefined,
      `${name} must not contain a checked-in value`
    );
  }
});

test("wired HCN storage and isolated Thresher key loaders fail closed", () => {
  const server = readFileSync(SERVER_PATH, "utf8");
  const storageGuard = sourceSection(
    server,
    "function hcnOperationsStorageConfigured()",
    "function hcnGoogleGrantStoreConfigured()"
  );
  const googleGrantGuard = sourceSection(
    server,
    "function hcnGoogleGrantStoreConfigured()",
    "function hcnGoogleGrantStore()"
  );

  assert.match(storageGuard, /!HCN_OPERATIONS_ROOT/);
  assert.match(storageGuard, /!HCN_OPERATIONS_DATA_DIR/);
  assert.match(storageGuard, /!path\.isAbsolute\(HCN_OPERATIONS_ROOT\)/);
  assert.match(storageGuard, /path\.resolve\(HCN_OPERATIONS_ROOT\)/);
  assert.match(storageGuard, /hcnRoot === path\.parse\(hcnRoot\)\.root/);
  assert.match(storageGuard, /hcnRoot === path\.resolve\("\/var\/data"\)/);
  assert.match(storageGuard, /resolved\.startsWith\(`\$\{hcnRoot\}\$\{path\.sep\}`\)/);
  assert.match(
    googleGrantGuard,
    /!hcnOperationsStorageConfigured\(\)/
  );
  assert.match(googleGrantGuard, /!HCN_GOOGLE_GRANT_KEY/);
  assert.match(googleGrantGuard, /HCN_REFERENCE_CONFIGURATION\.ready !== true/);

  const missingReferenceConfiguration =
    loadHcnConsoleReferenceConfiguration({});
  assert.equal(missingReferenceConfiguration.ready, false);
  assert.throws(
    () => missingReferenceConfiguration.requireFactory(),
    (error) =>
      error instanceof HcnConsoleReferenceConfigurationError
      && error.statusCode === 503
  );

  assert.throws(
    () => createHcnGoogleGrantStore({
      filePath: path.join(REPOSITORY_ROOT, ".isolation-test-never-created"),
      encryptionKey: ""
    })
  );

  assert.match(server, /loadThresherRuntimeConfiguration/);
  assert.match(server, /HCN_THRESHER_CONFIGURATION/);
  assert.match(server, /projectThresherRuntimeConfiguration/);
  assert.match(server, /HCN_THRESHER_STORE_PATH/);
});

function deployableJavaScriptFiles() {
  const files = [];
  visit(SOURCE_ROOT);
  return files.sort();

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path
        .relative(SOURCE_ROOT, entryPath)
        .split(path.sep)
        .join("/");
      if (
        entry.isDirectory()
        && (relative === "memory" || relative.startsWith("memory/"))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (/\.(?:c|m)?js$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function isMemoryModuleSpecifier(specifier) {
  const normalized = String(specifier).replaceAll("\\", "/");
  return normalized.split("/").includes("memory");
}

function dockerIgnoreRules(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseRenderEnvironment(source) {
  const entries = new Map();
  let current = null;

  for (const line of source.split(/\r?\n/)) {
    const keyMatch = line.match(/^\s*-\s+key:\s+([A-Z0-9_]+)\s*$/);
    if (keyMatch) {
      current = {};
      entries.set(keyMatch[1], current);
      continue;
    }
    if (!current) continue;

    const valueMatch = line.match(
      /^\s+value:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/
    );
    if (valueMatch) {
      current.value =
        valueMatch[1] ?? valueMatch[2] ?? valueMatch[3] ?? "";
      continue;
    }

    const syncMatch = line.match(/^\s+sync:\s+(true|false)\s*$/);
    if (syncMatch) current.sync = syncMatch[1];
  }

  return entries;
}

function requiredRenderEntry(environment, name) {
  const entry = environment.get(name);
  assert.ok(entry, `render.yaml is missing ${name}`);
  return entry;
}

function requiredRenderValue(environment, name) {
  const entry = requiredRenderEntry(environment, name);
  assert.equal(
    typeof entry.value,
    "string",
    `render.yaml ${name} requires an explicit value`
  );
  return entry.value;
}

function requiredManifestCapture(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[1];
}

function isPosixDescendant(root, candidate) {
  const relative = path.posix.relative(
    path.posix.resolve(root),
    path.posix.resolve(candidate)
  );
  return Boolean(
    relative
    && relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative)
  );
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
