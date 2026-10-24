---
id: P1-15
title: Daily progress reports (DPR)
phase: 1
module: dpr
status: not-started
depends_on: [P1-09, P1-04]
requires_inputs: []
---

# P1-15 Daily progress reports (DPR)

## 1. Purpose
Supervisors report each day's work, manpower, materials, delays and photos for their project, and project managers review them, giving a dated site record.

## 2. Boundary
- Owns: tables `dpr_*`, module `dpr`.
- Provides: `getDpr`, `listDprs(projectId, range)`, `getMissingDprs(date)`, events `dpr.submitted`, `dpr.reviewed`; a read view `dpr_v_submission_status`.
- Consumes: projects (project, tasks interface `updateTaskProgress`), files, notifications, identity scope. Attendance headcount is read through attendance's query interface when available (P1-17), else entered manually.
- Must not: post costs or change attendance.
- Out of scope: offline draft storage (P1-20), safety and quality forms (Phase 5).

## 3. Data model
- `dpr_reports(id, project_id, report_date, author_id, weather clear|cloudy|rain|extreme_heat|other, work_done text, issues text, safety_notes text, manpower_manual jsonb [{trade, count}], status draft|submitted|reviewed|reopened, submitted_at, reviewed_by, reviewed_at, review_note, ...base)` unique `(project_id, report_date, author_id)`.
- `dpr_task_updates(report_id, task_id, percent_complete, note)`.
- `dpr_material_notes(report_id, description, quantity nullable, unit_code nullable)`.
- Photos via files (`entity_type = dpr_report`), each with caption.

## 4. Business rules
- BR-1 Report date cannot be in the future and may be at most the backdating allowance in the past (kernel rule).
- BR-2 Only the supervisors assigned to the project (and office roles with `dpr.report.create`) can create a report for it; one report per author per project per date.
- BR-3 Submitting requires: work done text (at least 10 characters) and at least one photo, unless the setting `dpr_photo_required` is false (default true).
- BR-4 Task updates: percent complete may not decrease below the project task's current percent without a note; on submit, the project task percent is updated through the projects interface.
- BR-5 A submitted report is read-only for the author; the project manager marks it `reviewed` (with optional note) or `reopened` for correction, after which the author can edit and resubmit; every transition is recorded.
- BR-6 `getMissingDprs(date)` returns active projects with an assigned supervisor and no submitted report for that date; a daily 18:00 Asia/Karachi job notifies project managers of missing reports (not on days marked as site holidays through setting `site_holidays`).
- BR-7 Photos: maximum 20 per report; each at most 10 MB after compression; captions optional; geotag stored only if the client supplies it.
- BR-8 Manpower is shown from attendance counts when attendance exists for that project and date (read through the attendance interface); the manual field remains for trades not tracked.

## 5. API and UI
- `POST /dpr/reports`, `PATCH /dpr/reports/:id`, `POST /dpr/reports/:id/submit|review|reopen`, `GET /dpr/reports`, `GET /dpr/missing?date=`
- Screens: new report form (mobile first: weather, work done, tasks, photos with camera), report list per project, review screen, missing reports list.

## 6. Permissions
`dpr.report.create|update-own` (supervisor on assigned projects, project_manager), `dpr.report.read` (supervisor assigned, project_manager, management, accountant read), `dpr.report.review` (project_manager, management).

## 7. Test requirements
- T-1 Date rules, uniqueness, scope enforcement.
- T-2 Submit validation (text length, photo requirement, setting off).
- T-3 State machine exhaustive including reopen cycle.
- T-4 Task percent update rule and propagation to projects (fake interface).
- T-5 Missing report calculation and the 18:00 job with a fixed clock, holidays, projects without supervisors.
- T-6 Photo limits.
- T-7 Route contract tests, repository integration tests, component tests for the form validation; Playwright: supervisor submits with a photo, manager reviews; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 A supervisor submits a DPR with photos for an assigned project and a project manager reviews it.
- AC-2 A supervisor cannot see or create a report for an unassigned project.
- AC-3 Missing reports are listed and notified at 18:00.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
None. (Paper site report samples, H-14, refine the field list through a proposal in `CHANGES.md` if they differ.)
