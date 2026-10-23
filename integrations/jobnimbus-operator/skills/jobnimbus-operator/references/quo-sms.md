# Exact Quo SMS

This source adds `quo_sms_plan` and `quo_sms_execute`, but they are absent unless
`quo-sms-release.mjs` is compiled with separately reviewed exact bridge,
current policy/owner, historical-isolation, and Operator package
pins. Source/build approval does not activate them or authorize a message. If
either tool or its SMS policy flags are missing, stop; never use generic Quo,
the browser, a raw API/key, a one-shot script, or a different worker.

After activation, call `quo_sms_plan` with exactly `{query,from,to,content}`.
Use one exact numeric currently eligible file, the exact verified Wave sender in E.164,
the exact freshly file-bound recipient in E.164, and the complete final text.
Show Chance the file, sender, recipient, full text, content SHA-256/count,
expiry, approval digest and unique `approvalId`. Only explicit approval of that
exact plan permits `quo_sms_execute` with both identifiers. The encrypted local
snapshot survives an unchanged same-Mac reconnect; unrelated plans coexist.
A same-file/action replacement, changed text, sender/recipient change, expiry,
build, boot or policy drift blocks the old approval and requires a fresh plan.
Follow the session/approval reference for temporary preflight holds and unknown
outcomes. Never transfer challenges or delegate execution of this approval.

Accept completion only when the receipt has an exact Quo provider message ID,
`verifiedByReadback:true`, matching sender/recipient/content hash/count, and a
delivery status. Queued/sent is not delivered. Any partial/unknown outcome uses
the existing exact-batch reconciliation once; it never resends. Missing ID or
unprovable state quarantines the file. Approval of a PDF, draft, note, call,
earlier text, or this candidate's release never authorizes a client SMS.
