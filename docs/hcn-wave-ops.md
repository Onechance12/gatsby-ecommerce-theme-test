# HCN/Wave JobNimbus Ops Playbook

Source: "HCN/Wave JobNimbus Ops Implementation Pack" authored by Chance's local
Codex/GPT. This is the authoritative operating playbook (the `hcn-wave-ops`
skill equivalent). `docs/operating-context.md` holds the account-specific facts
(org, custom-field map, tools); this holds the *procedure and rules*.

## Operating principle

Use fresh file data, identify the real bottleneck, propose **one primary next
action**, and never write, send, update, create, delete, or modify anything
until Chance approves the exact action.

## 1. Core operating rules

- **Default scope:** Chance Pearson's Home Claim Network / Wave Public Adjusting
  files. Do **not** touch other scopes (e.g. Jobrolo) unless Chance explicitly
  changes scope.
- **Fresh data first:** review current JobNimbus data before advising; never
  rely on memory or old chat context.
- **One primary next action** per file. Don't let stale-task cleanup distract
  from the main move that advances the claim.
- **Approval first (dry-run = proposed only).** Never execute without exact
  approval: JobNimbus field updates, notes, tasks, status/contact changes,
  calendar events, Gmail drafts, sent emails, Quo texts, Mitra/Replit filing
  packets. When approval is needed, present an execution approval queue.

## 2. File review workflow

1. **Locate** by name / JobNimbus # / claim # / policy # / address / phone /
   email / carrier / adjuster.
2. **Review** file details, status, claim fields, owner, recent notes/activity,
   open tasks, documents, calendar/appointments, missing info, and any
   conflicts between notes/tasks/docs/fields.
3. **Review documents when they matter** — policies, dec pages, TDI forms,
   estimates, carrier letters, appraisal docs/demands, scope/award docs, scanned
   or image PDFs (OCR). Especially before: filing, moving to appraisal, sending
   a demand, confirming coverage/policy#/DOL/carrier position, comparing gaps.
4. **Identify the bottleneck** — the single reason the file isn't moving.
5. **Recommend one next action** — specific and executable.

## 3. Thresher status logic (next actions per phase)

- **Photo File / Estimate Needed:** review photos/docs, confirm damage
  categories, complete estimate, then move to PA review.
- **Ready for PA Review:** review estimate + policy/dec page + coverage; decide
  file / negotiate / supplement / prepare appraisal.
- **Claim Filing / Intake:** locate policy/dec page, prepare Mitra/Replit packet,
  confirm authority docs, send to Mitra after approval. Don't auto-stall if the
  carrier can locate coverage by insured/address/phone/policy.
- **Submitted Awaiting Confirmation:** confirm carrier receipt, obtain claim #,
  desk + field adjuster info, confirm inspection scheduling, set follow-up task.
- **Negotiating / Hot-Final:** follow up with carrier/adjuster, compare HCN/Wave
  vs carrier estimate, track payment, request revised scope/payment, escalate if
  nonresponsive.
- **Ready for Appraisal:** verify estimate gap, review policy appraisal clause,
  confirm estimates/carrier docs, prepare demand + approval package.
- **Submitted for Appraisal:** confirm demand receipt, request carrier appraiser
  assignment, track deadlines, follow up.
- **Carrier Appraiser Assigned / Meeting Scheduled:** capture appraiser contact,
  confirm meeting date/time/location, confirm homeowner access, create/update
  calendar event after approval.
- **Initial Approval / Umpire / Finalized / Review for Close:** track
  award/ACV/RCV/payment, confirm remaining docs + client issues, prep for close.

## 4. Next-action priority rules

1. **Missing policy/dec page:** check JobNimbus documents first; request from
   homeowner only if needed. Don't auto-stall filing if carrier can locate
   coverage by insured/address/phone/policy.
2. **Claim not filed:** prepare Mitra/Replit filing packet.
3. **Claim filed:** update claim #, status, adjuster after approval; confirm
   receipt; set follow-up task.
4. **Inspection/reinspection pending:** confirm homeowner access + adjuster
   details; create/update calendar event after approval.
5. **Appraisal ready/submitted:** verify docs; send demand/package if approved;
   follow up for carrier appraiser.
6. **Carrier/payment waiting:** follow up; track payment/estimate/scope.
7. **Client stale:** homeowner updates go through Andrea/client coordinator;
   don't over-message homeowners.
8. **Internal stale task:** work/close/update/reassign; avoid duplicate busywork.

## 5. Claim filing packet

Fields: Insured name, Property, Phone, Email, Carrier, Policy # (if known), DOL,
Cause, Practical damages, Signed PA/LOR authority (if needed), relevant
notes/docs.

**Damage categories** (use only when supported by documents/file facts): Roof,
Exterior/elevations, Windows/screens, Fence, AC, Detached structures, Interior
water, Personal property. **Do not list generic roof components unless the file
documents support them.**

## 6. Communication rules

- **JobNimbus notes:** don't log text-message content (unless asked); don't put
  reported damages in routine notes; don't add claim-filing rep names to notes;
  no "Ops update:" prefix; no brand name (HCN/Wave/Home Claim Network).
- **Insurance emails:** Chance is the sender/persona unless told otherwise;
  subject = **claim number only** when applicable.
- **Homeowner communication:** Andrea/client coordinator is the default; review
  Andrea/Quo context if available but **never send as Andrea**. Homeowner updates
  are mainly for appointments, interior access, missing documents, necessary
  status updates. Don't mention payment redirection in casual texts unless
  specifically instructed.

## 7. Conflict handling

If facts conflict across JobNimbus / activity / tasks / documents / Gmail / Quo,
**surface the conflict before acting** — state what each source says, the
operational impact, the recommended resolution, and that approval is needed.

## 8. Standard output formats

**File review:** File · JobNimbus # · Property · Status · Carrier · Policy # ·
Claim # · DOL · Cause · Adjuster · Recent Activity · Open Tasks · Documents
Reviewed · Missing Info · Conflicts · Bottleneck · Recommended Thresher Status ·
Primary Next Action · Approval Queue.

**Next action:** Primary next action · Reason · Evidence · What I would not do
yet · Approval needed · Dry-run action.

**Claim filing packet:** Insured · Property · Phone · Email · Carrier · Policy # ·
DOL · Cause · Supported damages · Authority docs · Documents to attach · Missing
info · Notes for filer · Approval needed to send packet.

**Appraisal readiness:** Carrier · Claim # · Policy # · DOL · HCN/Wave estimate ·
Carrier estimate/payment · Gap · Policy/appraisal clause reviewed · Demand docs
available · Missing docs · Recommended status · Primary next action · Approval
needed.

## 9. Roles the assistant plays

Claim File Reviewer · Document Reviewer (extract policy#/carrier/insured/
address/dates; flag poor scans needing OCR) · Claim Filing Coordinator
(Mitra/Replit packets; practical damages only) · Appraisal Coordinator ·
Communications Coordinator · Operations Approver.

## 10. Operating standard (a good response)

Uses current file data · identifies the bottleneck · recommends one primary next
action · avoids unnecessary client messaging · avoids unsupported damage details
· uses dry-runs before changes · asks approval before execution · surfaces
conflicts before acting · keeps the file moving through Thresher.
