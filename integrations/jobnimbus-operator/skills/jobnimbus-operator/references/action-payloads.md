# Action Payload Contracts

Use the exact manifest file number in `query`, such as `#2739`. Do not use a name or address as the mutation identifier, and do not guess a payload key.

`jobnimbus.update_contact`:

```json
{
  "query": "#2739",
  "fields": {
    "cf_date_1": "YYYY-MM-DD"
  }
}
```

Send only verified changed keys. The complete safe key set is `display_name`, `email`, `mobile_phone`, `home_phone`, `work_phone`, `address_line1`, `address_line2`, `city`, `state_text`, `zip`, `cf_date_1`, `cf_string_1`, `cf_string_2`, `cf_string_4`, `cf_string_5`, `cf_string_7`, `cf_string_8`, and `cf_string_9`.

`jobnimbus.update_status`:

```json
{
  "query": "#2739",
  "status": "Exact live target stage",
  "transitionEvidence": {
    "reason": "Concrete evidence-supported reason",
    "references": [
      {
        "source": "jobnimbus_activity",
        "id": "provider-record-id",
        "gate": "requiredGateName",
        "fileId": "exact-jobnimbus-id",
        "fact": "Verified fact that satisfies the gate"
      }
    ]
  }
}
```

The reason must be at least 12 characters. Supply a provider-verifiable reference for every cumulative Thresher gate crossed by the forward move, and put that gate name in the reference's required `gate` field. Reference sources are limited to `jobnimbus_activity`, `gmail_message`, and `quo_message`; every reference must bind to the exact JobNimbus ID for the file. JobNimbus tasks cannot prove a stage gate because this same operator lane can author them, JobNimbus document metadata cannot prove a gate because a filename is not verified document content, and Quo call records are not accepted as stage evidence. Do not send a caller-supplied `gates` map: booleans are not evidence, and the bridge derives confirmed gates only after freshly reading and verifying each referenced provider record. The verified fact must affirmatively prove the gate. Negative, unknown, waiting, or pending language is rejected even when it contains a matching keyword. Requests and non-completion artifacts or language—including `request`, `requested`, `checklist`, `template`, `draft`, `proposed`, and `planned`—are also rejected as gate evidence.

- A `jobnimbus_activity` reference must resolve to an exact related **Note** on that file that is not deleted, archived, or explicitly inactive. Events and appointments are not stage evidence.
- A `gmail_message` reference must not carry the `DRAFT`, `TRASH`, or `SPAM` label. Any message or thread correlated to another JobNimbus file or claim is mixed-file/mixed-claim evidence and is blocked.
- A `quo_message` reference must be inbound with status `received` or `delivered`, or outbound with status `sent`, `delivered`, or `completed`. Blank status, `queued`, `failed`, and `canceled` are blocked.

`jobnimbus.ensure_current_task`:

```json
{
  "query": "#2739",
  "title": "Current next step",
  "description": "Do: One concrete next action\nWaiting on: Exact person, provider, document, or None",
  "dueDate": "YYYY-MM-DD"
}
```

Add `taskId` only to adopt one verified existing open task owned by Chance on that exact file. Never supply completion, deletion, archive, or close fields.

`gmail.create_draft`:

```json
{
  "query": "#2739",
  "insuranceClaimEmail": true,
  "to": "verified@example.com",
  "subject": "EXACT-LIVE-CLAIM-NUMBER",
  "body": "Exact plain-text draft body"
}
```

Optional keys are `cc`, `bcc`, a verified `threadId`, and `attachments`. Exact attachment forms include a JobNimbus document (`{"source":"jobnimbus","documentQuery":"exact id or unique name"}`) and the standard W9 (`{"source":"standard_w9"}`). A generated LOR uses `source:"generated_lor"`; do not attempt it until the active `wave-lor-generator` workflow supplies every required generated-LOR field. A Gmail draft must be the only operation in its batch and is never a send.

`gmail.send_existing_draft`:

```json
{
  "query": "#2739",
  "draftId": "EXACT-BRIDGE-RETURNED-DRAFT-ID"
}
```

This must be the only operation in a new approval batch. Do not add `to`, `cc`, `bcc`, `subject`, `body`, `attachments`, `threadId`, `fileQuery`, or any control field. The action sends only the immutable fresh snapshot of the exact bridge-created draft and retains that source draft for separately approved cleanup.
