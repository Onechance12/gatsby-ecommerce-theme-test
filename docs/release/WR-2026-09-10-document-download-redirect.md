# JobNimbus document download redirect repair

Principal claim: `codex/hcn-document-download-redirect`, based on deployed
`2e93e0c6d2f2f2f5c613d2bd089d8f8ce74759f4`. Scope is the existing signed exact-file
document-byte transport, not a new reader, router, import, credential, or actor role.
Chance approved repair/release of Jobrolo and HCN followed by no-effects live checks.

## Evidence

Jobrolo PR361 is live at86530213ec5bdf8412a68a4c06d9878884264865. The live model now
successfully called exact-phone Quo history and paged beyond the newest12 names
to the older PDFs. Three PDF-content reads reached HCN and returned503 in roughly
0.8–1.7seconds. This is not an OCR failure or proof the files are absent.

The existing document-content handler used the bounded binary helper, which
rejects every redirect. Its established operational downloader follows redirects.
A read-only browser open of the same source file observed an actual302 from
app.jobnimbus.com/api1/files/[id] to files.jobnimbus.com, then200 application/pdf.
No query strings, credentials, headers, or document contents are recorded here.
The precise API Bearer-request failure is not independently exposed; the live
post-release retest is required to confirm the suspected incompatibility.

## Bounded change

Keep generic binary fetch redirect rejection. The provider-specific wrapper
allows only one validated HTTPS files.jobnimbus.com CDN hop from the exact
configured JobNimbus document endpoint, with no userinfo, fragment or non443
port. The CDN request receives no authorization/cookie headers. Both requests
share the existing body-inclusive deadline and byte limits, and each consumes
the route's explicit request budget (seven direct reads, at most eight with CDN).
Manifest matching, source ownership, response signature/hash and all approval
boundaries remain unchanged. No approved-copy or customer-record action is run.

Principal owns server integration, release and live retest. The existing bounded
subagent review workflow delegates only binary helper/tests; a separate reviewer
will inspect the complete diff before release. Synthetic tests must cover success,
host spoofing, downgrade/userinfo/fragment/port rejection, second redirects,
credential removal, shared deadlines/size bounds and request-budget denial.

## Verification and release

Ten focused binary tests passed. The actual signed HTTP fixture passed direct
byte delivery, stale-manifest rejection, disallowed redirect rejection and safe
diagnostic-log assertions. Full `TMPDIR=/private/tmp npm run check` passed201
prechecks and795 main tests; syntax and whitespace checks passed. Log:
`/tmp/hcn-document-redirect-final-check.log`. Independent source review found no
P1/P2 blocker; it explicitly retains the initial `/files` versus observed browser
`/api1/files` compatibility as an unknown until the live retest.

[PR34](https://github.com/Onechance12/gatsby-ecommerce-theme-test/pull/34) merged
as83c45d6302c2270b3e6d94a848f0d5a6dd404a04, with zero changed files relative to
tested94eaf08. Renderdep-dah14pjl550s73d4qek0 became live at2026-09-10T02:14:39Z.
Public provider-attested metadata reports the exact commit; release-critical
configuration drift is aligned and health returns200. No Shell/SSH, environment
change or duplicate deploy.

Bounded live acceptance passed at02:15:34–40Z in the same saved private Rolo chat:
the actual27-page policyPDF returned complete embedded text for requestedpage1;
the one-page scanned contractor form returned OCR for its requested page. Both
HCN byte requests returned200 with no failed extraction pages. This confirms the
configured production API route works with the scoped CDN repair. Rolo exposed
conflicting source facts and kept preparation pending, distinguishing OCR from
signature validity and renewal offer from active coverage. Remaining PDF pages
were intentionally unread. No import/copy, approval, send, call, or source-record
change was performed; this is not live copied-file persistence certification.
Reload retained the successful read summary, exact limits, pending preparation,
tool receipt and document action card.
