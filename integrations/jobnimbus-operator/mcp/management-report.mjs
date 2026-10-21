import { execFileSync } from "node:child_process";

export const MANAGEMENT_REPORT_ORIGIN = "https://hcn-operations-platform.onrender.com";
export const MANAGEMENT_REPORT_KEYCHAIN_SERVICE = "com.wavepa.hcn-management-report";
export const MANAGEMENT_REPORT_SUBJECT = "codex-mac-management-report";
// Reviewed 2026-09-25: release #42 repairs exact Quo call scope, not the
// isolated report routes/auth/engine. Keep an exact reviewed release pin.
export const MANAGEMENT_REPORT_BUILD = "892cbc700b80ef7dfc66abebd6be921eb3908673";
const SESSION = "/hcn/api/v1/management-report-session";
const REPORT = "/hcn/api/v1/management-sweep";
const ROUTES = [`GET ${SESSION}`, `POST ${REPORT}`];

function sessionFailureDetails(s, expectedCommit) {
  const checks = {
    schema: s?.schema === "hcn.management-report-session.v1",
    ready: s?.ready === true,
    readOnly: s?.readOnly === true,
    externalWritesDisabled: s?.externalWrites === false,
    identityType: s?.identity?.type === "hcn_management_report_token",
    identitySubject: s?.identity?.subject === MANAGEMENT_REPORT_SUBJECT,
    identityRole: s?.identity?.role === "management_report_reader",
    identityScopes: JSON.stringify(s?.identity?.scopes) === JSON.stringify(["management_sweep:read"]),
    routes: Array.isArray(s?.routes) && JSON.stringify([...s.routes].sort()) === JSON.stringify([...ROUTES].sort()),
    buildService: s?.build?.service === "hcn-operations-platform",
    expectedCommitValid: /^[a-f0-9]{40}$/.test(expectedCommit),
    buildCommit: s?.build?.sourceCommit === expectedCommit,
    buildTrust: s?.build?.sourceCommitTrust === "provider_attested",
    buildAttested: s?.build?.attested === true,
    adjusterCount: s?.configuredAdjusterCount === 3,
    rankingMode: s?.rankingMode === "jobnimbus_activity_only",
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  // Only diagnostic labels and validated public release identifiers may leave
  // this boundary. Never include the raw response, credentials, or client data.
  const safeCommit = value => /^[a-f0-9]{40}$/.test(value) ? value : "unavailable";
  return ` Failed checks: ${failedChecks.join(", ")}. Expected release: ${safeCommit(expectedCommit)}; reported release: ${safeCommit(s?.build?.sourceCommit)}.`;
}

export function createManagementReportClient({ request, expectedCommit = MANAGEMENT_REPORT_BUILD, now = () => Date.now() }) {
  async function verifySession() {
    const s = await request("GET", SESSION);
    if (!/^[a-f0-9]{40}$/.test(expectedCommit)
      || s?.schema !== "hcn.management-report-session.v1"
      || s.ready !== true || s.readOnly !== true || s.externalWrites !== false
      || s.identity?.type !== "hcn_management_report_token"
      || s.identity?.subject !== MANAGEMENT_REPORT_SUBJECT
      || s.identity?.role !== "management_report_reader"
      || JSON.stringify(s.identity?.scopes) !== JSON.stringify(["management_sweep:read"])
      || !Array.isArray(s.routes) || JSON.stringify([...s.routes].sort()) !== JSON.stringify([...ROUTES].sort())
      || s.build?.service !== "hcn-operations-platform"
      || s.build?.sourceCommit !== expectedCommit
      || s.build?.sourceCommitTrust !== "provider_attested" || s.build?.attested !== true
      || s.configuredAdjusterCount !== 3 || s.rankingMode !== "jobnimbus_activity_only") {
      throw new Error("The separate HCN report connection is not attested; no report was run. Operational permissions are unchanged." + sessionFailureDetails(s, expectedCommit));
    }
    return s;
  }
  async function runReport() {
    await verifySession();
    const r = await request("POST", REPORT, { limitPerAdjuster: 10 });
    if (r?.schema !== "hcn.console.management-sweep.v1" || r.ephemeral !== true || r.cachePolicy !== "no_store"
      || !Number.isFinite(Date.parse(r.checkedAt)) || Date.parse(r.checkedAt) > now() + 30_000
      || Date.parse(r.checkedAt) < now() - 15 * 60_000 || !(Date.parse(r.validUntil) > now())
      || !Array.isArray(r.adjusters) || r.adjusters.length !== 3
      || !["all_active", "estimating_board"].includes(r.criteria?.workflowScope)) {
      throw new Error("The report is stale, incomplete, or not the expected three-adjuster activity report. No automatic retry.");
    }
    const seen = new Set();
    for (const group of r.adjusters) {
      if (seen.has(group.adjusterRef) || !group.adjusterRef || !group.name
        || !Number.isInteger(group.eligibleCount) || !Array.isArray(group.items)
        || group.items.length !== Math.min(group.eligibleCount, 10)
        || group.returnedCount !== group.items.length) throw new Error("Report adjuster counts do not reconcile.");
      seen.add(group.adjusterRef);
      for (const [index, item] of group.items.entries()) {
        const gap = item.gaps?.operationalActivity;
        if (item.adjusterRank !== index + 1 || !item.display?.jobNumber || !item.display?.name
          || !gap || (gap.days !== null && (!Number.isInteger(gap.days) || gap.days < 0))) {
          throw new Error("A report row is invalid; no PDF should be created.");
        }
      }
    }
    if (r.summary?.eligibleFileCount !== r.adjusters.reduce((n, g) => n + g.eligibleCount, 0)) {
      throw new Error("Report totals do not reconcile.");
    }
    verifyPortfolioCensus(r);
    await verifySession();
    return r;
  }
  return { verifySession, runReport };
}

function verifyPortfolioCensus(report) {
  const p = report.portfolio;
  // Old, explicitly filtered reports remain readable during a staged rollout.
  // They never acquire a full-portfolio label or fabricated census here.
  if (!p && report.criteria.workflowScope === "estimating_board") return;
  const groupKeys = ["assignedInsuranceCount", "singleAssignedCount", "ambiguousOwnerCount",
    "activeFileCount", "inactiveFileCount", "unknownActivityStateCount", "outsideWorkflowStatusCount", "eligibleFileCount"];
  const indexKeys = ["scannedContactCount", "insuranceContactCount", "nonInsuranceCount", "unknownFileTypeCount",
    "unknownOwnerCount", "outsideConfiguredOwnerCount", "historyReadFileCount"];
  const numbers = (value, keys) => value && keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
  const groupValid = g => numbers(g, groupKeys)
    && g.assignedInsuranceCount === g.singleAssignedCount + g.ambiguousOwnerCount
    && g.singleAssignedCount === g.activeFileCount + g.inactiveFileCount + g.unknownActivityStateCount
    && g.activeFileCount === g.outsideWorkflowStatusCount + g.eligibleFileCount;
  const fail = () => { throw new Error("Report portfolio census, histories, and exclusions do not reconcile. No automatic retry."); };
  if (!groupValid(p) || !numbers(p, indexKeys) || p.indexComplete !== true
    || p.scannedContactCount !== p.insuranceContactCount + p.nonInsuranceCount + p.unknownFileTypeCount
    || p.insuranceContactCount !== p.assignedInsuranceCount + p.unknownOwnerCount + p.outsideConfiguredOwnerCount
    || p.eligibleFileCount !== report.summary.eligibleFileCount || p.historyReadFileCount !== p.eligibleFileCount
    || report.summary.inputFileCount !== p.eligibleFileCount
    || (report.criteria.workflowScope === "all_active" && p.outsideWorkflowStatusCount !== 0)
    || !Array.isArray(report.exclusions) || !report.exclusions.every(row => numbers(row, ["count"]))
    || report.summary.exclusionCount !== report.exclusions.reduce((n, row) => n + row.count, 0)
    || p.scannedContactCount !== p.eligibleFileCount + report.summary.exclusionCount
    || report.adjusters.some(g => !groupValid(g.portfolio) || g.eligibleCount !== g.portfolio.eligibleFileCount)
    || ["singleAssignedCount", "activeFileCount", "inactiveFileCount", "unknownActivityStateCount", "outsideWorkflowStatusCount", "eligibleFileCount"]
      .some(key => report.adjusters.reduce((sum, g) => sum + g.portfolio[key], 0) !== p[key])
    || report.summary.returnedAcrossAdjusters !== report.adjusters.reduce((sum, g) => sum + g.returnedCount, 0)
    || (p.ambiguousOwnerCount + p.unknownFileTypeCount + p.unknownOwnerCount + p.unknownActivityStateCount > 0
      && report.completeness?.status !== "partial")) fail();
  const items = report.adjusters.flatMap(g => g.items);
  if (items.some(item => !/^subject_[a-f0-9]{32}$/.test(item.fileRef))
    || new Set(items.map(item => item.fileRef)).size !== items.length) fail();
}

export function createInstalledManagementReportClient() {
  let token;
  async function request(method, pathname, body) {
    if (!ROUTES.includes(`${method} ${pathname}`)) throw new Error("Report transport rejects this route.");
    if (!token) {
      try {
        token = execFileSync("/usr/bin/security", ["find-generic-password", "-s", MANAGEMENT_REPORT_KEYCHAIN_SERVICE, "-a", MANAGEMENT_REPORT_SUBJECT, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
      } catch { throw new Error("The separate HCN report credential is missing from Keychain; no Google login or operational-token fallback is used."); }
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid report credential.");
    }
    const response = await fetch(`${MANAGEMENT_REPORT_ORIGIN}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? {"content-type":"application/json"} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {}), redirect: "error", signal: AbortSignal.timeout(240_000)
    });
    if (!response.ok || !String(response.headers.get("content-type")).includes("application/json")) {
      await response.body?.cancel();
      throw new Error(`HCN reporting request failed (${response.status}). No automatic retry and no customer records changed.`);
    }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw new Error("Report response exceeds its limit.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return createManagementReportClient({ request });
}
