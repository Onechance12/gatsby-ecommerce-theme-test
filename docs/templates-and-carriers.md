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
