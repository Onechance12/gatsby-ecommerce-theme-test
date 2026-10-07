import { execFile as callbackExecFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createCompanyRosterClient } from "../src/hcn-console/company-roster-client.js";

const execFile = promisify(callbackExecFile);
const args = process.argv.slice(2);
const usage = "Usage: node scripts/company-roster.mjs --profile /absolute/private/profile.json (--status | --output /absolute/private/new-roster.json)";

try {
  const statusOnly = args.length === 3 && args[0] === "--profile" && args[2] === "--status";
  const outputMode = args.length === 4 && args[0] === "--profile" && args[2] === "--output";
  if ((!statusOnly && !outputMode) || !path.isAbsolute(args[1])) throw new Error(usage);
  const profileStat = await lstat(args[1]);
  if (!profileStat.isFile() || profileStat.isSymbolicLink() || (profileStat.mode & 0o077)) {
    throw new Error("The roster profile must be a private regular file (mode 600).");
  }
  if (profileStat.size > 8192) throw new Error("Invalid roster profile.");
  const profile = JSON.parse(await readFile(args[1], "utf8"));
  let output;
  if (outputMode) {
    output = args[3];
    if (!path.isAbsolute(output) || !output.endsWith(".json")) throw new Error(usage);
    try { await lstat(output); throw new Error("Refusing to overwrite an existing inventory."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = await lstat(path.dirname(output));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) {
      throw new Error("Inventory output requires a private directory (mode 700).");
    }
    let inRepository = false;
    try {
      const result = await execFile("/usr/bin/git", ["-C", path.dirname(output), "rev-parse", "--is-inside-work-tree"]);
      inRepository = result.stdout.trim() === "true";
    } catch { /* A non-repository directory is expected. */ }
    if (inRepository) throw new Error("Inventory artifacts must stay outside source control.");
  }
  const { stdout } = await execFile("/usr/bin/security", [
    "find-generic-password", "-s", "com.wavepa.hcn-company-roster",
    "-a", "codex-mac-company-roster", "-w"
  ], { maxBuffer: 1024, timeout: 15_000 });
  const client = createCompanyRosterClient({ profile, credential: stdout.trim() });
  if (statusOnly) {
    const session = await client.verifySession();
    console.log(JSON.stringify({ ready: true, readOnly: true, externalWrites: false, commit: session.build.sourceCommit, expiresAt: session.identity.grantExpiresAt }));
  } else {
    const roster = await client.readRoster();
    await writeFile(output, JSON.stringify(roster, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ saved: output, complete: true, totals: roster.totals, providerRequests: roster.coverage.providerRequests, inventorySha256: roster.inventorySha256, commit: roster.build.sourceCommit }));
  }
} catch (error) {
  // Child-process errors may contain a command or provider metadata. Never
  // print them, a credential, the raw profile, or a rejected response body.
  console.error(error.code === "hcn_company_roster_attestation_failed"
    ? error.message : "Company roster inventory did not run or save. Check the private profile, Keychain grant, output path, and reviewed deployment.");
  process.exitCode = 1;
}
