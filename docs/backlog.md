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
