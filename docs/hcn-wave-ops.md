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
  files. (Jobrolo, mentioned in the source pack, is a separate product Chance is
  building — unrelated to this account; ignore it.)
- **Fresh data first:** review current JobNimbus data before advising; never
  rely on memory or old chat context.
- **One primary next action** per file. Don't let stale-task cleanup distract
  from the main move that advances the claim.
- **Approval first (dry-run = proposed only).** Never execute without exact
  approval: JobNimbus field updates, notes, tasks, status/contact changes,
  calendar events, Gmail drafts, sent emails, Quo texts, AI voice-agent claim
  filing calls. When approval is needed, present an execution approval queue.

> **Claim filing method (updated):** Mitra/Replit is **no longer used**. Claims
> are filed by the **AI voice agent (Twilio + OpenAI)** calling the carrier
> directly. Where older text below says "Mitra/Replit packet," read it as "the
> structured filing info the voice agent needs before it dials." The packet
> template in §5 is still how that info is assembled.

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
6. **Close out executed work** — verify the API result and preserve a private action receipt. A receipt proves what happened; it is never approval for the next action.

## 3. Thresher status logic (next actions per phase)

- **Photo File / Estimate Needed:** review photos/docs, confirm damage
  categories, complete estimate, then move to PA review.
- **Ready for PA Review:** review estimate + policy/dec page + coverage; decide
  file / negotiate / supplement / prepare appraisal.
- **Claim Filing / Intake:** locate policy/dec page, assemble the filing info
  (§5), confirm authority docs, then file via the AI voice agent (Twilio/OpenAI)
  after approval. Don't auto-stall if the carrier can locate coverage by
  insured/address/phone/policy.
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
2. **Claim not filed:** assemble filing info (§5) and file via the AI voice
   agent (Twilio/OpenAI) after approval.
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

This is the structured info the **AI voice agent** needs before it calls the
carrier to file (it is no longer a Mitra packet). Fields: Insured name, Property,
Phone, Email, Carrier, Policy # (if known), DOL, Cause, Practical damages, Signed
PA/LOR authority (if needed), relevant notes/docs.

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
- **Documents:** download and validate incoming attachment bytes before relying on them. Validate every outgoing PDF and final MIME payload before drafting/sending. Check for bounces or acknowledgements after send.
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
address/dates; flag poor scans needing OCR) · Claim Filing Coordinator (assemble
filing info for the AI voice agent; practical damages only) · Appraisal
Coordinator · Communications Coordinator · Operations Approver.

## Richard's standard (VP, from a real file audit — treat as law)

Richard Rinella (VP, richard@wavepa.com) audits Chance's files. Direct quotes:

- **"Sweep means all files touched, updated, problems attacked!"** A sweep is
  not complete until *every* file has been moved forward — not just reviewed.
  This is the definition the assistant must hold: surface each file's one next
  action so none sit.
- **"DO NOT LET FILES SIT FOR ANY REASON. YOU AS THE ASSIGNED ADJUSTER ARE IN
  CHARGE OF ALL YOUR FILES. DO WHATEVER IS NECESSARY TO KEEP ALL FILES MOVING.
  STUCK FILE = INEVITABLY UNHAPPY CLIENT AND/OR CANCELLED SALE!"** Files
  untouched for ~2 weeks are flagged "NOT GOOD." If blocked waiting on Andrea or
  Richard, **chase them down** — don't let the block be an excuse to stall.
- **Data hygiene:** carrier adjuster name/phone go in their **own fields**
  (Carrier DA / cf_string_7-9), NOT crammed into the claim-number field. Put each
  value in its correct field.
- Files must sit in the **correct status** (e.g. move a filed-and-awaiting file
  to "Submitted Awaiting Confirmation" / "Awaiting 2 Key Confirmations").

Context: Chance is relatively new ("a decent file count for a beginner"), so the
assistant's job is to help him hit Richard's standard consistently — every file
moving, correct statuses, clean fields, nothing sitting.

## Watch for email-address typos (real, costs LORs)

Chance's sent mail shows bounced LORs from address typos:
`statefarm.fireclaims@` (should be `statefarmfireclaims@`), `calims@calims.` (should
be `claims@claims.`). Always send to the verified address in
`docs/templates-and-carriers.md`; if drafting, double-check the carrier address.

## 10. Operating standard (a good response)

Uses current file data · identifies the bottleneck · recommends one primary next
action · avoids unnecessary client messaging · avoids unsupported damage details
· uses dry-runs before changes · asks approval before execution · surfaces
conflicts before acting · keeps the file moving through Thresher.
