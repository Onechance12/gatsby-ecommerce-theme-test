# Evidence reliability repair — Mac bridge

Base: `d8259f8` on `jobnimbus-bridge`. This is NOT the HCN production branch.

## Changed

- Carrier/adjuster routing emails no longer masquerade as homeowner identity and incorrectly veto exact claim matches.
- Per-message filtering preserves known foreign-file exclusions; full decoded content and Bcc are checked before preview truncation. Identifierless replies remain withheld.
- Gmail search, pagination, withholding and preview bounds are reported explicitly.
- Homeowner-phone-only Quo evidence and missing file phones cannot be called complete. Truncated timeline/transcript counts remain visible.
- Incomplete communication history cannot establish an unanswered/awaiting-response state from direction alone.
- Explicit zero transcript limit causes zero transcript requests.

## Observed verification

Both scoped Gmail regressions, syntax and diff checks passed. Quo client suite: 29/29. Mapper suite: 11/11. Final focused communication selection: 25/25 (includes nested tests). All synthetic, with no paid model/provider calls or client effects.

The final full `TMPDIR=/private/tmp npm run check` passed: precheck 48/48 and main 488/488. This branch has no postcheck script. A prior main run had four failures: one changed-behavior collision expectation, and three stale fixtures expecting anonymous operational health/OpenAPI disclosures. The fixtures now verify anonymous and invalid-token health redaction, authenticated diagnostics and schemas, and rejection of browser cookies/scoped operator credentials from broader diagnostics. Their related Quo expectations now explicitly require partial coverage and prohibit inferring an unanswered exchange from incomplete history. Only tests changed in that follow-up; production authentication was not weakened.

## Release boundary

Not deployed. Do not repin the installed operator or bypass its attestation from this patch. Preserve the original dirty iCloud-backed checkout. Broad unmatched Quo sweeps remain denied for the restricted Mac operator. This patch does not implement carrier-call discovery or durable communication retention.
