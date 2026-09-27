# Private retained job activity export

Supports Jobrolo becoming the durable job record as individual files are worked.
This increment is a bounded, explicit per-file capture, not continuous inbox
monitoring or a claim that all carrier communication has been reviewed.

## Contract and rollout

- Signed POST `/integrations/jobrolo/v1/file-activity-export`.
- Requires the existing authenticated assigned-file principal and explicit
  `retentionIntent: private_job_history`.
- `JOBROLO_ACTIVITY_EXPORT_ENABLED=true` is required. Default remains off.
- Consumer must keep records private to the exact actor, tenant and saved job.
- Existing `file-review` remains ephemeral/no_store; no operator credentials or
  existing temporary previews were repurposed for retention.
- No provider mutation, model invocation, automatic trigger or new credential.

The response includes stable actor/provider/file record identities, revision
digests, occurrence times, full bounded matched email/SMS bodies and source
coverage. Maximum20 records/provider,60 total,12,000 characters/body and1.5MiB
UTF-8 overall. Truncation/omission is explicit; retries produce the same records.

## Deliberate limitations

Quo currently uses the homeowner-number history and call metadata. Carrier-call
discovery, voicemail/transcript capture, background ingestion, ambiguous-match
review, document binaries and full backfill remain unfinished. Gmail attachments
are not copied here. JobNimbus tasks/documents are metadata only.

## Verification

Synthetic-only `TMPDIR=/private/tmp npm run check` completed successfully:
207 precheck,834 main,2 Google journey and61 management-report tests. Focused
export/isolation suite12/12. Signed HTTP tests cover own/foreign actor scope,
stable replay, no raw identity disclosure and zero provider writes.
`git diff --check` passed. No live source reads, rollout flag changes or deploy.

Rollout requires companion Jobrolo schema/private-storage/UI/read-tool change,
owner approval to enable retained source capture, then a bounded live check.
Neither a successful deployment nor an empty capture proves complete coverage.
