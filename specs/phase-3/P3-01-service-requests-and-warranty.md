---
id: P3-01
title: Service requests and warranty
phase: 3
module: service
status: not-started
depends_on: [P1-09, P1-05, P1-04]
requires_inputs: [H-20]
---

# P3-01 Service requests and warranty

## 1. Purpose
Record maintenance and repair requests from clients (including warranty claims on finished projects), triage them, and track them to completion, so paid maintenance is handled as a managed service line.

## 2. Boundary
- Owns: tables `svc_*`, module `service`.
- Provides: `getServiceRequest`, `getWarrantyStatus(projectId, date)`, events `service.request.created`, `service.request.assigned`, `service.request.closed`.
- Consumes: master data (clients, locations), projects (project completion date for warranty), files, notifications, identity.
- Must not: schedule work or post costs (work orders do, P3-02).
- Out of scope: WhatsApp or email intake automation (Phase 7), asset registry and QR codes, preventive maintenance and AMC (BACKLOG), customer portal.

## 3. Data model
- `svc_requests(id, number, party_id, project_id nullable, location_id, site_address, contact_name, contact_phone, channel phone|whatsapp|walk_in|email|other, category civil|electrical|plumbing|painting|carpentry|other, priority low|normal|high|urgent, description, received_at, status new|triaged|assigned|in_progress|completed|closed|cancelled, warranty_status in_warranty|out_of_warranty|unknown, billable bool, assigned_to_user, response_due_at, resolution_due_at, closed_at, ...base)`.
- `svc_warranty_terms(project_id pk, warranty_months, starts_on, ends_on)` (set when the project is completed or manually).
- `svc_sla_targets(priority pk, response_hours, resolution_hours)` seeded from H-20.
- `svc_status_history(request_id, from, to, at, by, note)`.

## 4. Business rules
- BR-1 A request needs a client (party) and contact phone; a linked project is optional; request numbers from series `SRQ`.
- BR-2 Warranty: when a project is linked and its warranty term covers the received date, `warranty_status = in_warranty` and `billable = false` by default; the coordinator may override `billable` with a reason (audited).
- BR-3 Warranty terms are created from the project's completion date plus warranty months (setting `default_warranty_months`, H-20 default unset means no automatic term); a term can be edited by management.
- BR-4 SLA targets by priority (H-20) set `response_due_at` and `resolution_due_at` from `received_at`; breaches are flagged (informational) in lists and a daily report; there are no penalties or automatic escalation.
- BR-5 Triage: the coordinator sets category, priority, billable flag and assigns a responsible user; status machine new to triaged to assigned to in_progress to completed to closed; cancel allowed before in_progress.
- BR-6 Closing requires all linked work orders (P3-02) completed or cancelled and a closure note; reopening within 30 days is allowed with a reason.
- BR-7 Duplicate detection: an open request for the same client and site with similar description within 7 days shows a warning (same client, same site address, same category).
- BR-8 Photos and documents attach to requests through files; supervisors and technicians see only requests assigned to them or their teams.

## 5. API and UI
- CRUD `/service/requests`; `POST /service/requests/:id/triage|assign|cancel|close|reopen`; `GET/PUT /service/warranty/:projectId`; `GET /service/sla-report`.
- Screens: intake form (office staff, mobile friendly), request list with SLA flags, triage view, warranty status panel on the project page.

## 6. Permissions
`service.request.create|read|triage|close` (service_coordinator, management, project_manager), `service.request.read-assigned` (supervisor), `service.warranty.manage` (management), `service.sla.manage` (management).

## 7. Test requirements
- T-1 Warranty determination at term boundaries (inclusive end date, no term, linked vs unlinked project) and billable override audit.
- T-2 SLA due-time calculation (hours from received time in UTC, display in Asia/Karachi) and breach flags with a fixed clock.
- T-3 State machine exhaustive; closing blocked by open work orders (fake interface); reopen window.
- T-4 Duplicate warning logic.
- T-5 Visibility for assigned users; supervisor scope.
- T-6 Route contract tests, repository integration tests, component tests; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A warranty request on a completed project is marked in warranty and non-billable by default.
- AC-2 SLA due times are computed and breaches reported.
- AC-3 A request cannot be closed while work orders are open.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-20: SLA targets, warranty months, billing model. Unanswered: stop (SLA values and defaults are business rules).
