import path from "node:path";
import { ReadOnlyJobNimbusClient, unwrapList } from "../jobnimbus/client.js";
import { writeJson, writeText } from "../lib/io.js";

export async function runPaginationAudit(config) {
  console.log("JobNimbus pagination audit");

  if (config.useFixtures) {
    console.log("- fixture mode is enabled; live pagination audit skipped");
    return;
  }

  const client = new ReadOnlyJobNimbusClient(config);
  const resources = [];

  for (const [name, endpoint] of Object.entries(config.endpoints)) {
    resources.push(await auditEndpoint(client, config, name, endpoint, true));
  }

  for (const [name, endpoint] of Object.entries(config.metadataEndpoints || {})) {
    resources.push(await auditEndpoint(client, config, name, endpoint, false));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    pageSize: config.pageSize,
    configuredMaxOffset: config.maxOffset,
    resultWindowLimit: config.resultWindowLimit,
    resources
  };

  const jsonPath = path.join(config.paths.reportsDir, "jobnimbus-pagination-audit.json");
  const mdPath = path.join(config.paths.reportsDir, "jobnimbus-pagination-audit.md");
  writeJson(jsonPath, report);
  writeText(mdPath, buildMarkdown(report));

  for (const resource of resources) {
    if (resource.ok) {
      const high = resource.highOffsetReadable ? "high offsets readable" : "high offsets not proven";
      console.log(`- OK ${resource.name}: total ${resource.total ?? "unknown"}, ${high}`);
    } else {
      const optional = resource.required ? "" : " optional";
      console.log(`- FAIL${optional} ${resource.name}: ${resource.error}`);
    }
  }

  console.log(`- wrote ${mdPath}`);
  console.log(`- wrote ${jsonPath}`);
}

async function auditEndpoint(client, config, name, endpoint, required) {
  try {
    const first = await client.getJson(endpoint, { size: 1, from: 0 });
    const firstRows = unwrapList(first, name);
    const total = typeof first?.count === "number" ? first.count : undefined;
    const offsets = buildProbeOffsets(total);
    const probes = [];

    for (const from of offsets) {
      probes.push(await probeOffset(client, config, name, endpoint, from));
    }

    return {
      name,
      endpoint,
      required,
      ok: true,
      total,
      sampleRowsAtZero: firstRows.length,
      highOffsetReadable: probes.some((probe) => probe.from >= 10000 && probe.rows > 0),
      expectedPastEndEmpty: probes.some((probe) => total !== undefined && probe.from >= total && probe.rows === 0),
      probes
    };
  } catch (error) {
    return {
      name,
      endpoint,
      required,
      ok: false,
      error: config.redact(error.message)
    };
  }
}

async function probeOffset(client, config, name, endpoint, from) {
  try {
    const payload = await client.getJson(endpoint, { size: 1, from });
    const rows = unwrapList(payload, name);
    return {
      from,
      ok: true,
      rows: rows.length,
      total: typeof payload?.count === "number" ? payload.count : undefined,
      sampleId: rows[0]?.jnid || rows[0]?.id || rows[0]?.number || rows[0]?.filename || null
    };
  } catch (error) {
    return {
      from,
      ok: false,
      rows: 0,
      error: config.redact(error.message)
    };
  }
}

function buildProbeOffsets(total) {
  const offsets = new Set([0]);

  if (typeof total === "number" && total > 0) {
    offsets.add(Math.max(0, Math.min(total - 1, 9999)));
    if (total > 10000) offsets.add(10000);
    if (total > 11000) offsets.add(11000);
    if (total > 20000) offsets.add(20000);
    offsets.add(Math.max(0, Math.floor(total / 2)));
    offsets.add(Math.max(0, total - 1));
    offsets.add(total);
  } else {
    offsets.add(9999);
    offsets.add(10000);
    offsets.add(11000);
  }

  return [...offsets].sort((left, right) => left - right);
}

function buildMarkdown(report) {
  const lines = [
    "# JobNimbus Pagination Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Configured page size: ${report.pageSize}`,
    `Configured max offset: ${report.configuredMaxOffset}`,
    `Configured result window limit: ${report.resultWindowLimit}`,
    "",
    "## Endpoint Results",
    ""
  ];

  for (const resource of report.resources) {
    lines.push(`### ${resource.name}`);
    lines.push("");
    lines.push(`- Endpoint: \`${resource.endpoint}\``);
    lines.push(`- Required: ${resource.required ? "yes" : "no"}`);

    if (!resource.ok) {
      lines.push(`- Result: failed`);
      lines.push(`- Error: ${resource.error}`);
      lines.push("");
      continue;
    }

    lines.push(`- Visible total: ${resource.total ?? "unknown"}`);
    lines.push(`- High offsets readable: ${resource.highOffsetReadable ? "yes" : "no"}`);
    lines.push(`- Past-end empty check: ${resource.expectedPastEndEmpty ? "yes" : "not proven"}`);
    lines.push("");
    lines.push("| Offset | OK | Rows | Sample |");
    lines.push("| ---: | :---: | ---: | --- |");
    for (const probe of resource.probes) {
      lines.push(`| ${probe.from} | ${probe.ok ? "yes" : "no"} | ${probe.rows} | ${probe.sampleId ?? probe.error ?? ""} |`);
    }
    lines.push("");
  }

  lines.push("## Decision Rule");
  lines.push("");
  lines.push("- If required endpoints show high offsets readable, the local sync can safely raise `JOBNIMBUS_MAX_OFFSET` instead of splitting reports.");
  lines.push("- If a required endpoint fails at high offsets, do not treat bulk sync as complete; use targeted per-file refresh or endpoint-specific segmentation before action.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
