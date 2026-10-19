# Reviewed local PDF upload

Use `pdf_upload_plan` and `pdf_upload_execute` only when the compiled cumulative
release exposes them and attests its exact bridge/policy pins, PDF safety flags
and unchanged six-receipt historical isolation. Source code, build/test approval,
old document approval or this skill does not activate the capability or approve
an upload. If the tools or attestation are missing, stop;
do not retry discovery, request another API key, use a browser/raw API upload,
or regenerate a finished PDF. Preserve the artifact and report the release gate.

Once activated and fully attested:

1. Review the final PDF's actual pages and exact client/claim facts using the
   PDF and applicable HCN/preflight skills. The transport checks framing and
   byte integrity, not legal sufficiency, malware or document correctness.
2. Call `pdf_upload_plan` with exactly `{query,path,filename,isPrivate}`. Use one
   exact currently eligible file number, absolute local regular `.pdf` path (no symlinks),
   safe `.pdf` filename and explicit privacy. Maximum size is 8 MiB. A Library
   ID or a remote URL is not a local path; transfer through an authorized file
   route first. Never paste base64 or credentials into chat.
3. Show the complete client/file binding, filename, privacy, size, SHA-256,
   expiry and `approvalDigest`; obtain Chance's approval of that exact upload.
4. Call `pdf_upload_execute` with only the unchanged `approvalDigest` in the
   same persistent MCP session. It uploads the captured bytes, not a reopened
   path. New plans/restart invalidate approval; edits require a new plan.
5. Require the completed receipt's provider `externalId`, exact file, filename,
   size, privacy, SHA-256, `verifiedByReadback:true` and `contentVerified:true`.
   Unknown/partial outcomes use existing receipt recovery; never reupload,
   complete an interrupted reservation, overwrite, delete, or infer success.
6. For a later email draft, use the verified JobNimbus `externalId` as
   `{"source":"jobnimbus","documentQuery":"EXACT-DOCUMENT-ID"}`. Draft creation
   and sending each retain their separate plan and approval. An upload sends
   nothing and does not prove carrier receipt or a stage transition.

The PDF release retains its pinned owner/action policy, fresh assignment checks
when live-assigned, #2628 exclusion and read-only helper. It never assumes a
58-file book. Fred uses this native persistent Mac Operator
session; the read-only `fred.mjs` launcher does not upload. No second AI reviewer
or new model API is required. HCN data stays out of Jobrolo and Chance Brain.

## Approved JobNimbus notes

Notes are available only when the compiled cumulative release is enabled and
attests its exact bridge/policy pins, note safety flags and matching six-receipt
historical isolation. A disabled build cannot acquire note authority through
instructions; do not override its pins to complete a client note.

Only after that release is explicitly activated and attested may a note use a
sole-operation `jobnimbus.create_note` batch with exactly `{query,note}`. Show the
exact file/text and digest, obtain approval, and require provider note-ID and
exact-text-hash readback. Ambiguous writes are reconciled, never reposted.
For a Richard/accounting mention request, prepare one exact canonical
`@RichardR` token before presenting the plan. It binds Richard R, JobNimbus user
ID `kyd3walzugh6dlji6wpygdj`, in `intendedRecipient` with
`mentionRequested:true`. Plain notes bind `mentionRequested:false` and
`intendedRecipient:null`. Do not pass mention fields, other `@` text, repeated
tags, or change the approved text. Require `noteMentionRequestsAllowed:true`
and `noteMentionsAllowed:false` in the attested notes policy.

Both `mentionsVerified:false` and `accountingNotified:false` remain explicit in
every receipt. A saved canonical tag proves only the approved text was saved.
Report a requested Richard mention, not a verified tag or notification, until
separate provider or UI evidence confirms that outcome. Do not silently replace
a requested accounting handoff with a plain note. An operator-authored note is
not independent evidence for a forward stage change. No direct-route, role,
credential or file-scope bypass is allowed.

Use this skill for HCN/Wave and JobNimbus operational work on this Mac.
