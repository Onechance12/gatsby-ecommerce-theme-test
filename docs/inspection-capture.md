# Inspection Capture — the field walkthrough that makes a file filing-ready

The inspection is where every carrier filing question gets answered. If Chance
captures these on-site (the way he walked Robert Frazier's property), the claim
can be filed later with zero "I'll have to follow up" gaps, and the voice agent
has a real answer for everything a rep asks.

**The loop:** walk the property → dictate/answer the items below → save it to the
JobNimbus file (a structured inspection note, plus a couple of Description/field
writes) → the claim-call packet reads it back automatically on the filing call.

## What to capture (each maps to a carrier filing question)

### Loss basics
- **Cause of loss** — hail / wind / hail+wind / water / other → `Type Of Loss` field
- **Date of loss** — confirm against the DOL report → `Date of Loss` field
- **Time of storm** — from the DOL report (NOAA), we no longer guess → Description
  `Time of Loss:` line
- **How/when discovered** — "homeowner noticed ceiling stain the morning after,"
  "roofer found hail bruising during a free inspection," etc. → Description
  `Damage Discovered:` line

### Occupancy & habitability (reps ask these on almost every new claim)
- **Occupancy** — owner-occupied / tenant-occupied / vacant → Description
  `Occupancy:` line
- **Home livable?** — yes / no (if no, note why + any displacement) → answered live
- **Temporary repairs made?** — none / tarp / board-up / water mitigation (who did
  it, when) → answered live
- **Contractor hired?** — default is NO; the homeowner retained Wave Public
  Adjusting as their representative. Only note a contractor if one is genuinely
  engaged.

### Damage scope (the full range, not just the roof)
Walk it like Robert's: roof (layers, slopes, test squares, material), then
gutters/downspouts, fascia/soffit, windows/screens, siding/elevations, fence,
HVAC/soft metals/vents/flashing, detached structures (shed, garage, carport —
and their material), and interior room by room (which rooms, water vs. impact,
approx dimensions). → the scope note + damage categories on the packet.

### Policy/contact housekeeping (grab if not already on file)
- Policy number, carrier, deductible, mortgage company
- Best homeowner contact (phone/email) — but the claim's callback is always our
  Quo line 972-573-1730

## Where it gets saved
- **Structured inspection note** (one JobNimbus Note via `create_jobnimbus_note`)
  — the human-readable scope + the answers above, so it lives on the file's
  activity timeline like Robert's scope note did.
- **Description lines** (via `append_jobnimbus_description`) for the few
  structured, reusable facts the agent reads on calls: `Time of Loss`,
  `Occupancy`, `Damage Discovered`.
- **Native fields** (via `update_jobnimbus_contact`, gated) for the ones that have
  real JobNimbus fields: Date of Loss, Type Of Loss, Policy #, Deductible.

All writes stay dry-run-first + `execute:true` gated, same as every other write.

## Inspection note template (paste-ready)
```
INSPECTION SUMMARY — <Client>, <address> — <date>

Cause of loss: <hail/wind/...>   Date of loss: <date>   Storm time: <from DOL report>
Occupancy: <owner-occupied/tenant/vacant>
Home livable: <yes/no + note>
Temporary repairs: <none/tarp/etc.>
Contractor hired: <none — represented by Wave PA>
How discovered: <...>

Exterior:
- Roof: <material, layers, slopes, test squares, hail/wind findings>
- Gutters/downspouts: <...>
- Fascia/soffit: <...>
- Windows/screens: <...>
- Siding/elevations: <...>
- Fence: <...>
- HVAC/soft metals/vents/flashing: <...>
- Detached structures: <shed/garage/carport + material + findings>

Interior (room by room):
- <room>: <water/impact, approx size, findings>

Notes: <anything else the carrier will want>
```
