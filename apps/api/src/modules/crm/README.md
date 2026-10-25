# crm

Leads from first contact to won or lost, with site visits, follow-up reminders and the pipeline
(spec P1-06). Tables are `crm_*`. The module creates no quotations, projects or invoices.

Other modules read a lead through `getLead(db, id)` and react to the event `crm.lead.won`
(`{ leadId, partyId, number, sector }`). The `createQuotationRequest` hook of the spec is consumed by
P1-08, which reads the lead and listens to `crm.lead.won`; this module adds no quotation table.

Choices where the spec leaves room (none changes a rule):

- Lead numbers come from the number series `lead` (prefix `LEAD`, `LEAD-0001`). The series code is
  lower case because the platform requires `^[a-z0-9_]+$`.
- Stages, sources and loss reasons are seeded from the H-16 defaults (New, Visited, Quoted,
  Negotiation, Won, Lost) and stored in tables, so they can be edited with SQL or a later screen.
  A new lead starts in the first active stage of kind `open`.
- The lead description is the lead's notes: it is the one field a won or lost lead still accepts.
- Winning a lead without a client creates one through master data from the contact name and phone.
  If master data reports a client with the same name and phone, the move is refused with
  `duplicate_warning`; link that client to the lead and win again.
- A lead is reopened into an open stage by a holder of `crm.lead.reopen` (admin, management).
  `crm.lead.won` is emitted once per lead, even if it is reopened and won again (`won_event_emitted`).
- Closing a lead (won or lost) cancels its open follow-ups. A follow-up that is completed or
  cancelled after its reminder was scheduled still delivers the reminder, because the notifications
  module can schedule reminders but not withdraw them.
- Visits and follow-ups cannot be added to a closed lead. Deleting a lead is a soft delete and only
  allowed while it is open.
- Events: `crm.lead.changed`, `crm.lead.stage_changed`, `crm.lead.won`, `crm.visit.recorded`,
  `crm.followup.changed`.
- Site visit photos use the file entity type `crm_site_visit`: readers of leads see them, visit
  managers add and remove them.
- The sales owner sees all leads (single office). Supervisors hold no CRM permission; the accountant
  reads only.
