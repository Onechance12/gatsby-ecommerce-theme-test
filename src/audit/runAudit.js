import path from "node:path";
import { writeText } from "../lib/io.js";

export async function runAudit(config) {
  const filePath = path.join(config.paths.reportsDir, "system-audit.md");
  writeText(filePath, buildAudit(config));
  console.log("System audit written");
  console.log(`- ${filePath}`);
}

function buildAudit(config) {
  return `# JobNimbus Ops Assistant Audit

Generated: ${new Date().toISOString()}

## Current Status

- Local fixture sweep works.
- JobNimbus public API docs are incorporated.
- Live connection still needs API key/admin access.
- Browser review confirmed a visible JobNimbus contact type/status pattern: Insurance, Photo File / Estimate Needed.
- Browser review confirmed the operational files are primarily JobNimbus contacts with Type \`Insurance\`, not only JobNimbus jobs.
- Browser review confirmed appraisal board stages: Ready for Appraisal, Submitted for Appraisal, Carrier Appraiser Assigned, Meeting Scheduled / Appraisal Inspection Scheduled, Initial Approval / Awaiting Estimate, Umpire, and Finalized / Awaiting ACV.
- Appraisal file review confirmed useful field labels: Insurance Company, Claim #, Policy #, Date of Loss, Deductible Amount, Type Of Loss, Carrier DA, Carrier DA Contact #, Carrier DA Email, Days in Status, Assigned To, Sales Rep, Documents, Photos, Financials, and activity notes.
- V1 remains read-only.

## Main Fixes Needed Before Live Production Use

- Confirm real JobNimbus custom field names for carrier, claim number, date of loss, policy, adjuster, mortgage, deductible, estimate/scope, denial/underpayment, and appraisal.
- Confirm contact/job workflow statuses from API data.
- Add real account field map by running \`npm run map:fields\` after a live probe/sweep.
- Tune appraisal-readiness rules against real statuses and notes.
- Add a human approval layer before any future JobNimbus writes.

## Public Adjusting / Appraisal Focus

This assistant should prioritize files where:

- The claim was denied.
- The claim was underpaid.
- Photos exist but an estimate/scope is still needed.
- Carrier estimate/payment is below expected scope.
- Supplement was denied or ignored.
- The file appears ready for appraisal.
- Appraisal is pending and needs follow-up.
- Homeowner documents, policy/declaration page, deductible, or mortgage details are missing.

## Safety

- Current API client only performs GET requests.
- No create/update/delete methods are implemented.
- Secrets are read from \`.env\` only.
- \`.env\` is ignored by git.
- Reported suggested notes/tasks are drafts only.

## Config

- Fixture mode: ${config.useFixtures}
- API base URL: ${config.apiBaseUrl || "(not set)"}
- Page size: ${config.pageSize}
- Stale days: ${config.staleDays}
- High-priority stale days: ${config.highPriorityStaleDays}
`;
}
