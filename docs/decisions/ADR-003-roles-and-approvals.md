# ADR-003 Roles and approvals

- Status: pending
- Decided by: 
- Date: 
- Effect on specs: P1-02, P1-03
- Inputs: H-09 and H-10 answered 2026-10-24; the role-permission matrix is not answered.
- Files: `roles.csv`, `role_permissions.csv`, `approval_rules.csv`

## Decision

Nine roles (H-10): owner, admin, accountant, project manager, estimator, procurement officer, store keeper, site supervisor, labour. The owner approves every item (H-09): requisition, purchase order, expense, payment, quotation, write-off, with one band from 0 and no upper limit and no margin floor. A payment creator still cannot approve it (enforced in code, P1-03). Which role holds which permission is not decided, so `role_permissions.csv` stays header-only; permission codes come from the specs that define them.
