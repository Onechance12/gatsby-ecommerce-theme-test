# Filing from an already reviewed packet

Use only after this mode is exposed by a separately approved, attested versioned
Operator release. It adds no route, permission, roster, CRM or calling agent.

## Choose the mode

- Default `full_evidence`: use when AI discovers/selects a filing candidate or
  the user has not explicitly chosen an already reviewed packet. It requires
  complete fresh exact-file Gmail/Quo/JobNimbus review at plan and execution.
- Explicit `reviewed_packet`: use when Chance asks to execute a previously
  reviewed exact-file packet. Do not repeat a full Gmail/Quo audit merely to
  make the call. Gather any missing critical facts; don't invent them.

Keep the existing `retell_claim_call_plan` input and explicit overrides. Add
`reviewMode:"reviewed_packet"` and `packetReview` with these exact fields:

- `fileId`: the live exact JobNimbus ID, not only the display name/file number.
- `reviewedAt`: the actual fact-review timestamp with explicit timezone, within
  24 hours. Do not advance an old timestamp to evade expiry.
- `sources`: 1–30 references containing `source`, `reference`, `reviewMethod`
  and `fields`. Cite the reviewed source for every supplied fact/destination.
  Use exact document/activity IDs; the wrapper verifies those IDs belong to
  this file. Document methods are `native_pages` or `full_text`; activity,
  Gmail-message and Quo-transcript references use `provider_record`;
  `user_provided` facts use `user_statement` with a conversation reference.
  All source-content review remains caller-reported. Inventory membership
  proves neither content nor legal sufficiency. Prior Gmail/Quo references
  are not freshly re-correlated and must not be described as fresh verification.
- `knownStopSignals`: explicitly list any known claim number, prior filing
  attempt, carrier receipt, assigned desk adjuster, claim inspection or pending
  callback. Nonempty stops block a new filing; never suppress a known conflict to
  make a packet pass. An empty list is reported knowledge, not proof of absence.

Explicitly supply insured name, property, carrier and, for a new claim, DOL,
cause, coverage disposition and practical damage details/opening. Preserve
qualifiers, unknown temporary-repair/tarping answers and weather-time uncertainty.
Carrier/policy lookup remains the existing workflow; no license number is added.

## Review and approve one call

The wrapper fresh-checks complete JobNimbus fields/history/tasks/document metadata
and pending callbacks. It checks known stops and binds all supplied packet facts,
the actual call/callback variables, file ID, provenance and fresh JobNimbus
snapshot to one local review receipt. It does **not** read Gmail or Quo in this
mode. A known stop from an earlier full review in the same process cannot be
cleared by switching modes. Retell's atomic call-ledger/active-call/retry/callback
guards remain in the bridge at execution.

Show the complete returned packet, exact destination, readiness, `planDigest`,
`approvalId`, `approvedInput` and `communicationPreflight`. Explicitly state:
**Gmail/Quo history was not rechecked; prior review provenance is caller-reported;
this does not prove the claim is unfiled.** Ask Chance to approve this exact
packet **and those limitations for one live call**. A review receipt, discussion,
general filing request or development/release approval is not call approval.

After approval, repeat every unchanged `approvedInput` field. Execution checks
the live bridge/configuration, fresh JobNimbus snapshot, callbacks, review age
and input binding, without starting another Gmail/Quo audit. Drift, missing
evidence, another plan, expiry/restart or a failure consumes/invalidates approval;
review the ledger/result before a separately approved retry. No approval secrets
or provider content are persisted by this receipt. A fresh process requires a
fresh plan; truthful, still-current review provenance can be reused.

Follow the existing result/transcript/guarded-completion review and separately
approved JobNimbus writeback workflow. This mode sends no email/text, writes no
client record and permits no autonomous filing.
