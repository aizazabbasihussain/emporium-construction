# ADR-002 Tax matrix

- Status: pending
- Decided by: 
- Date: 
- Effect on specs: P1-05, P2-01
- Inputs: H-01 answered; H-02 and H-03 open.
- Files: `tax_authorities.csv`, `tax_rules.csv`, `withholding_rules.csv`

## Decision

Authority FBR only (H-01); no PRA registration yet, one can be added later. The registration number is entered by the owner in the company profile (P1-05), so the column stays blank in the repository. Sales tax rules (H-02) and withholding rules (H-03) are not answered, so `tax_rules.csv` and `withholding_rules.csv` stay header-only (BR-5).
