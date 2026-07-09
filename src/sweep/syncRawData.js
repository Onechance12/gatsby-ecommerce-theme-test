import path from "node:path";
import { readJson, writeJson } from "../lib/io.js";
import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";

export async function syncRawData(config) {
  const syncStartedAt = new Date().toISOString();
  const { raw, resources } = config.useFixtures
    ? syncFromFixtures(config)
    : await syncFromApi(config);

  for (const [name, value] of Object.entries(raw)) {
    writeJson(path.join(config.paths.rawDir, `${name}.json`), value);
  }

  writeJson(path.join(config.paths.rawDir, "sync-meta.json"), {
    syncedAt: syncStartedAt,
    completedAt: new Date().toISOString(),
    mode: config.useFixtures ? "fixture" : "live API",
    readOnly: true,
    pageSize: config.pageSize,
    maxOffset: config.maxOffset,
    resultWindowLimit: config.resultWindowLimit,
    complete: Object.values(resources).every((resource) => resource.complete !== false),
    resources
  });

  return raw;
}

function syncFromFixtures(config) {
  const raw = readJson(config.paths.fixture);
  const resources = {};

  for (const [name, value] of Object.entries(raw)) {
    resources[name] = {
      name,
      endpoint: "fixture",
      fetched: Array.isArray(value) ? value.length : 1,
      complete: true,
      stoppedReason: "fixture"
    };
  }

  return { raw, resources };
}

async function syncFromApi(config) {
  const client = new ReadOnlyJobNimbusClient(config);
  const raw = {};
  const resources = {};

  for (const [name, endpoint] of Object.entries(config.endpoints)) {
    const result = await client.listResourceWithMeta(name, endpoint);
    raw[name] = result.rows;
    resources[name] = result.meta;
  }

  for (const [name, endpoint] of Object.entries(config.metadataEndpoints || {})) {
    try {
      const result = await client.listResourceWithMeta(name, endpoint);
      raw[name] = result.rows;
      resources[name] = result.meta;
    } catch (error) {
      raw[name] = {
        optional: true,
        error: config.redact(error.message)
      };
      resources[name] = {
        name,
        endpoint,
        optional: true,
        complete: false,
        stoppedReason: "endpoint_error",
        error: config.redact(error.message)
      };
    }
  }

  return { raw, resources };
}
