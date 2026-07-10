# Claim Filing Core — Input Contract & Usage

`src/claim-filing-core/` is the portable, bridge-ready claim-filing business
logic. It has **no imports** from `fileReview`, sweep reports, CLI parsers/
printers, JobNimbus clients, Gmail, Quo, or the filesystem, and it never reads
`process.env`. The local `file:claim` CLI and the Render bridge adapter both build
on exactly these exports — there is one implementation, not two.

Retell stays the carrier claim-filing engine: it supports DTMF IVR navigation
(`press_digit`), which a pure conversational voice model cannot do.

## Canonical input contract

The caller resolves ONE live Chance file from JobNimbus and shapes it to this
contract (all fields optional; `normalizeClaimFileInput` fills safe defaults):

```js
{
  file: {
    id, customer, address, carrier, policyNumber, claimNumber, dateOfLoss,
    typeOfLoss, status, mortgageCompany,
    contact: { /* raw JobNimbus contact fields — mobile_phone, email, ... */ },
    adjuster: { name, phone, email }
  },
  evidence: {                    // free-text signals for damage/cause inference
    categories: [string],
    recommendedNextAction: string,
    bottleneck: string,
    documents: [{ name }],
    notes: [{ body }],
    tasks: [{ title }]
  },
  captured: { stormTime, occupancy, damageDiscovered },   // inspection capture
  overrides: {                   // approved per-call answers/goal
    goal, carrierPhone,
    injuries, homeLivable, temporaryRepairs, contractorHired,
    occupancy, damageDiscovered, stormTime
  }
}
```

The `overrides` (and the same keys passed as the `options` arg to
`buildClaimCallPacket`) let a specific file override the standard answers or the
goal per call.

## Exports (from `src/claim-filing-core/index.js`)

| Export | Purpose |
| --- | --- |
| `normalizeClaimFileInput(raw)` | Coerce a raw shape to the canonical input. |
| `buildClaimCallPacket(input, options)` | The goal-specific call packet (objective, verified facts incl. resolved standard answers, damage summary, scripts, capture list, stop rules, result format). |
| `normalizeGoal(value, file)` / `cleanClaimNumber(v)` | Goal + claim-number helpers. |
| `STANDARD_FILING_ANSWERS`, `resolveStandardAnswers(overrides, {stormLike})` | The four Chance-approved defaults, overrideable per call. |
| `inferCause(file, evidence)`, `inferDamageCategories(file, evidence)` | Cause + damage categorization from evidence. |
| `lookupCarrier(name)`, `knownCarriers()` | Data-driven carrier directory (incl. `requiresPolicyNumber`). |
| `assessReadiness(packet, to, carrier)` | Carrier-aware readiness (missing policy is a warning unless `carrier.requiresPolicyNumber`). |
| `existingClaimBlock(claimNumber, goal)` | Duplicate-new-claim guard for the adapter. |
| `flattenFactsForDynamicVariables(packet)`, `PROMPT_PLACEHOLDERS` | Retell dynamic variables (defaults every placeholder). |
| `buildRetellLlmFromPacket(packet, options)`, `renderRetellPrompt(packet)`, `postCallAnalysisSchema()` | Retell prompt, tools (`end_call` + `press_digit`), and the post-call analysis schema. |
| `extractCallResults(call)`, `inferOutcome(...)`, `transcript*` | Post-call extraction with **per-field source** (`retell-analysis` / `transcript-guess` / `none`). |
| `buildWritebackProposal(file, ex)` | DRY-RUN JobNimbus proposal: `proposedFields`, `fieldConfidence`, `proposedNote`, `unverified`, `outcome`. |

## Company rules preserved

- **The four standard filing answers are the defaults** — no injuries reported,
  home habitable, temporary repairs made, Titan Reconstruction as contractor —
  and are overrideable per call. They are **not** copied into routine notes.
- **Policy-number requirement is data-driven** via the carrier directory
  (`requiresPolicyNumber`), not hard-coded.
- **New-vs-existing outcome is distinct**: a captured claim number on a
  `status_follow_up` goal is `existing_claim_confirmed`, not `claim_filed`.
- **Writeback confidence**: structured (`retell-analysis`) values become proposed
  fields; transcript-guessed adjuster phone/email/document destinations are
  surfaced in `unverified` and are **not** silently written as verified fields.
- **Accurate note**: the short note never claims an adjuster/status field was set
  when it wasn't, and never says "awaiting adjuster" when one was captured.

## Writeback safety

`buildWritebackProposal` proposes; it never writes. The local wrapper
(`src/assistant/postCallWriteback.js`) adds the gated, dry-run-first CLI commands.
A bridge adapter should keep the same gates (approval + explicit execute) and its
own JobNimbus write path.

## What is NOT in the core

HTTP/transport and gating stay out: `src/voice/retell.js` owns
`configureRetellAgentFromPacket` / `triggerRetellCall` / `fetchRetellCallResult`
(they take an explicit `config` and enforce the free-trial + execute gates). The
Render adapter supplies its own JobNimbus reads/writes and OpenAPI surface.
