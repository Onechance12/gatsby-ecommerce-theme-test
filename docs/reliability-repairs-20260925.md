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

The full suite is NOT green. After dependency setup, precheck passed 48/48; main run initially had four failures. One changed-behavior collision expectation was corrected and passed targeted tests. Three remaining assertions expect anonymous operational health/OpenAPI disclosures even though the pinned implementation protects them. They were inspected against `d8259f8`, not repaired by weakening authentication. Full main/postcheck acceptance remains blocked and must be resolved before release.

## Release boundary

Not deployed. Do not repin the installed operator or bypass its attestation from this patch. Preserve the original dirty iCloud-backed checkout. Broad unmatched Quo sweeps remain denied for the restricted Mac operator. This patch does not implement carrier-call discovery or durable communication retention.
