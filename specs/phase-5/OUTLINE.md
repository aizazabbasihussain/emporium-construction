# Phase 5 Outline: Supporting Modules (as needed)

Status: outline. Each module is specified in full only when the business confirms the need. Order is by likely value; none blocks Phases 1-4.

## Candidate specs

| ID (planned) | Title | Scope | Boundary | Depends on | Trigger to build |
|---|---|---|---|---|---|
| P5-01 | Retention on client bills and subcontractor certificates | Retention percent, held amounts, release against invoices and certificates, retention ledger per project | Extends billing (P2-02, P2-04) and subcontracts (P2-06) through their interfaces; no direct table writes | Gate B | A client (likely government) holds retention |
| P5-02 | Statutory deductions | EOBI and social-security rules (accountant supplied), employer and worker shares, monthly deduction lines, summary reports | Extends wages (P1-18) and payroll (P2-07); fields already reserved | Gate B; accountant rules | Business starts registering workers |
| P5-03 | Documents and permits | Drawings with revision control, RFIs, permits and NOCs with expiry reminders, document register per project | New module `documents`; uses files and notifications | P1-04, P1-09 | Drawing and permit volume becomes hard to manage |
| P5-04 | Equipment and rentals | Equipment register, owned and rented machines, allocation to projects and work orders, usage hours, rental cost to cost ledger, service schedules | New module `equipment`; posts costs through the cost ledger | P1-09, P2-05 | Equipment costs matter for project margin |
| P5-05 | Safety and quality checklists | Site inspection checklists, incident log, defect (snag) list and handover punch list with photos | New module `quality`; no financial effects | P1-09, P1-15 | Clients or contracts demand records |
| P5-06 | Worker documents and expiry | CNIC copies, medical, training records with reminders | Extends workforce (P1-16) | P1-16 | Compliance request |
| P5-07 | Recurring service contracts (AMC) | Contract terms, visit schedules, recurring invoices, renewals | Extends service, workorders and billing | Phase 3 | The business starts selling recurring maintenance |

## Rules
- Each module gets its own full spec using `02-spec-template.md`, its own human inputs, and the same testing and git standards.
- No module changes existing module internals; extensions use exported interfaces and events.
