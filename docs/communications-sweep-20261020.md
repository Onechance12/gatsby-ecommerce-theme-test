# Read-only recent communications sweep — release candidate

This restores inbox-first discovery without weakening exact-file evidence or
effect controls. It is not deployed or activated by changing source code.

## Scope and behavior

- `POST /ops/recent-communications`, native tool `communications_sweep`.
- Dedicated `codex-mac-operator` identity only; backend
  `ALLOW_OPERATOR_COMMUNICATION_SWEEP=true` and a separately enabled, versioned
  native package are both required. Default off. No legacy/admin credential
  fallback and no changes to the existing broad recovery route.
- Default rolling seven days; configurable 1–30 days and 1–100 returned items.
  Optional `source: quo` or `gmail` allows a latest-voicemail-only investigation.
  Window instants are UTC; present them in America/Chicago to Chance.
- Quo reads only the employee's configured line. Recent conversation activity
  is discovered before client matching, including inactive/done conversations.
  Calls/texts in both directions are context; missed calls use the dedicated
  `/call-voicemails/{callId}` endpoint. Available answered-call transcripts are
  reviewed separately, never implied by the call log.
- Gmail first verifies the profile against the configured Chance mailbox.
  Search is date-bounded, not limited to scheduling keywords. Incoming, sent,
  draft, and automatic messages remain distinct. Spam/trash and out-of-window
  thread history are explicitly excluded.
- File matching uses the complete fresh identity index. Claim/file references,
  property plus insured/policy, or globally unique homeowner contact can yield
  a lead. Shared carrier numbers and surnames alone cannot. Known other-file,
  conflicting other-file, and excluded #2628 records are withheld and counted.
  Unidentified own-inbox callers remain visible, without invented client links.
- Later sent contact, later drafts, human email, and automated replies are
  separate reference lists. Bounces are urgent delivery-failure review items,
  not human replies or successful acknowledgments. None proves resolution or
  carrier acceptance.
- Source/provider failures, pagination limits/repeats, body truncation, pending
  voicemail, unavailable speech, output omissions, and budgets remain explicit.
  Never turn partial coverage into "no response exists" or "all calls reviewed."
- Read-only discovery never marks read, sends, calls, uploads, saves client
  memory, writes JobNimbus, creates schedules, or clears claim preflight.

## Review and rollout

Run `npm run test:communications-sweep`, `npm run check`, the communication
evidence tests, and the native package suite using synthetic fixtures only.
The candidate preserves all effect gates, policy actions/hash, six historical
never-replay receipts, approval challenges, and wrong-file protections.

Before rollout: review the change, deploy the approved exact bridge commit,
enable only this read-only gate, create the matching versioned Operator package
with its exact provider-attested bridge pin and communications capability,
then install/reconnect and require `bridge_restart_verify` ready. Do not edit
the running plugin cache or disable build/capability checks. Only after that
verification may a human-requested live sweep be run, starting with the newest
missed voicemail. A software release approves no outbound client action.

## Provider contracts

- [Quo voicemail](https://www.quo.com/docs/mdx/api-reference/calls/get-a-voicemail-for-a-call)
- [Quo conversations](https://www.quo.com/docs/mdx/api-reference/conversations/list-conversations)
- [Quo calls](https://www.quo.com/docs/mdx/api-reference/calls/list-calls)
- [Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
