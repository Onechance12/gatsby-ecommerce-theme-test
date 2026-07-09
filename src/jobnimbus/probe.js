import { ReadOnlyJobNimbusClient, unwrapList } from "./client.js";

export async function runProbe(config) {
  if (config.useFixtures) {
    console.log("Probe skipped: JOBNIMBUS_USE_FIXTURES=true. Set it to false to probe the live API.");
    return;
  }
  if (!config.apiBaseUrl || !config.apiKey) {
    console.log("Probe blocked: set JOBNIMBUS_API_BASE_URL and JOBNIMBUS_API_KEY in .env first.");
    process.exitCode = 1;
    return;
  }

  console.log("JobNimbus read-only probe");
  console.log(`- base url: ${config.apiBaseUrl}`);
  console.log(`- auth scheme: ${config.authScheme}`);
  console.log("");

  const client = new ReadOnlyJobNimbusClient(config);
  const results = [];

  for (const [name, endpoint] of Object.entries({ ...config.endpoints, ...config.metadataEndpoints })) {
    try {
      const payload = await client.getJson(endpoint, { size: 1, from: 0 });
      const rows = unwrapList(payload, name);
      const total = typeof payload?.count === "number" ? payload.count : rows.length;
      results.push({ name, endpoint, ok: true, total });
      console.log(`- OK   ${name} (${endpoint}): ${total} visible`);
    } catch (error) {
      results.push({ name, endpoint, ok: false, error: config.redact(error.message) });
      console.log(`- FAIL ${name} (${endpoint}): ${config.redact(error.message)}`);
    }
  }

  console.log("");
  const contacts = results.find((result) => result.name === "contacts");
  const jobs = results.find((result) => result.name === "jobs");
  const operationalVisible = (contacts?.ok && contacts.total > 0) || (jobs?.ok && jobs.total > 0);

  if (!results.some((result) => result.ok)) {
    console.log("Probe verdict: authentication failed or the API is unreachable. Check the key and base URL.");
    process.exitCode = 1;
  } else if (!operationalVisible) {
    console.log("Probe verdict: key accepted, but zero contacts and zero jobs are visible. The key's access profile cannot see operational records — fix the access profile in JobNimbus settings before running a sweep.");
    process.exitCode = 1;
  } else {
    console.log("Probe verdict: live API reachable and operational records are visible. Safe to run `npm run chance:sweep` or `npm run sweep`.");
  }
}
