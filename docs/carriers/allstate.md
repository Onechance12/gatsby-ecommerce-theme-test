# Carrier Dossier — Allstate

Seeded from a live IVR-navigation test call on 2026-07-09 (Robert Frazier #2768,
Retell agent → 800-547-8676, disconnected at the rep handoff by design). This is
the phone path the agent should follow to open an Allstate property claim.

## Intake
- **Phone filing line:** 800-547-8676 (Allstate National Catastrophe Team) — this
  is the number that shows up as the "Claim Team" / adjuster line on our other
  Allstate files, and it routes straight into new-claim intake.
- **IVR type:** natural-language speech IVR (like State Farm), with a keypad
  fallback offered when speech is ambiguous.
- **Non-policyholders are accepted.** It asks "Are you the policyholder?" — answer
  **No**. It then says "No problem, we can still grab some info from you," so a
  public adjuster's assistant can proceed without the homeowner on the line.

## IVR path (speech-driven)
1. Greeting + privacy notice ("national catastrophe team… value your privacy…
   visit Allstate.com… call may be monitored or recorded"). **Stay silent through
   this whole intro — do not speak until it asks a question.**
2. "I didn't recognize your number. Are you the policyholder?" → **"No, I am not
   the policyholder."**
3. "In a few words, tell me how I can help you today." → **"I need to file a new
   property claim."**
4. Confirmation: "To clarify, you're calling to submit a new claim, right?" → **"Yes."**
5. "Tell me the primary phone number on your account, area code first, or say I
   don't know it." → if the phone on file is unknown, **"I don't know it"** (this
   is fine — it falls through to policy-number verification).
6. "Say or enter the nine or ten digit policy number for the right policy, or say
   I don't have it." → **read the policy number** (e.g. 416920698). "Give me a
   moment to look that up."
7. "Does this claim involve an injury of any kind?" → **"No."** If it falls back to
   keypad ("injury press 1, if not press 2"), **press 2** via press_digit.
8. "That's all I need. I'll get you right over to someone who can help you file
   your claim." → transfers to a **live representative**, who actually opens the
   claim and issues the claim number.

## Notes / gotchas
- **The claim number comes from the human rep, not the automation.** Allstate's
  IVR only routes; it does not self-serve a new-loss claim number. Plan on a live
  rep for the actual filing (unlike a fully automated path).
- Verification is by **policy number** — the account phone number is optional
  ("I don't know it" is accepted).
- Answer the **injury question** first (property hail/wind claim = No); keypad
  fallback is press 2 for "no injury."
- Allstate **claim number format:** 10 digits, sometimes stored with leading
  zeros / a "000…" prefix in JobNimbus (e.g. 0824765085, 0829457522, 000830720090).
- Wait out the full privacy/greeting intro before speaking — the agent clipped a
  "thank you" into the opening notice on the test run.

## For the Retell agent
- `carrier` = Allstate → this dossier's path applies.
- The IVR test confirmed the generic Mitra prompt already handles this tree well
  (policyholder=No, file a new property claim, policy-number verification, injury=No).
- For a REAL filing run (not an IVR test), let it continue past step 8 to the rep
  and follow the Call Optimization Directive to capture claim number, adjuster
  name/phone/email, upload instructions, and next steps.
