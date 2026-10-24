# Phase 7 Outline: Analytics, Portals and Notifications

Status: outline. Built only when users show a need.

## Candidate specs

| ID (planned) | Title | Scope | Boundary | Depends on |
|---|---|---|---|---|
| P7-01 | Management dashboards | Owner dashboard (cash position, receivables, project margins, alerts, open jobs) from existing report interfaces | Read-only; no data copies | P2-08, P3-05 |
| P7-02 | Client portal | Project progress, photos, invoices and statement view, service request submission and tracking; read-only access scoped by client | New module `portal` with its own auth role; exposes only whitelisted DTOs; government data rules apply | Gate C if hosting government clients |
| P7-03 | WhatsApp and SMS notifications | Provider integration behind the notification interface (P1-04), templates, delivery status, opt-in records, payment reminders and appointment messages | Notifications module extension | P1-04 |
| P7-04 | Scheduled reports | Email or WhatsApp delivery of selected reports on a schedule | Uses export helpers | P1-19, P2-09 |
| P7-05 | Vendor and subcontractor portal | POs, certificates and payment status visible to the vendor | New module `portal` extension | P2-05, P2-06 |
| P7-06 | Forecasting and analytics | Cash-flow forecast, cost-to-complete model improvements, vendor scoring | Read-only analytics over existing modules | P2-08 |

## Rules
- Every portal exposes only explicit allow-listed fields and passes a dedicated permission and data-leak test sweep.
- Messaging providers must meet the residency policy for any government-related content.
