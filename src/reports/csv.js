import path from "node:path";
import { toCsv, writeText } from "../lib/io.js";

export function writeCsvReport(config, reviews, options = {}) {
  const basename = options.basename || "jobnimbus-sweep";
  const filePath = path.join(config.paths.reportsDir, `${basename}.csv`);
  const rows = reviews.map((review) => ({
    priority: review.priority,
    customer: review.file.customer,
    address: review.file.address,
    status: review.file.status,
    thresherPhase: review.thresherPhase,
    workflowLane: review.workflowLane,
    ownerLane: review.ownerLane,
    daysInPhase: review.daysInPhase,
    phaseExpectedDays: review.phaseExpectedDays,
    recordType: review.file.recordType,
    carrier: review.file.carrier,
    claimNumber: review.file.claimNumber,
    policyNumber: review.file.policyNumber,
    deductibleAmount: review.file.deductibleAmount,
    typeOfLoss: review.file.typeOfLoss,
    daysInStatus: review.file.daysInStatus,
    bottleneck: review.bottleneck,
    missingInfo: review.missingInfo,
    recommendedNextAction: review.recommendedNextAction,
    suggestedTask: review.suggestedTask,
    lastActivityDate: review.file.lastActivityDate,
    assignedTo: review.assignedTo,
    categories: review.categories
    ,
    appraisalStatus: review.file.appraisalStatus,
    estimateStatus: review.file.estimateStatus,
    denialStatus: review.file.denialStatus
  }));

  const csv = toCsv(rows, [
    { header: "Priority", key: "priority" },
    { header: "Customer", key: "customer" },
    { header: "Address", key: "address" },
    { header: "Status", key: "status" },
    { header: "Thresher Phase", key: "thresherPhase" },
    { header: "Workflow Lane", key: "workflowLane" },
    { header: "Owner Lane", key: "ownerLane" },
    { header: "Days In Phase", key: "daysInPhase" },
    { header: "Phase Target Days", key: "phaseExpectedDays" },
    { header: "Type", key: "recordType" },
    { header: "Carrier", key: "carrier" },
    { header: "Claim Number", key: "claimNumber" },
    { header: "Policy Number", key: "policyNumber" },
    { header: "Deductible", key: "deductibleAmount" },
    { header: "Type Of Loss", key: "typeOfLoss" },
    { header: "Days In Status", key: "daysInStatus" },
    { header: "Bottleneck", key: "bottleneck" },
    { header: "Missing Info", key: "missingInfo" },
    { header: "Recommended Next Action", key: "recommendedNextAction" },
    { header: "Suggested Task", key: "suggestedTask" },
    { header: "Last Activity Date", key: "lastActivityDate" },
    { header: "Assigned To", key: "assignedTo" },
    { header: "Categories", key: "categories" },
    { header: "Appraisal Status", key: "appraisalStatus" },
    { header: "Estimate Status", key: "estimateStatus" },
    { header: "Denial Status", key: "denialStatus" }
  ]);

  writeText(filePath, csv);
  return filePath;
}
