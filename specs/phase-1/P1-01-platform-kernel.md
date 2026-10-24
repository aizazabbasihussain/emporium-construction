---
id: P1-01
title: Platform kernel
phase: 1
module: platform
status: not-started
depends_on: [P0-01]
requires_inputs: [H-04, H-24, H-27]
---

# P1-01 Platform kernel

## 1. Purpose
Shared building blocks every module relies on: audit log, document numbering, transactional outbox and event dispatch, idempotency, typed settings, and the money, quantity and date value objects.

## 2. Boundary
- Owns: tables `sys_*` (except users and roles, owned by P1-02), `packages/domain/kernel`, `apps/api/src/modules/platform`.
- Provides: `audit.record()`, `numbering.next(seriesCode, tx)`, `events.publish(event, tx)` and `events.subscribe(type, handler)`, `idempotency` middleware, `settings.get/set`, value objects `Money`, `Quantity`, `Rate`, `Percent`, `BusinessDate`, `Clock`, `roundMoney()`.
- Consumes: nothing.
- Must not: contain feature-specific rules.
- Out of scope: users, roles, permissions (P1-02); approvals (P1-03); files and notifications (P1-04).

## 3. Data model
- `sys_audit_log(id, at, actor_user_id, action, entity_type, entity_id, before jsonb, after jsonb, request_id)` append-only.
- `sys_number_series(code pk, prefix, padding, reset_yearly bool, gapless bool, next_value bigint, current_year int, ...base)`.
- `sys_outbox(id, type, payload jsonb, occurred_at, dispatched_at)`; `sys_event_consumptions(event_id, handler, consumed_at, unique(event_id, handler))`.
- `sys_idempotency(key, user_id, request_hash, response jsonb, status_code, created_at, unique(key, user_id))`.
- `sys_settings(key pk, value jsonb, description, ...base)` with typed registry in code.

## 4. Business rules
- BR-1 Numbering allocates inside the caller's transaction using a row lock; a rolled-back transaction releases the number (no gap). Output format `<prefix>-<yyyy>-<zero-padded number>` when `reset_yearly` (example `INV-2026-0001`), otherwise `<prefix>-<zero-padded number>`; the year is the business-date year in Asia/Karachi; on the first allocation of a new year the counter resets to `start_value`.
- BR-2 A `gapless` series refuses any operation that would skip, reuse or delete a number; the API exposes no delete for numbered documents of gapless series.
- BR-3 `Money` is Decimal with 2 decimal places and half-up rounding; arithmetic between Money values stays exact; multiplying by a rate or percent rounds only when `roundMoney()` is called at the point a spec names. Float inputs are rejected.
- BR-4 `Quantity` has 4 decimal places; negative quantities are allowed only where a spec says so.
- BR-5 `BusinessDate` is a calendar date in Asia/Karachi. `assertNotFuture(date, clock)` and `assertWithinBackdating(date, clock, days)` enforce date rules; the allowed backdating days come from setting `backdating_days` (default 3, H-24). A caller holding `platform.backdate.override` (admin) may pass a date older than the allowance together with a non-empty reason; the audit log records who, the date and the reason. Without the permission or the reason the date is rejected.
- BR-6 Events are written to the outbox in the same transaction as the change. The dispatcher delivers each event to every subscriber at least once; a handler is skipped if `(event_id, handler)` is already consumed; a failing handler is retried up to 5 times with backoff, then the event is flagged `failed` and surfaced in an admin list.
- BR-7 Idempotency: a repeated request with the same key and the same request hash returns the stored response without re-executing; the same key with a different hash returns 422.
- BR-8 Audit entries cannot be updated or deleted (database rule and absence of any API); entries record before and after for updates and omit secrets.
- BR-9 Settings are typed and validated; unknown keys and wrong types are rejected; changes are audited.
- BR-10 Optimistic concurrency helper: `updateWithVersion(table, id, expectedVersion, patch)` returns a conflict error if versions differ and increments `version`.

## 5. API and UI
- `GET /admin/audit` filter by entity, actor, date range; `GET /admin/outbox/failed`; `POST /admin/outbox/:id/retry`.
- `GET/PUT /admin/settings/:key`; `GET/POST /admin/number-series` (series definitions).
- Admin screens for audit search, number series and settings.

## 6. Permissions
`platform.audit.read` (admin, accountant read-only), `platform.settings.manage` (admin), `platform.series.manage` (admin, accountant), `platform.outbox.manage` (admin), `platform.backdate.override` (admin).

## 7. Test requirements
- T-1 Numbering: sequential allocation; rollback releases; yearly reset; padding; concurrent allocations (10 parallel transactions) produce unique, gapless numbers.
- T-2 Property tests: Money addition is associative and exact; `roundMoney` is half-up for 1,000 random values; Quantity never loses precision on 4 decimals.
- T-3 BusinessDate and backdating rules with fixed clock at boundaries (today, today minus allowed days, minus allowed plus one, tomorrow); override accepted with permission and reason and audited, rejected without permission or without reason.
- T-4 Outbox: event written only if the transaction commits; handler consumed once; retry then failed flag; replay does not double-apply.
- T-5 Idempotency: same key same hash replays; same key different hash returns 422; different users with the same key are independent.
- T-6 Audit append-only: update and delete attempts fail at database level.
- T-7 Settings validation; concurrency helper conflict and success.
- T-8 Route contract tests and repository integration tests; 100% coverage of domain and service code.

## 8. Acceptance criteria
- AC-1 Another module can allocate a number, publish an event and record an audit entry in one transaction in a test.
- AC-2 Gapless series cannot skip numbers under concurrent load (T-1).
- AC-3 All float inputs to Money fail.
- AC-4 Audit rows are immutable.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-04 (tax invoice series rules, needed by P2-02; the kernel supports both modes), H-24 (default 3 days allowed), H-27 (series list and start numbers; seeded from P0-03 when answered, otherwise only a `test` series exists).
