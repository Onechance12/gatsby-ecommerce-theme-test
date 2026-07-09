# Observed Patterns — learned from real JobNimbus files

Captured 2026-07-09 by reviewing complete real file timelines (esp. Paula Smith's
Maria Olguin file — 71 activities, lead→billed over a full year — and a live
Chance/Richard appraisal, Jose Jimenez). This is how the team *actually* works,
beyond the documented playbook. Names are real coworkers, not clients.

## The real status ladder (fuller than account settings shows)

Hot Lead → Contracted (→ Contracted-Hold) → Ready for PA Review → Photo File /
Estimate Needed → Submitted Awaiting Confirmation → Negotiating → Submitted for
Appraisal → Carrier Appraiser Assigned → Appraisal Inspection Scheduled →
Appraisal Umpire → Appraisal Finalized (Awaiting ACV) → Ready for Production →
Ready for Billing → Billed. (Files bounce backward often; status is not strictly
linear.)

The tail after settlement — **Ready for Production → Ready for Billing → Billed**
— is the reconstruction/GC (Titan) side taking over once the claim money lands.
"Dep invoiced" = depreciation billed at the end.

## Team roles (real people)

- **Sales reps** (Nick Timms, Abe Silva, etc.) — lead, contract, collect
  deductible terms, initial photos.
- **Paula Smith** (Office Manager, now inactive) — the model file-runner:
  carrier calls, voice-to-voice with insured, driving status, capturing
  adjuster info, check redirection + relentless check chasing.
- **Andrea Ramirez** (Office Manager) — intake, scheduling, homeowner
  coordination, **check pickup**, repair scheduling / certificate of completion.
- **Richard R** (VP) — oversight, approvals, escalation decisions (e.g. invoke
  umpire), bilingual client comms.
- **Estimators** (Joel Harvey, Grace Fuentes, Damaris Fuentes) — ESX / Xactimate
  estimates, "@Richard for approval."
- **Appraisers** (Bert Hood) — appraisal inspection, umpire recommendation.
- **Chance Pearson** (Wave PA) — PA review + claim filing lane.

## Note conventions (mirror these when drafting notes)

- **`*****FILE NOTE*****`** header for substantive file events, esp. carrier/
  insured contact. Records **"voice to voice"** when live contact was actually
  made (vs. voicemail/text) — this distinction matters to them.
- **`CC TITAN NOTES:`** and **`CS UPDATE`** — running, dated logs appended over
  time ("6/9 Client updated via txt. 6/10 Client texted…").
- **`DEDUCTIBLE INFORMATION:`** intake block — Amount / How it will be covered
  (e.g. "3 referrals", payment plan) / DCW uploaded? / Part B signed?
- **Financial breakdowns** spelled out: `RCV / Depreciation / ACV` with dollar
  figures, e.g. "Dwelling $12,412.52 ($2,233.75) $10,178.77". "ACV 5368.65."
- **@mentions route work** — @RichardR, @PaulaSmith, @AndreaRamirez,
  @ChancePearson, @GraceFuentes. This is their task-handoff mechanism.
- **Language flags** — "SPANISH ONLY" / "Spanish speaker" on client comms.
- Display name gets the **claim # appended** ("Maria Olguin # …8409").

## Check redirection (core practice — this is why it's "sacred")

Checks must be **redirected to the office address, not the client.** Real files
show the whole subprocess: confirm redirection with carrier, track check #,
chase reissues when a client loses/withholds a check ("client is being cagey"),
watch for the carrier mailing to the client by mistake. Tasks named
**"CHECK PICKUP"** and **"Check Status"** structure this. The client typically
owes their **deductible** and may hold an **interest check** — tracked explicitly.

## Appraisal flow in practice

Ready for Appraisal → send **appraisal demand** (appraisal request letter +
Wave/Midwest estimate) to the carrier's claims email → confirm receipt → request
**carrier appraiser assignment** → capture appraiser contact → appraisal
inspection → if no agreement, **umpire** (invoice paid) → **award** → finalized /
awaiting ACV → check redirection → production. "Midwest" and "Roofr" appear as
estimate/measurement vendors; "FIN535/TDI" are the authority/state forms.

## Already-present automation footprint

An API actor named **"Chance Local Assistant"** already appears writing to
JobNimbus (status changes, contact field updates, appraisal-demand notes) — the
earlier Codex bridge. New writes from this project will show under whatever actor
the API key maps to; be deliberate about that so history stays clean.

## Implications for the assistant

- The triage rules only model the middle of the pipeline; extend awareness to the
  **production/billing tail** and the **check-chasing subprocess** (a High-value,
  easily-stalled stage).
- When drafting notes, **match their format** (FILE NOTE header, voice-to-voice
  flag, financial breakdowns) rather than inventing a new style.
- Cross-file learning is worth continuing: Paula's and Richard's files are the
  best templates for "what good looks like."
