---
name: chance-file-ops
description: Run the Chance Pearson / Wave Public Adjusting JobNimbus operations loop — sweep live claim files, build the approval queue, present it for batch approval, then execute approved JobNimbus writes and prepare Gmail LOR drafts. Use whenever Chance wants to work his files, "run the queue", "what needs approval", "push claims forward", review a specific claim file, or draft an LOR/appraisal demand. Encodes Wave PA's communication rules and the read-first / approval-gated safety model.
---

# Chance File Ops — JobNimbus operations loop

The operating playbook for **Chance Pearson, Wave Public Adjusting**.

- **`docs/hcn-wave-ops.md`** = the authoritative procedure & rules (Chance's own
  ops playbook: review workflow, Thresher logic, priority rules, packet template,
  communication rules, conflict handling, standard output formats). **Follow it.**
- **`docs/operating-context.md`** = the account facts (org, custom-field map,
  tool map, note vocabulary).

Read both before real work. Operating principle: use fresh file data, name the
one real bottleneck, propose ONE primary next action, and never execute anything
until Chance approves the exact action.

## Preconditions

- `.env` present with `JOBNIMBUS_API_KEY` and `JOBNIMBUS_USE_FIXTURES=false`.
- Confirm live access first if unsure: `npm run probe` (must show contacts/jobs
  visible, not just authenticated).

## The loop

1. **Sweep** — `npm run chance:sweep`. Pulls Chance's live Insurance files,
   normalizes, triages into Thresher phases, writes `reports/chance-sweep.{md,csv}`.
2. **Queue** — `npm run chance:queue`. Builds `reports/chance-approval-queue.json`:
   per-file, what needs approval, proposed + supporting actions, workflow gates.
   Regenerate if older than ~30 min.
3. **Present** — summarize the queue for Chance as a readable, per-file list
   (customer, status/phase, bottleneck, the proposed action). NOT raw JSON.
   Group by priority. Call out anything with check-redirection or two-key-
   confirmation risk explicitly.
4. **Batch approve** — Chance replies with which items to approve ("approve
   1,3,5" / "all except 2"). Default posture: nothing executes without his yes.
5. **Execute** — for approved items:
   - JobNimbus writes: `npm run chance:approve -- '{"ids":[...],"execute":true}'`
     (requires `ALLOW_JOBNIMBUS_WRITES=true` in env).
   - Emails (LOR / FIN535 / appraisal demand): prepare as **Gmail drafts only**.
     Chance sends. Subject = claim number only; signed "Chance Pearson, Wave
     Public Adjusting."
6. **Confirm** — report back what was written / drafted; Chance does the final
   send and spot-check.

## Single-file review (outside the full loop)

- `npm run review:file -- "<name | claim# | address | carrier>"` — full read of
  one file (phase, bottleneck, risks, next 3 actions, tasks, timeline).
- `npm run chat:tool -- review_file '{"query":"<name>"}'` — same as structured JSON.

## Communication rules (never break)

- Reads by default; JobNimbus writes need `ALLOW_JOBNIMBUS_WRITES=true` +
  `execute:true`. Emails are drafts only.
- Check redirection is sacred — never advance a check to the client before
  ACV/redirection is confirmed with carrier + office admin.
- JobNimbus notes: no "Ops update:" prefix, no brand name in notes, never log
  text/SMS/Quo bodies or reported damages.
- Homeowner contact routes through Andrea Ramirez unless told otherwise.
- Policy-lookup failure (carrier can't find policy / needs current dec page)
  blocks filing until a current dec page / corrected insured info is obtained.

## Safety

- Never commit or paste `data/` (real client PII), `.env`, or `reports/`.
- Custom fields are account-specific `cf_*` codes — see the map in
  `docs/operating-context.md`; wrong code = wrong write.
