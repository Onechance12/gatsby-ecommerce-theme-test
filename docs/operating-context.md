# Operating Context — Chance Pearson / Wave Public Adjusting

This is the durable business context for the assistant. It exists so any new
session (the container is ephemeral) starts already knowing how this business
works instead of re-learning it. Everything here was verified against live
JobNimbus data on 2026-07-09, not assumed.

## Who / org structure

- **Operator:** Chance Pearson — `cpearson@wavepa.com`, JobNimbus user id
  `fc95a213f70e4c9daddc5fa366be9941`. Public adjuster at **Wave Public Adjusting**.
- **JobNimbus account owner:** **Titan Reconstruction LLC** (Dallas, TX). One
  shared CRM used across affiliated brands — this is a **multi-brand account**:
  - Titan Reconstruction (titanrecon.com) — reconstruction / GC side
  - Wave Public Adjusting (wavepa.com) — Chance's brand (public adjusting)
  - Also present: mutualclaim.com, cjhewitt.com, nortonpa.com
  - 55 total users. Profiles: Sales Rep (36), Desk Adjuster (6), Office Manager
    (5), Sales Manager (3), Project Coordinator (3), Production Manager, VP.
- **Named roles in the workflow:**
  - **IPA** — internal public adjuster / file owner lane (most of Chance's work)
  - **Andrea Ramirez** — homeowner contact routing goes through her
  - **Office Admin** — payments / check handling / mortgage
  - **Estimator** — builds Xactimate/ESX scopes
  - External: **Mitra / Replit** referenced for claim-packet filing
- **Current assistant scope:** Chance's files only (53 Insurance contacts of
  1,468 in the account). Broadening to all of Wave, then the whole Titan
  account, is planned but deliberately deferred.

## The pipeline (JobNimbus "Insurance" contact workflow)

All of Chance's files are `record_type_name = "Insurance"` **contacts** (not
jobs — `jobs` is empty for this account; the operational file surface is the
Insurance contact). Workflow statuses, in order:

New Lead → Photo File / Estimate Needed → Ready for PA Review → Submitted
Awaiting Confirmation → Negotiating → Awaiting ACV → Ready for Appraisal →
Submitted for Appraisal → Carrier Appraiser Assigned → Meeting Scheduled →
Initial Approval / Awaiting Estimate → Umpire → Finalized / Awaiting ACV →
Hold/Closed.

Current distribution of Chance's 53 files: Submitted Awaiting Confirmation (19),
Ready for PA Review (17), Photo File / Estimate Needed (7), Submitted for
Appraisal (4), Appointment Set (2), Submitted (2), Review for Close (2).

The assistant maps each file to an internal **Thresher phase** (see
`src/rules/reviewFiles.js`) with an owner lane and expected-days target;
exceeding the target raises "Phase aging risk."

## Custom-field map (account-specific — CRITICAL for reads and writes)

JobNimbus returns this account's custom fields under generated `cf_*` codes.
Some also come back with a human label, many do NOT — so writes and reads must
use the `cf_*` code. Verified mapping for the **Titan/Wave account**:

| Code | Meaning | Sample |
|------|---------|--------|
| `cf_string_1` | Insurance Company | Allstate, State Farm Lloyds |
| `cf_string_2` | Claim # | 430j1z808 |
| `cf_string_4` | Policy # | 58-GY-A149-0 |
| `cf_string_5` | Type Of Loss | Hail |
| `cf_string_7` | Carrier DA (desk adjuster name) | Kimberly Daniels |
| `cf_string_8` | Carrier DA Contact # | 844-458-4300 ext 42218 |
| `cf_string_9` | Carrier DA Email | claims@claims.allstate.com |
| `cf_string_10` | Type of Policy (ACV/RCV) | "ROOF - ACV" |
| `cf_string_12` | HCN Sales Rep | Alex Slocum |
| `cf_long_1` | Deductible Amount | 3000, 14198 |
| `cf_date_1` | Date of Loss | epoch seconds |

These codes are wired into `src/normalize/normalizeFiles.js` as fallback
aliases (human label wins when present, `cf_*` code catches the rest). **If this
tool is ever pointed at a different JobNimbus account, re-verify these codes** —
`cf_string_N` numbering is per-account. Run `npm run map:fields` after a sweep
to regenerate the field map from live data.

## How work actually gets communicated (note vocabulary + rules)

Activity mix on Chance's files: Note (475), Assigned/Unassigned (258), Status
Changed (185), Contact Modified/Created (176), task-related (80), Task Completed
(25). Dominant vocabulary (keyword counts across notes): check (113),
deductible (113), redirect (69), appraisal (54), ACV (49), filed (46), LOR (16),
dec page (14), tarp (11), escalate (7).

Representative real notes (shape of the work):
- "Estimate, ESX uploaded. Ready for PA review, claim filing @ChancePearson"
- "Claim filed. LOR and FIN535 sent to carrier. Awaiting adjuster assignment / inspection scheduling."
- "Appraisal demand sent to Allstate. Claim #… Policy #… DOL… Sent appraisal request letter and Wave/Midwest estimate."
- "Initial ACV rec'd. Ready for appraisal @ChancePearson"
- "Client received a check for $10,659.57. I confirmed I will be picking up check tomorrow."
- "Adjuster inspection scheduled 7/13/26 @ 11:30. Can you let the client know @AndreaRamirez"
- "NI had Farmers policy… now has Allstate. File through Allstate (Farmers is roof ACV)."

### Communication rules the assistant MUST follow (from the encoded playbook)
- **LOR email subject = claim number only.** Signed "Chance Pearson, Wave Public
  Adjusting."
- **Check redirection is sacred:** never advance/allow a check to the client
  before ACV/redirection is confirmed with the carrier and office admin. Status
  "Submitted Awaiting Confirmation" needs **two key confirmations** — carrier
  receipt/desk-adjuster assignment AND check-redirection acknowledgment.
- **JobNimbus notes:** do NOT start with "Ops update:", do NOT name-drop brand
  ("Home Claim Network / Wave Public Adjusting / HCN") in notes, do NOT log
  text/Quo/SMS bodies or reported damages in routine notes.
- **Homeowner contact routes through Andrea** unless directed otherwise.
- **Policy lookup failure** ("carrier couldn't find policy / need current dec
  page / different name") blocks filing until a current dec page or corrected
  insured info is obtained.
- **Appointment access risk:** on files with repeated no-access/no-show history,
  confirm homeowner interior access before rescheduling; send a day-before
  confirmation that requires an actual homeowner reply.

## Documents & tasks

- **Documents (353):** Photo (231), Estimate (86 — incl. 47 `.ESX` Xactimate),
  Document (36). Content types: PDF (306), ZIP (47). Filenames are typically the
  property address, plus "Dec Page", "TDI", "FIN535", "part B".
- **Tasks (130):** Appointment (70), Task (48), Adjuster Meeting (12). Titles
  cluster around **Estimate Inspection (60)**, Adjuster Meeting, "Follow up for
  [carrier] adjuster/appraiser assignment", Interior Photos, plus one-offs
  (emergency tarping, "Create new claim and update NI", reinspections).

## Tool / capability map

What the assistant can touch, and what each is for:

| Tool | Status | Use |
|------|--------|-----|
| **JobNimbus API** | Live, working (read + gated write) | System of record for files, statuses, tasks, notes, docs, payments |
| **Gmail** | Connected | Read scheduling/notes/adjuster threads; **draft** LORs/FIN535/appraisal demands (send stays manual for now) |
| **Google Drive** | Connected | Read templates (LOR, TDI, FIN535), estimates, dec pages |
| **Google Calendar** | Connected | Sync inspection / adjuster-meeting / appraisal windows (America/Chicago) |
| **Twilio** | Connected | AI outbound calls to carriers to file/check claims (separate build) |
| **Quo** | Not yet integrated | Company-wide phone software — the record of ALL human calls/texts. Needed to know what's actually been communicated. Blocked on API docs + a voice-AI decision. |

### Safety model (unchanged, applies everywhere)
- Reads by default. JobNimbus writes require `ALLOW_JOBNIMBUS_WRITES=true` AND
  `execute:true` on the specific call.
- Emails are **drafts only** right now — Chance sends.
- Nothing here commits secrets or client data to git (`.gitignore` covers
  `.env`, `data/`, `reports/`, `work/`).

## The operating loop (how Chance + Claude work a session)

1. Chance opens a session when he wants to work files (on-demand; no schedule).
2. Claude runs `npm run chance:sweep` then `npm run chance:queue`.
3. Claude presents the queue as a readable, per-file summary (not raw JSON).
4. Chance **batch-approves** ("approve 1, 3, 5" / "all except 2").
5. Claude executes approved JobNimbus writes and prepares Gmail drafts.
6. Chance does the final send / spot-check. Session ends — state lives in
   JobNimbus + git, so nothing is lost when the container is reclaimed.

## Open items / next builds

- Wire **Gmail** (read for context + draft LORs) and **Drive** (real templates)
  — current priority.
- **Calendar** sync of inspection/appraisal tasks.
- **Quo** read integration once API docs are available (system-of-record for
  comms) + decide the voice-AI path for Twilio carrier calls.
- Port from the old `jobnimbus-bridge` branch: local OCR (pdftoppm+tesseract),
  bundled `process-update` action, handoff-inbox endpoints.
- Revisit triage tuning: 41 of 53 files flagged High — confirm that reflects
  reality vs. over-aggressive rules (some High flags are true positives, e.g.
  files genuinely missing DOL/adjuster like Robert Frazier).
