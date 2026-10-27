# ADR-005 Numbering series

- Status: accepted
- Decided by: owner
- Date: 2026-10-24
- Effect on specs: P1-01
- Inputs: H-04 and H-27.
- Files: `number_series.csv`

## Decision

Prefixes INV, QUO, PO, PV, RV, VAR, each PREFIX-YYYY-0001, padding 4, yearly reset, starting at 1 (H-27, H-04). Invoices are gapless (assumed in H-04, not yet confirmed by the accountant). No answer asks for the other series to be gapless, so they are marked not gapless. All of it is editable from the UI (P1-01).
