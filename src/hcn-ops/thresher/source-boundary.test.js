import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const allowedImports = new Set([
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "./contracts.js",
  "./runtime-config.js",
  "./store.js"
]);

test("production Thresher modules have a closed source boundary", async () => {
  const entries = await readdir(directory, { withFileTypes: true });
  const productionFiles = entries
    .filter(
      (entry) =>
        entry.isFile()
        && entry.name.endsWith(".js")
        && !entry.name.endsWith(".test.js")
    )
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(productionFiles, [
    "contracts.js",
    "index.js",
    "runtime-config.js",
    "store.js"
  ]);

  for (const file of productionFiles) {
    const source = await readFile(path.join(directory, file), "utf8");
    const imports = [
      ...source.matchAll(
        /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g
      )
    ].map((match) => match[1]);
    for (const dependency of imports) {
      assert.equal(
        allowedImports.has(dependency),
        true,
        `${file} imports forbidden dependency ${dependency}`
      );
      assert.equal(
        dependency.startsWith("../"),
        false,
        `${file} crosses the isolated Thresher directory boundary`
      );
    }

    for (const forbidden of [
      "src/memory",
      "../memory",
      "chance-brain",
      "chance_brain",
      "jobrolo",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dns",
      "WebSocket",
      "process.env",
      "globalThis.fetch",
      "fetch("
    ]) {
      assert.equal(
        source.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `${file} contains forbidden boundary token ${forbidden}`
      );
    }
  }
});

test("integration contract keeps persistence disabled until activation review", async () => {
  const contract = await readFile(
    path.join(directory, "INTEGRATION.md"),
    "utf8"
  );
  assert.match(contract, /HCN_THRESHER_STORE_PATH/);
  assert.match(contract, /HCN_THRESHER_STORE_KEY/);
  assert.match(contract, /HCN_THRESHER_REFERENCE_KEY/);
  assert.match(contract, /HCN_THRESHER_SIGNING_KEY/);
  assert.match(contract, /persistenceConfigured: false/);
  assert.match(contract, /executes no external action/);
});
