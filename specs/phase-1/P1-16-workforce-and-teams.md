---
id: P1-16
title: Workforce and teams
phase: 1
module: workforce
status: done
depends_on: [P1-05, P1-04]
requires_inputs: [H-12]
---

# P1-16 Workforce and teams

## 1. Purpose
Keep records of the company's own workers (about 50), their pay basis and rates over time, and the teams they belong to under each supervisor, so attendance and labour cost have a reliable base.

## 2. Boundary
- Owns: tables `lab_*`, module `workforce`.
- Provides: `getWorker`, `getWorkerRate(workerId, date)` (returns pay basis, daily-equivalent rate), `getTeamMembers(teamId, date)`, `listTeamsForSupervisor(userId)`, events `worker.changed`, `team.membership.changed`.
- Consumes: master data (labour contractor parties, trades are a local list), files (CNIC copy photo), identity (supervisors are users).
- Must not: record attendance or compute wages.
- Out of scope: attendance (P1-17), wages (P1-18), statutory deductions (BACKLOG), HR leave management and documents expiry (Phase 5).

## 3. Data model
- `lab_trades(code pk, name)` (mason, helper, carpenter, steel fixer, painter, electrician, plumber, driver, other; editable).
- `lab_workers(id, code, full_name, father_name, cnic, phone, trade_code, employment_type permanent|daily|contract, contractor_party_id nullable, joined_on, left_on nullable, status active|inactive, bank_or_wallet_info text nullable, ...base)`.
- `lab_pay_rates(id, worker_id, pay_basis daily_rate|monthly_salary, amount numeric(18,2), effective_from date, effective_to nullable, set_by)`.
- `lab_teams(id, code, name, supervisor_user_id, active)`; `lab_team_members(team_id, worker_id, from_date, to_date nullable)`.

## 4. Business rules
- BR-1 CNIC is mandatory for permanent and daily workers (13 digits, unique among active workers); contract workers brought by a contractor may omit CNIC only if `contractor_party_id` is set.
- BR-2 A worker has at most one active pay rate on any date; rate periods cannot overlap; amount greater than zero; a new rate closes the previous one the day before.
- BR-3 `getWorkerRate(workerId, date)` returns the rate in effect or an error when none exists; the daily-equivalent for `monthly_salary` is the salary divided by the working-days basis setting (H-11).
- BR-4 A worker belongs to at most one team on any date; membership periods cannot overlap; assigning a worker to a new team ends the old membership the day before.
- BR-5 Each team has exactly one supervisor (a user with role `supervisor`); a supervisor may have several teams; the supervisor's team and project scopes feed access rules.
- BR-6 Deactivating a worker (leaving) requires `left_on`, ends the team membership and the open pay rate on that date; history remains; a worker with unapproved attendance cannot be deactivated before `left_on` is reached (error lists sheets).
- BR-7 Rate changes are audited; rates are visible only to roles with `workforce.rate.read` (supervisors cannot see wages).
- BR-8 Phone numbers normalized as in master data; sensitive fields (CNIC, bank info) are masked in lists (last 4 digits) and in logs.
- BR-9 Importers: workers, pay rates, teams and memberships.

## 5. API and UI
- CRUD `/workforce/workers`, `/workforce/trades`; `POST /workforce/workers/:id/rates`; CRUD `/workforce/teams`; `PUT /workforce/teams/:id/members`; `GET /workforce/teams/mine`.
- Screens: worker list and profile (rate history), team board (drag workers between teams), supervisor's team view without rates.

## 6. Permissions
`workforce.worker.read` (supervisor limited to own teams, project_manager, management, accountant), `workforce.worker.manage` (management, accountant), `workforce.rate.read|manage` (accountant, management only), `workforce.team.manage` (management, project_manager).

## 7. Test requirements
- T-1 CNIC rules and uniqueness; contractor exception.
- T-2 Rate period logic: no overlap, new rate closes old, lookup on boundary dates, none found error; property test: for random non-overlapping periods, lookup returns the period containing the date.
- T-3 Team membership overlap rules; moving workers; supervisor assignment.
- T-4 Deactivation rules and blocking by unapproved attendance (fake interface).
- T-5 Visibility: supervisors never receive rate fields (assertions on DTO keys); masking.
- T-6 Importers for all four tables.
- T-7 Route contract tests, repository integration tests, component tests for the team board; 100% coverage of domain, service and policy.

## 8. Acceptance criteria
- AC-1 50 synthetic workers across several teams load via import; rates and memberships resolve correctly by date.
- AC-2 A supervisor sees only members of their teams and no pay information.
- AC-3 Rate history is complete and audited.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
H-12: pay basis and rates per worker. Unanswered: stop before loading real rates; tests use synthetic values.
