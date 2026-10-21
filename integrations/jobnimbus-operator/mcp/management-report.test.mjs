import assert from "node:assert/strict";
import test from "node:test";
import { createManagementReportClient } from "./management-report.mjs";
const sha = "a".repeat(40);
const now = Date.parse("2026-09-18T15:00:00Z");
const session = () => ({schema:"hcn.management-report-session.v1",ready:true,readOnly:true,externalWrites:false,identity:{type:"hcn_management_report_token",subject:"codex-mac-management-report",role:"management_report_reader",scopes:["management_sweep:read"]},routes:["GET /hcn/api/v1/management-report-session","POST /hcn/api/v1/management-sweep"],build:{service:"hcn-operations-platform",sourceCommit:sha,sourceCommitTrust:"provider_attested",attested:true},configuredAdjusterCount:3,rankingMode:"jobnimbus_activity_only"});
const report = () => ({schema:"hcn.console.management-sweep.v1",ephemeral:true,cachePolicy:"no_store",checkedAt:new Date(now).toISOString(),validUntil:new Date(now+60_000).toISOString(),criteria:{workflowScope:"estimating_board"},summary:{eligibleFileCount:3},adjusters:[1,2,3].map(n=>({adjusterRef:String(n),name:`Adjuster ${n}`,eligibleCount:1,returnedCount:1,items:[{adjusterRank:1,display:{jobNumber:String(n),name:"Synthetic Client"},gaps:{operationalActivity:{days:4}}}]}))});
test("report connection uses only session and existing report routes, preserving partial warnings", async()=>{
  const calls=[];const r=report();r.completeness={status:"partial",summary:"Unknown activity"};
  const c=createManagementReportClient({expectedCommit:sha,now:()=>now,request:async(method,url,body)=>{calls.push([method,url,body]);return method==="GET"?session():r;}});
  assert.equal((await c.runReport()).completeness.status,"partial");
  assert.deepEqual(calls.map(x=>x[0]),["GET","POST","GET"]);
  assert.deepEqual(calls[1].slice(1),["/hcn/api/v1/management-sweep",{limitPerAdjuster:10}]);
});
test("unready, wrong identity/build, or expanded privileges stop before reading clients",async()=>{
  const variants=[{ready:false},{externalWrites:true},{readOnly:false},{configuredAdjusterCount:2},{routes:["POST /ops/action-batch"]},{identity:{...session().identity,subject:"codex-hp-operator"}},{build:{...session().build,sourceCommit:"b".repeat(40)}},{build:{...session().build,attested:false}}];
  for(const change of variants){let posts=0;const c=createManagementReportClient({expectedCommit:sha,now:()=>now,request:async(m)=>{if(m==="POST")posts++;return {...session(),...change};}});await assert.rejects(c.runReport(),/not attested/);assert.equal(posts,0);}
});
test("stale data and inconsistent counts fail without retry",async()=>{
  for(const change of [{checkedAt:"2026-09-17T15:00:00Z"},{validUntil:"2026-09-18T14:59:00Z"},{summary:{eligibleFileCount:99}},{adjusters:report().adjusters.slice(1)}]){let posts=0;const c=createManagementReportClient({expectedCommit:sha,now:()=>now,request:async m=>{if(m==="GET")return session();posts++;return {...report(),...change};}});await assert.rejects(c.runReport());assert.equal(posts,1);}
});

test("release mismatch reports safe diagnostics and never reads client records", async () => {
  let posts = 0;
  const observed = "b".repeat(40);
  const c = createManagementReportClient({expectedCommit:sha, request:async method => {
    if (method === "POST") posts++;
    return {...session(), build:{...session().build, sourceCommit:observed}, token:"never-print-this-secret"};
  }});
  await assert.rejects(c.runReport(), error => {
    assert.match(error.message, /Failed checks: buildCommit\./);
    assert.ok(error.message.includes(`Expected release: ${sha}; reported release: ${observed}`));
    assert.ok(!error.message.includes("never-print-this-secret"));
    return true;
  });
  assert.equal(posts, 0);
});

test("malformed release data is never echoed in diagnostics", async () => {
  const c = createManagementReportClient({expectedCommit:sha, request:async () => ({...session(), build:{...session().build, sourceCommit:"secret-or-client-data"}})});
  await assert.rejects(c.verifySession(), error => {
    assert.match(error.message, /reported release: unavailable/);
    assert.ok(!error.message.includes("secret-or-client-data"));
    return true;
  });
});

function fullPortfolioReport() {
  const r = report();
  const counts = { assignedInsuranceCount: 1, singleAssignedCount: 1, ambiguousOwnerCount: 0,
    activeFileCount: 1, inactiveFileCount: 0, unknownActivityStateCount: 0, outsideWorkflowStatusCount: 0, eligibleFileCount: 1 };
  r.criteria.workflowScope = "all_active";
  r.portfolio = { ...counts, assignedInsuranceCount: 3, singleAssignedCount: 3, activeFileCount: 3, eligibleFileCount: 3,
    scannedContactCount: 5, insuranceContactCount: 4, nonInsuranceCount: 1, unknownFileTypeCount: 0, unknownOwnerCount: 0,
    outsideConfiguredOwnerCount: 1, historyReadFileCount: 3, indexComplete: true };
  r.summary = { eligibleFileCount: 3, inputFileCount: 3, exclusionCount: 2, returnedAcrossAdjusters: 3 };
  r.exclusions = [{ label: "Other owner", count: 1 }, { label: "Non-Insurance", count: 1 }];
  r.completeness = { status: "complete", summary: "Synthetic complete index and histories." };
  r.adjusters.forEach((g, i) => { g.portfolio = { ...counts }; g.items[0].fileRef = `subject_${String(i + 1).repeat(32)}`; });
  return r;
}

test("full-portfolio report reconciles census without changing routes or build attestation", async () => {
  const r = fullPortfolioReport(), calls = [];
  const c = createManagementReportClient({ expectedCommit: sha, now: () => now, request: async (m, path) => {
    calls.push([m, path]); return m === "GET" ? session() : r;
  } });
  assert.equal(await c.runReport(), r);
  assert.deepEqual(calls.map(([m]) => m), ["GET", "POST", "GET"]);
  assert.equal(r.portfolio.scannedContactCount, 5);
});

test("full-portfolio labels require a complete reconciling census and honest uncertainty", async () => {
  const changes = [r => { delete r.portfolio; }, r => { r.portfolio.scannedContactCount = 3; },
    r => { r.portfolio.historyReadFileCount = 1; }, r => { r.summary.exclusionCount = 0; },
    r => { r.adjusters[0].portfolio.activeFileCount = 9; }, r => { delete r.adjusters[0].portfolio; },
    r => { r.adjusters[1].items[0].fileRef = r.adjusters[0].items[0].fileRef; },
    r => { r.portfolio.nonInsuranceCount = 0; r.portfolio.unknownFileTypeCount = 1; },
    r => { r.portfolio.indexComplete = false; }];
  for (const change of changes) {
    const r = fullPortfolioReport(); change(r); let posts = 0;
    const c = createManagementReportClient({ expectedCommit: sha, now: () => now, request: async m => {
      if (m === "GET") return session(); posts++; return r;
    } });
    await assert.rejects(c.runReport(), /portfolio census/);
    assert.equal(posts, 1);
  }
});
