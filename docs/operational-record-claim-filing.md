# Operational Record — AI Claim Filing (redacted)

This is the durable, PII-free record of how the AI claim-filing path actually ran
end to end, and where the deployment boundary sits today. No client names, claim
numbers, phone numbers, call IDs, or Retell/Twilio/LLM identifiers appear here by
design — this file is safe to keep in Git.

## Deployment truth (as of this record)

- **`file:claim` is LOCAL CLI ONLY.** It is not exposed on the Render bridge and
  not reachable from any custom GPT/connector. The only way to run it is
  `node src/index.js file:claim …` on a machine with the `.env` secrets.
- The Render bridge hosts read/handoff endpoints and the artifact mailbox — it
  does **not** place carrier calls, does not run `file:claim`, and does not write
  to JobNimbus.
- Live carrier calling is gated twice: `ALLOW_RETELL_CALLS=true` **and**
  `execute:true` on the command. Absent either, every entrypoint prints a dry-run
  plan and places no call.
- The live Retell agent configuration is generated in code (see
  `configureRetellAgentFromPacket` in `src/voice/retell.js`) from the current
  Mitra prompt plus a post-call analysis schema. Agent/LLM identifiers live only
  in `.env`, never in Git.

## The successful filing path (redacted)

The one real filing that landed followed this exact path:

1. **Entrypoint:** `file:claim` with a file query and `execute:true`, after a
   dry run confirmed readiness (all blockers clear).
2. **Fact gathering (zero Claude tokens):** the command did one live JobNimbus
   contact read, refreshed the filing fields, parsed the inspection-captured
   description lines (storm time / occupancy / damage discovered), looked up the
   carrier filing number from `carrierDirectory.js`, and flattened everything to
   Retell dynamic variables.
3. **Carrier dossier:** the carrier-specific IVR dossier under `docs/carriers/`
   informed the agent's menu navigation.
4. **The call:** the live Retell agent ran the current prompt, navigated the IVR
   with the `press_digit` tool, opened the claim with a human rep, and reached
   the required outcome — a claim/reference number — before closing.
5. **Result capture:** the claim number was read back by the rep and captured.
   At the time of that call the post-call analysis schema was applied manually in
   the Retell dashboard; it is **now configured in code** so it re-applies on
   every agent update and can no longer drift (Q3 below).
6. **Writeback:** the JobNimbus writeback for that first call was done **by hand**
   (fields + one short note). That manual step is exactly what
   `postCallWriteback.js` now automates as a **dry-run proposal** for Chance to
   approve — it never writes on its own.

## What changed to make it production-safe

- **Post-call analysis schema in code** (`postCallAnalysisSchema()` in
  `retell.js`), field names matched to what `postCallWriteback.js` reads, so a
  structured extraction is preferred over transcript regex. Transcript-derived
  values are flagged `transcript-guess` in the bundle's `source` map — never
  presented as high-confidence.
- **Carrier-aware policy readiness:** a missing policy number is a *warning*, not
  a universal blocker; it only hard-blocks for carriers flagged
  `requiresPolicyNumber` in the directory (Wave playbook: carriers can locate
  coverage by insured/address/phone).
- **Writeback hygiene:** structured values (claim #, adjuster, status) go to
  JobNimbus **fields**; the activity note is one short operational line, not a
  field dump.
- **Existing-vs-new outcome:** a captured claim number on a `status_follow_up`
  goal is recorded as `existing_claim_confirmed`, not `claim_filed`.

## Standard filing answers (intentional business defaults — do not change)

For routine residential storm claims Wave files with these standard answers, per
Chance: **no injuries reported, home habitable, temporary repairs made, Titan
Reconstruction is the contractor.** These are overridden only when current
file/homeowner/carrier evidence or Chance establishes an exception, and they are
**not** copied into routine JobNimbus notes.

## Guardrails that stay on

- Dry-run default everywhere; live actions need explicit env flag + `execute:true`.
- Notes require Chance's explicit approval each time.
- No client PII, transcripts, call IDs, or credentials in Git.
- `file:claim` stays off the production bridge until Codex reviews and Chance
  authorizes deployment.
