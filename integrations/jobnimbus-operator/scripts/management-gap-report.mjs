import { lstat, writeFile } from "node:fs/promises";
import { createInstalledManagementReportClient } from "../mcp/management-report.mjs";

const args = process.argv.slice(2);
const client = createInstalledManagementReportClient();
if (args.length === 1 && args[0] === "--status") {
  console.log(JSON.stringify(await client.verifySession()));
} else if (args.length === 2 && args[0] === "--output" && args[1].startsWith("/")) {
  const existing = await lstat(args[1]).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("Output already exists; no report was requested. Choose a new output path.");
  const report = await client.runReport();
  await writeFile(args[1], JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ path: args[1], checkedAt: report.checkedAt, summary: report.summary, completeness: report.completeness, adjusters: report.adjusters.map(g => ({ name: g.name, eligible: g.eligibleCount, returned: g.returnedCount })) }));
} else {
  throw new Error("Usage: management-gap-report.mjs --status | --output /absolute/new-report.json");
}
