# Backlog — tabled ideas (not built yet)

Ideas Chance wants to build later. Captured so they persist across sessions.
Do not start these without Chance saying "let's build X" — they're parked.

---

## 1. Per-carrier dossiers (a "skill/resume" per insurance carrier)

**The idea:** a dedicated reference file for each carrier we deal with (Allstate,
State Farm, Travelers, Conifer, USAA, Farmers, Liberty Mutual, Foremost,
Progressive, National General, Nationwide, American Modern, Wellington, etc.).
When working any file, we pull up that carrier's dossier to know exactly how
they operate and adapt our PA strategy.

**What each dossier holds:**
- Claim intake: claims email(s), phone numbers, upload portal, fax, the
  subject-line rule (claim # only, etc.)
- Adjuster/TPA info: known desk/field adjusters, TPAs they use (e.g. Conifer →
  Claims Consultants / Cody White; State Farm → in-house)
- Their claims **method**: do they inspect before/after us, use their own
  adjuster vs a TPA, how fast they move, how they communicate
- How they **estimate**: what they tend to include/exclude, known lowball
  patterns (e.g. State Farm writing "no shingle damage" and closing), how they
  handle supplements and appraisal
- What works against them as a PA: what arguments/evidence move them, appraisal
  posture, escalation paths
- A running log of real interactions so the intel compounds over time

**Why it's valuable:** turns every claim into learning. Over time we know each
carrier's playbook and can counter it faster.

**Feasibility:** HIGH. This is the same pattern as our existing docs
(operating-context.md, templates-and-carriers.md). We're ALREADY accumulating
this — real intel gathered so far:
- Allstate: claims@claims.allstate.com (claim # in subject routes to file)
- State Farm: statefarmfireclaims@statefarm.com — **statefarm.fireclaims@ (with
  a dot) BOUNCES**; inspects then writes minimal estimates and closes (saw this
  on Maribel Munoz — "no shingle damage")
- Travelers: uses an upload portal (claim.travelers.com), adjuster emails direct
- Conifer: uses TPA "Claims Consultants" (adjuster Cody White,
  cjwhite@codywhiteinsuranceadj.com)

**Rough build:** `docs/carriers/<carrier>.md` per carrier, plus maybe a
`carrier:brief <name>` CLI command that surfaces the dossier + every file we
have with that carrier + recent activity. Seed the first few (Allstate, State
Farm, Travelers, Conifer) from what we already know.

---

## 2. Xactimate-style line-item estimate database + generator

**The idea:** a maintainable database (spreadsheet-like) of every line item and
price, so we can generate an estimate that reads like an Xactimate report —
without needing to be in Xactimate for a first pass.

**Why it's valuable:** speed. Turn an inspection scope (like Robert Frazier's)
straight into a priced draft estimate we can hand off or use to sanity-check the
carrier's number.

**Feasibility / honest caveats (why this is bigger than #1):**
- Xactimate pricing (Verisk) is **proprietary and licensed** — we can't copy
  their price database. Prices are also **region-specific** (price list per ZIP)
  and **updated monthly**. Replicating Xactimate itself is not realistic/legal.
- What IS realistic: OUR OWN maintained price list — line items with unit prices
  Chance/estimators enter and update, that we store and use to auto-build a
  formatted, itemized estimate (qty × unit price, by area/trade) from a scope.
  It won't match Xactimate's exact codes/prices, but it's a fast internal draft.
- Structure: a CSV/JSON price list (item, unit, unit price, category) that's
  easy to update, + a generator that takes the scope breakdown (like the
  inspection scope notes) and outputs a priced, sectioned estimate (PDF/CSV),
  reusing the Chromium PDF pipeline we already built for the LOR.

**Rough build:** `data/pricing/pricelist.csv` (Chance-maintained) +
`src/documents/estimateGenerator.js` (scope + pricelist → itemized estimate PDF)
+ `estimate:build <file>` CLI command. Start small: the trades from real scopes
(roof, elevations/paint, windows/screens, fascia, gutters, interior drywall,
detached structures) and grow the list over time.

**Open question for Chance:** do you want this to feed INTO Xactimate (export a
scope you paste in), or fully replace a first-draft estimate outside Xactimate?
That changes the design.

---

## 3. Link Retell ↔ Quo (Chance's "ideal world")

**The idea:** Retell's AI calls should live inside Quo (OpenPhone) like any human
call — visible, recorded, reviewable in one place — not siloed in Retell.

**What's free already:** if Retell dials a Quo number, that leg shows up in Quo.
Retell also records + transcribes its own calls (GET /v2/get-call).

**The real link (harder, separate systems):** after each Retell call, push its
transcript/recording/outcome into Quo (as a note on the conversation) and/or
into the JobNimbus file. Or explore whether the Retell "from" number can be a
Quo/OpenPhone number via SIP so outbound AI calls originate from a Quo line.
OpenPhone BYO-SIP support is the open question. First feasible version: a bridge
that, on Retell's call-analyzed webhook, writes the summary+transcript to
JobNimbus (and optionally Quo) automatically. Tabled.

---

## 4. Carrier-specific filing methods (feeds BOTH the dossiers AND the Retell agent)

**The idea:** each carrier files claims differently (different phone tree, different
info in different order). The AI caller must file "in the right manner" per carrier.

**The data exists in Quo:** every recorded claim-filing call your team made IS
that carrier's filing method. Carrier claims lines identified from JobNimbus
adjuster fields (cf_string_8):
- Allstate: 800-547-8676, 800-806-5570
- State Farm: 844-458-4300, 866-787-8676
- USAA: 210-531-8722 · Conifer: 386-610-9570 · Foremost: 469-512-5897 · Nationwide: 866-425-9200

**Build:** mine Quo — pull the team's calls TO each carrier line, keep the
recorded ones, pull transcripts, and extract per carrier: the IVR path (which
digits to press, in order), what the carrier asks for and in what sequence, the
"gotchas." Store as a `filingMethod` per carrier (part of the dossier in idea #1).

**Two consumers:**
1. Carrier dossier — a "How to file with <carrier>" section.
2. Retell agent — pass the carrier's filing method as a per-call dynamic variable
   (e.g. {{carrierFilingSteps}}) so the generic agent navigates THAT carrier's
   specific IVR correctly instead of generically. Ties directly into the reusable
   agent already built.

---

## 5. Callback handling (skip the hold — huge minute/token saver)

**The idea:** many carriers offer "press X to request a callback instead of
holding." Use it: the AI requests a callback to our Retell number, hangs up
(stops burning minutes on hold), then ANSWERS when the carrier calls back and
files the claim. Chance's insight — this is the most efficient way to use the AI.

**Feasibility:**
- ✅ Retell supports INBOUND agents — the AI can answer an incoming call. So
  "have the AI pick up the callback and file appropriately" is possible.
- ⚠️ Inbound isn't wired yet. The RoofOps Twilio trunk currently has termination
  (outbound) but ZERO origination URLs — so callbacks to +18176867361 won't
  reach Retell until we add Twilio Origination → Retell's inbound SIP and assign
  the claim-filing agent as the number's inbound_agent.
- ⚠️ THE HARD PART — context matching: when the carrier calls back, it has no
  idea which claim it's about. We need a small "pending callbacks" store: when an
  outbound call requests a callback for file X, record {carrierNumber, fileFacts,
  requestedAt}. On the inbound callback, match by caller's number + recency and
  load THAT file's facts as the inbound agent's dynamic variables so it files the
  right claim. Handle one pending callback at a time in v1 to avoid collisions.

**Build order:** (a) wire Twilio origination → Retell inbound + assign inbound
agent; (b) pending-callback store + matcher; (c) teach the agent to REQUEST a
callback (part of the carrier filing-method work in idea #4 — some carriers'
IVRs offer it) and to answer-and-file on the inbound leg. Depends on idea #4
(knowing each carrier's callback option) and the reusable agent (already built).

## 6. Intake gaps flagged by the claim-call audit (2026-07-09)

Two standard carrier filing questions have NO JobNimbus source field today, so
the voice agent can only defer on them:

- **Occupancy** — "owner occupied / who lives at the property?"
- **Damage discovered** — "how/when was the damage first noticed?"

**Fix (cheap):** add both to the client intake questions / JobNimbus custom
fields so every new file carries them. Once fields exist, wire them into
`buildClaimCallPacket` (they already have `{{occupancy}}` and
`{{damageDiscovered}}` placeholders waiting in the agent prompt).

Related: **storm time** now comes out of the DOL report
(`recommendedStormTime`) and is fed to calls via `{{stormTime}}`. Decision made
2026-07-09: write it into JobNimbus **on command only** (not automatically on
every DOL run) — needs Chance to pick the target field (existing custom field
vs. a note on the file) before the write tool is built.
