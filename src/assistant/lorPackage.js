// THE ONE COMMAND: prepare (and, once approved, stage) an LOR + payment-
// redirection email for a file — the Adelle workflow, automated.
//
// What it does, in order:
//   1. Find the file by name/claim# in the latest sweep.
//   2. Generate the filled LOR PDF from Chance's template.
//   3. Pull the signed TDI (and optionally W9/Part B) from JobNimbus.
//   4. Build the carrier cover email (subject = claim #, your real wording).
//   5. DRY RUN by default: shows the plan + writes the PDFs locally.
//      With Google creds + execute:true: stages the Gmail DRAFT with both PDFs
//      attached, ready for Chance to review and send.
//
// It never sends. It only ever creates a draft.

import fs from "node:fs";
import path from "node:path";
import { loadReviews, findMatches } from "./fileReview.js";
import { generateLor } from "../documents/lorGenerator.js";
import { listContactFiles, findFile, downloadFile } from "../jobnimbus/files.js";
import { googleConfigured } from "../google/googleAuth.js";
import { createDraftWithAttachments } from "../google/gmail.js";
import { gatherLiveContext, applyLiveOverrides } from "./fileClaim.js";

export async function runLorPackage(config, args) {
  const input = parseInput(args);
  const query = input.query || input._ || "";
  if (!query) {
    console.log('Usage: npm run lor-package -- \'{"query":"Adelle","to":"claims@carrier.com","execute":false}\'');
    return;
  }

  const reviews = loadReviews(config);
  const match = findMatches(reviews, query)[0];
  if (!match) { console.log(`No file found for: ${query}`); process.exitCode = 1; return; }
  const file = match.file;

  // Refresh key fields from live JobNimbus (the LOR is a legal doc — never build
  // it from a stale snapshot's policy/claim/insured values).
  const { contact: liveContact, liveError } = await gatherLiveContext(config, match);
  if (liveContact) applyLiveOverrides(file, liveContact);

  // 1 + 2: generate LOR
  const lor = generateLor(config, file);
  // 3: pull TDI (+ optional extras) from JobNimbus
  const jnFiles = await listContactFiles(config, file.id);
  // Direct-to-pay packet = TDI + LOR + W-9 only (per Chance). Part B is not sent.
  const wanted = [
    { key: "TDI", keyword: "tdi|fin535", label: "TDI/FIN535" }
  ];
  const attachments = [];
  const workDir = path.join(config.paths.workDir, "lor");
  if (lor.pdfPath && fs.existsSync(lor.pdfPath)) {
    attachments.push({ filename: path.basename(lor.pdfPath), contentType: "application/pdf", localPath: lor.pdfPath, source: "generated LOR" });
  }
  const pulled = [];
  for (const w of wanted) {
    const f = findFile(jnFiles, w.keyword);
    if (!f) { pulled.push({ label: w.label, found: false }); continue; }
    const dest = path.join(workDir, f.filename.replace(/[^a-z0-9._-]+/gi, "_"));
    try {
      await downloadFile(config, f.jnid, dest);
      attachments.push({ filename: f.filename, contentType: f.contentType || "application/pdf", localPath: dest, source: `JobNimbus (${w.label})` });
      pulled.push({ label: w.label, found: true, filename: f.filename });
    } catch (error) {
      pulled.push({ label: w.label, found: true, error: config.redact(error.message) });
    }
  }

  // W-9: the firm's standard Wave W-9 (saved from Richard's template email). It's
  // the same doc on every direct-to-pay, so attach it from a local asset path.
  const w9Path = input.w9Path || process.env.WAVE_W9_PATH || path.join(config.paths.workDir, "templates", "Wave-W9.pdf");
  if (fs.existsSync(w9Path)) {
    attachments.push({ filename: "Wave-W9.pdf", contentType: "application/pdf", localPath: w9Path, source: "Wave W-9 (firm asset)" });
    pulled.push({ label: "W-9", found: true, filename: "Wave-W9.pdf" });
  } else {
    pulled.push({ label: "W-9", found: false, note: `not found at ${w9Path}` });
  }

  // 4: cover email — name ONLY the docs actually attached, so we never promise a
  // document the recipient won't find.
  const has = (kw) => attachments.some((a) => new RegExp(kw, "i").test(a.filename) || new RegExp(kw, "i").test(a.source || ""));
  const docPhrases = [];
  if (has("lor|representation")) docPhrases.push("an updated LOR");
  if (has("tdi|fin535")) docPhrases.push("an executed TDI (FIN535)");
  if (has("w-?9")) docPhrases.push("a W-9");
  const docList = docPhrases.length
    ? docPhrases.length === 1 ? docPhrases[0]
      : `${docPhrases.slice(0, -1).join(", ")} and ${docPhrases[docPhrases.length - 1]}`
    : "the requested documents";
  const missingRequired = [];
  if (!has("lor|representation")) missingRequired.push("LOR");
  if (!has("tdi|fin535")) missingRequired.push("TDI");

  const to = input.to || "{carrier claims email — needed}";
  const subject = file.claimNumber || "{claim number}";
  const body = [
    "Good afternoon,",
    "",
    `Attached please find ${docList} for the above referenced claim (policyholder: ${file.customer}). Please send payment to our office with Wave Public Adjusting LLC included as a payee.`,
    "",
    "Thank you,",
    "Chance Pearson",
    "972-573-1730",
    "cpearson@wavepa.com",
    "Wave Public Adjusting LLC",
    "3500 Oak Lawn Ave #460C",
    "Dallas, TX 75219",
    "TX Lic # 3351885"
  ].join("\n");

  const plan = {
    file: { customer: file.customer, carrier: file.carrier, claim: file.claimNumber, status: file.status, jnid: file.id },
    email: { to, subject, bodyPreview: body },
    attachments: attachments.map((a) => ({ filename: a.filename, source: a.source })),
    jobNimbusDocs: pulled,
    lorPdf: lor.pdfPath || lor.error
  };

  plan.missingRequiredDocs = missingRequired;
  if (liveError) plan.liveRefreshWarning = `Live JobNimbus refresh failed (${liveError}); LOR built from last sweep — verify policy/claim before sending.`;
  const execute = input.execute === true;

  if (!execute || !googleConfigured(config)) {
    console.log(JSON.stringify({ mode: "DRY RUN", plan, next: googleConfigured(config)
      ? (missingRequired.length ? `WARNING: missing ${missingRequired.join(", ")} — draft will be blocked until present (or pass allowMissingDocs:true).` : "Add \"execute\":true to stage the Gmail draft with attachments.")
      : "Google not configured — docs saved locally. Set GOOGLE_* in .env (see docs/google-setup.md) to auto-stage the draft."
    }, null, 2));
    return;
  }
  if (to.startsWith("{")) {
    console.log(JSON.stringify({ mode: "BLOCKED", reason: "No recipient email. Pass \"to\":\"...\".", plan }, null, 2));
    process.exitCode = 1;
    return;
  }
  // Never stage a legal-doc email that promises an LOR/TDI it doesn't carry.
  if (missingRequired.length && input.allowMissingDocs !== true) {
    console.log(JSON.stringify({ mode: "BLOCKED", reason: `Required document(s) missing: ${missingRequired.join(", ")}. Fix the file (upload the TDI / check LOR generation) or pass allowMissingDocs:true to override.`, plan }, null, 2));
    process.exitCode = 1;
    return;
  }

  // 5: stage the draft with attachments
  const withBytes = attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: fs.readFileSync(a.localPath) }));
  const draft = await createDraftWithAttachments(config, { to, subject, body, attachments: withBytes });
  console.log(JSON.stringify({ mode: "DRAFT STAGED", draftId: draft.id, to, subject, attachments: withBytes.map((a) => a.filename), note: "Review in Gmail drafts and send." }, null, 2));
}

function parseInput(args) {
  const text = (args || []).join(" ").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _: text }; }
}
