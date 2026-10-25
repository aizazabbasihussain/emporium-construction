# quotations

Lump-sum quotations built from a locked estimate (P1-07): scope, inclusions, exclusions, payment-stage schedule, approval (P1-03), issue, acceptance and expiry. Emits `quotation.issued` and `quotation.accepted`; the project module (P1-09) reacts to the latter.

- `service/` application logic (100% coverage); `policy/` guards; `repo/` SQL; `routes/` HTTP.
- `render/pdf.ts` draws the print model into a text-only PDF. Internal cost and margin are not in the print model, so they cannot appear in the PDF.
- Business rules live in `packages/domain/src/quotations/`.
