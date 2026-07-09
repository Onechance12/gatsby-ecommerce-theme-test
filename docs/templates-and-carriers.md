# Chance's real email templates + carrier directory

Learned 2026-07-09 from Chance's actual sent Gmail (cpearson@wavepa.com). Use
these verbatim patterns when drafting — they match how Chance really writes.
Client-specific values shown as {placeholders}. Drafts only; Chance sends.

## Signature block (every carrier email)

```
Thank you,
Chance Pearson
972-573-1730
cpearson@wavepa.com
Wave Public Adjusting LLC
3500 Oak Lawn Ave #460C
Dallas, TX 75219
TX Lic # 3351885
```

## Subject line rule (confirmed in real sends)

Subject = **claim number only**. Real examples: `0000222459`, `0828116814`,
`43-0J0R-143`, `430B1G890`, `0827140401`. No prose in the subject.

## Template A — LOR + FIN535 to carrier (with payment redirection)

Subject: `{claim number}`
```
Good afternoon,

Attached please find an executed FIN535 and LOR for the above referenced claim
(policyholder: {Insured Name}). Please send payment to our office with Wave
Public Adjusting LLC included as a payee.

{signature block}
```

## Template B — LOR delivery to a named adjuster

Subject: `{claim number}`
```
Good afternoon, Attention {Adjuster Name}.

Please see the attached letter of representation for {Insured Name}.

{signature block}
```

## Template C — follow-up: confirm LOR receipt

Subject: `{claim number}`
```
Hello,

This is Chance Pearson with Wave Public Adjusting. I am following up on
{Carrier} claim {claim number}. Please confirm whether {Carrier} has received
our Letter of Representation for this claim.

{signature block}
```

## Template D — W9 to carrier/TPA (comes up for payment setup)

Subject: `Re: {claim number or thread subject}`
```
Good afternoon,

Attached is the W-9 for payment purposes.

{signature block}
```

## Carrier / TPA claim-intake email directory (verified from real threads)

| Carrier / TPA | Claims intake email | Notes |
|---|---|---|
| Allstate | claims@claims.allstate.com | |
| State Farm | statefarmfireclaims@statefarm.com | **No dot.** `statefarm.fireclaims@statefarm.com` BOUNCES — do not use. |
| Wellington Insurance Group | claims@wellingtoninsgroup.com | adjuster contact: swalk@wellingtoninsgroup.com |
| Catalytic Claims Services (TPA) | aurodriguez@catalyticclaimsservices.com | cc jwilliams@catalyticclaimsservices.com |

(Extend this table as more carriers/adjusters appear in real threads.)

## Official document templates (from Google Drive)

### LOR — Letter of Representation (Drive: "LOR Format" / "LOR ")
The actual letter attached to carrier emails. Fill {placeholders}.
```
Wave Public Adjusters LLC
TX License #: 3351885
3500 Oak Lawn Ave, Suite 460C
Dallas, TX 75219

DATE: {date}
CARRIER: {carrier}
INSURED: {insured name}
ADDRESS: {property address}
DOL: {date of loss}
CLAIM #: {claim number}

Attention Claims Department:

Please be advised that we, Wave Public Adjusters, represent the named insured
for their loss as stated above. We have previously forwarded to you a copy of
our Texas Public Adjusters Agreement with the insured (FIN535). As stated by the
insured, we hereby request that all further communication and correspondence
regarding this claim be directed to this office.

The name "Wave Public Adjusters, LLC" must be included on all drafts, checks,
and correspondence pertaining to this loss, and mailed directly to:

Wave Public Adjusting LLC
3500 Oak Lawn Ave #460C
Dallas TX 75219

Kindly contact me as soon as possible to discuss this loss or set an appointment
to inspect this claim.

Sincerely,
Chance Pearson
cpearson@wavepa.com
972.573.1730
Wave Public Adjusting LLC
3500 Oak Lawn Ave #460C
Dallas, TX 75219
```
Drive file id: `1spXUc1vXGv0bPUpkqsWvL2y6ira9sDHEoK9c-hFaJUQ` (Chance's copy).
Note: an older shared "LOR Format" from Richard used a different address (8300
Douglas Ave) / phone (806.678.0907) — use Chance's current one above.

### Appraisal Request Letter (Drive: "Appraisal Request Letter", owner richard@wavepa.com)
Invokes the appraisal clause. Written/signed as if from the **insured**.
```
{date}
{insured name}
{property address}

Attention: Claims Department, {Carrier}
RE: Claim # {claim number}
TRANSMITTAL BY E-MAIL

This letter is to notify you that we strongly disagree with the amount of loss
you have calculated on the above referenced claim. As a result of our inability
to reach a mutually agreeable settlement, we are hereby invoking the appraisal
clause of our policy. We are also attaching a copy of our contractor's damage
assessment.

We have selected Bert Hood as our appraiser. He can be reached at:
Bert Hood
Ph: (817) 676-7065
E-mail: hoodbert10@gmail.com

We appreciate your prompt attention to this matter. Please notify us, as well as
our chosen appraiser as to whom you will be naming as your appraiser. Please
include as much contact information you can on this individual so the appraisal
process can begin as soon as possible.

Sincerely,
{insured name}
```
Drive file id: `1Rsvg9VfLygFOFpNhFpeTy8vdnUeLx1rWIFjG2qOIFlM`.
**Standard appraiser: Bert Hood — (817) 676-7065 — hoodbert10@gmail.com.**

### Appraisal demand — carrier cover email (accompanies the letter + estimate)
Subject: `{claim number}`
```
Claims Department,

Please see the attached appraisal demand letter and contractor estimate for
{Insured Name}.
Claim #: {claim number}
Policy #: {policy number}
Property: {property address}
Date of Loss: {DOL}

{signature block}
```

## Template refinements (from Richard/Paula guidance)

- Payee name in the LOR/cover email is the **PA entity that holds the file** —
  for Chance that's **"Wave Public Adjusting LLC"** (Richard's sample said
  "Norton Public Adjusters LLC" because that was a Norton file). Always match the
  insured's actual PA brand.
- **Paula's extra sentence** to add when requesting docs: *"In addition, could
  you please send over the insured's policy package and any correspondence."*
- The signed **FIN535 lives in each JobNimbus file**; the LOR is a Drive doc you
  copy per-claim; the W9 is a static PDF ("Wave W-9.pdf").

## Documents referenced

- **LOR** — Letter of Representation (PA authority).
- **FIN535** — Texas Dept. of Insurance PA contract/disclosure form.
- **W9** — for carrier to set up Wave PA as payee.
- Carriers send back a **PA acknowledgment / representation acknowledgment
  letter** confirming receipt; watch for it to advance the file.

## Attachment note

These emails attach PDFs (executed LOR/FIN535/W9). The Gmail connector creates
the draft text; attaching the actual signed PDF is a manual step for Chance
unless/until the assistant is wired to pull the file from Drive/JobNimbus and
attach it. Draft the body + subject + recipient; Chance attaches + sends.
