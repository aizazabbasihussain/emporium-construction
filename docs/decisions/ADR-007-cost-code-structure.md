# ADR-007 Cost code structure

- Status: accepted
- Decided by: owner
- Date: 2026-10-24
- Effect on specs: P1-05
- Inputs: H-25.
- Files: `cost_codes.csv`

## Decision

Top-level codes 100 Materials, 200 Labour, 300 Subcontractors, 400 Equipment and tools, 500 Site expenses, 600 Other (H-25). Sub-codes are added from the UI. The `kind` column needs a fixed value: 500 and 600 are mapped to `overhead` because the allowed kinds have no closer match; this mapping is ours and can be changed from the UI.
