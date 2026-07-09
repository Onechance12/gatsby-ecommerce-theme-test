# Carrier Dossier — State Farm

First real carrier dossier, seeded from a recorded filing call
(Quo call id `AC37b5ca…8bad`, Paula → 844-458-4300, ~14 min,
2026-03-18). This is the pattern the Retell agent should follow when filing a
State Farm claim by phone.

## Intake
- **Phone filing line:** 844-458-4300 (also seen: 866-787-8676)
- **Claim docs email:** `statefarmfireclaims@statefarm.com`
  — ⚠️ `statefarm.fireclaims@` (with a dot) **BOUNCES**. Never use the dot version.
- **State Farm books:** ~87 files (2nd most common carrier in the book)

## Phone filing method (speech-driven IVR, "say or press")

State Farm's tree is **speech-first** — you can talk, not just press keys. Path
to a live rep to file a new claim:

1. Caller-type menu — *"customer or someone involved in a claim → 1; attorney →
   2; agent → 3; other carrier/rental/medical/service provider → 4."* → **press 1**
2. *"Tell me your nine-digit claim number, or to file a new claim say **new claim**."*
   → say **"new claim"**
3. *"For English, press 1."* → **1**
4. *"Are you at the scene of an auto accident?"* → **No** (this gate appears even
   for property claims)
5. *"Provide the policy number… if you don't have it, say continue."* → **speak the
   policy number** (it reads it back phonetically — "C as in Charlie" — expect
   confirmation loops)
6. *"Are you the insured, or do you have the insured on the line?"* → **Yes**
7. Damage-type menu — *hail/earthquake → 3; other weather (hurricane, wind, flood,
   rain, snow, freeze, wildfire) → 4; all other → stay on line.* → pick by cause
8. *"What state is your claim in?"* → **speak the state**
9. Privacy notice → **hold for a live rep** (~1 min quoted)

## What the live rep asks, IN ORDER

1. Your name
2. What company you're with → **a public adjuster / representative is accepted,
   no pushback** ("This is [name] with a public adjusting firm calling on a mutual
   client")
3. Policy number
4. (rep confirms the insured's full name back to you)
5. **Date of loss** (MM/DD/YYYY)
6. Any personal/contents items damaged?
7. More than half of the interior damaged?
8. How many rooms — **"two or less, or three or more?"**
9. Damage to ceilings / walls / cabinets / flooring?
10. Best callback phone number

## What you get back
- Rep files it **live and reads the claim number on the spot.**
- **Claim # format:** alphanumeric, no dashes — e.g. rep says "4398 B 407" → enter
  as **`4398B407`**.
- Rep often **volunteers the assigned adjuster's name + phone** (e.g. "Mary Ann
  Hadden, 972-657-3522") — capture it.
- No document-upload instructions were given on the call (send LOR/FIN535 to the
  email above).

## Gotchas / tips for the AI
- Speech-first: answer out loud; only use `press_digit` where the menu says press
  a number (steps 1, 3, 7).
- Be ready early to say you're a **PA on a mutual client** (asked at rep step 2
  and IVR step 6).
- Expect phonetic read-backs of policy/claim numbers — confirm, don't rush.
- Answer the "auto accident scene?" gate **No** for property claims.

## Still needed
- A recorded State Farm **document-submission** instruction (this call didn't
  cover it). Turn on Quo auto-recording to capture the next one.
