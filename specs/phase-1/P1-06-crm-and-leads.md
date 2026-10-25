---
id: P1-06
title: CRM and leads
phase: 1
module: crm
status: done
depends_on: [P1-05, P1-04]
requires_inputs: [H-16]
---

# P1-06 CRM and leads

## 1. Purpose
Track enquiries from first contact to a won or lost job, with site visits and follow-up reminders, so no lead is forgotten and quotations start from a recorded need.

## 2. Boundary
- Owns: tables `crm_*`, module `crm`.
- Provides: `getLead(id)`, event `crm.lead.won` (with party id and lead id), `createQuotationRequest` hook consumed by P1-08.
- Consumes: master data (parties, locations), files (photos), notifications (reminders), approvals not used.
- Must not: create quotations, projects or invoices.
- Out of scope: marketing campaigns, email integration, WhatsApp intake (Phase 7).

## 3. Data model
- `crm_stages(code pk, name, sort_order, kind open|won|lost, active)`; seeded from H-16 (default: New, Visited, Quoted, Negotiation, Won, Lost).
- `crm_sources(code pk, name)`, `crm_loss_reasons(code pk, name)`.
- `crm_leads(id, number, party_id nullable, contact_name, contact_phone, work_type new_build|boundary_wall|renovation|demolition|restructure|maintenance|other, sector government|private, location_id, site_address, description, expected_value nullable, source_code, stage_code, owner_user_id, loss_reason_code nullable, won_at, lost_at, ...base)`.
- `crm_site_visits(id, lead_id, visit_date, visited_by, notes, ...base)` with photos through files.
- `crm_follow_ups(id, lead_id, due_date, note, assigned_to, status open|done|cancelled, done_at)`.
- `crm_stage_history(lead_id, from_stage, to_stage, at, by)` append-only.

## 4. Business rules
- BR-1 Lead numbers come from series `LEAD`; a lead without a linked party must have contact name and phone.
- BR-2 Moving to a `lost` stage requires a loss reason; moving to `won` requires a linked party (created from the lead contact if needed through master data) and sets `won_at`; won and lost leads are read-only except notes; reopening requires `crm.lead.reopen`.
- BR-3 Stage moves may go forward or backward among open stages; every move is recorded in history.
- BR-4 Each open lead may have at most one open follow-up per assignee per due date; a follow-up creates a reminder notification at 09:00 Asia/Karachi on its due date.
- BR-5 Overdue follow-ups (due date before today, status open) are flagged in lists and in the pipeline report.
- BR-6 A lead's `sector` is mandatory and carries over to the quotation and project (government or private).
- BR-7 Site visit dates cannot be in the future; photos use the shared attachment uploader.
- BR-8 `crm.lead.won` is emitted once per lead through the outbox.
- BR-9 Supervisors have no access; the sales owner sees all leads (single office), configurable by permission only.

## 5. API and UI
- CRUD `/crm/leads`; `POST /crm/leads/:id/stage`; `POST /crm/leads/:id/visits`; `POST /crm/leads/:id/follow-ups`; `POST /crm/follow-ups/:id/done`
- `GET /crm/pipeline` (counts and expected value per stage)
- Screens: lead list with filters, kanban by stage, lead detail (timeline, visits, follow-ups, photos), follow-up list.

## 6. Permissions
`crm.lead.read|create|update`, `crm.lead.reopen`, `crm.visit.manage`, `crm.followup.manage` (management, project_manager, service_coordinator; accountant read-only).

## 7. Test requirements
- T-1 Stage rules: won without party, lost without reason, backward moves, closed leads read-only, reopen permission.
- T-2 Follow-up uniqueness and reminder time at 09:00 Asia/Karachi (fixed clock, including date boundary around midnight UTC).
- T-3 Overdue flag logic with a fixed clock.
- T-4 `crm.lead.won` emitted exactly once even when the stage is set twice.
- T-5 Pipeline aggregation totals match leads.
- T-6 Route contract tests, repository integration tests, component test for the stage change dialog; 100% coverage of service, policy and domain.

## 8. Acceptance criteria
- AC-1 A lead moves from New to Won with a linked party and emits `crm.lead.won`.
- AC-2 A lost lead without a reason is rejected.
- AC-3 Follow-ups notify the assignee on the due date.
- AC-4 Pipeline report equals the sum of leads per stage.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-16 (default allowed: stages New, Visited, Quoted, Negotiation, Won, Lost; sources and loss reasons seeded with generic values and editable).
