---
id: P1-03
title: Approval engine
phase: 1
module: approvals
status: not-started
depends_on: [P1-02]
requires_inputs: [H-09]
---

# P1-03 Approval engine

## 1. Purpose
A single, configurable way to approve documents (requisitions, purchase orders, quotations, variations, expenses, attendance, adjustments, payments) with amount-based routing and separation of duties.

## 2. Boundary
- Owns: tables `apr_*`, `packages/domain/approvals`, module `approvals`.
- Provides: `requestApproval({docType, docId, amount, requesterId, context})`, `getApprovalState(docType, docId)`, `cancelApproval(...)`, events `approval.approved|rejected|returned|cancelled` with `docType` and `docId`.
- Consumes: identity (roles, users), kernel (audit, events).
- Must not: change the business document itself; owning modules react to approval events and change their own status.
- Out of scope: the approval limits themselves (H-09, loaded from `approval_rules.csv`); notification delivery (P1-04).

## 3. Data model
- `apr_rules(id, doc_type, min_amount, max_amount nullable, effective_from, active, ...base)`; `apr_rule_steps(rule_id, step_no, role_code, min_approvers default 1)`.
- `apr_requests(id, doc_type, doc_id, amount, requester_id, status pending|approved|rejected|returned|cancelled, current_step, rule_id, submitted_at, decided_at, ...base)`.
- `apr_actions(id, request_id, step_no, actor_id, action approve|reject|return, comment, at)` append-only.

## 4. Business rules
- BR-1 When a request is created, the rule whose amount band contains `amount` and that is effective on the date is selected; no matching rule means the request is refused with a clear error (never auto-approved).
- BR-2 Steps run in order; a step is complete when `min_approvers` distinct users holding the step's role have approved.
- BR-3 Separation of duties: the requester cannot approve their own request, even if they hold the role; one user cannot approve two steps of the same request.
- BR-4 `reject` ends the request as rejected (a comment is mandatory); `return` sends it back to the requester as returned (comment mandatory) and the requester may resubmit, creating a new request version for the same document.
- BR-5 Amount changes on the document after submission cancel the pending request; the module must resubmit.
- BR-6 Only one open request per `(doc_type, doc_id)`.
- BR-7 Approvers see only requests whose current step role they hold; scoped roles (supervisor-like) also respect project scope for the document if the owning module supplies a scope in `context`.
- BR-8 Rule bands for a doc type must not overlap or leave gaps between 0 and the highest band; band edits are versioned by `effective_from` and audited; changes do not affect pending requests.
- BR-9 Delegation and escalation timers are out of scope (BACKLOG).
- BR-10 Every action emits an event through the outbox and an audit entry.

## 5. API and UI
- `POST /approvals/requests` (module-to-module call, also exposed for admin testing); `GET /approvals/inbox`; `GET /approvals/requests/:id`
- `POST /approvals/requests/:id/approve|reject|return` with comment
- `GET/PUT /admin/approval-rules/:docType`
- Screens: approval inbox (pending items with document summary link), request detail with history, rules editor.

## 6. Permissions
`approvals.inbox.read` (any approver role), `approvals.rule.manage` (admin, owner via management role), `approvals.request.read` (requester and approvers).

## 7. Test requirements
- T-1 Rule selection at band boundaries (min inclusive, max exclusive convention stated and tested), no matching rule.
- T-2 Multi-step flow, `min_approvers = 2`, duplicate approver rejected, requester blocked, same user across steps blocked.
- T-3 Exhaustive state machine test of allowed and forbidden transitions.
- T-4 Reject and return require comments; resubmission creates version 2; one open request per document.
- T-5 Amount change cancels request.
- T-6 Band validation (overlap, gap, negative).
- T-7 Events emitted exactly once; replay safe.
- T-8 Property test: for random rule sets and approver sequences, the request never reaches `approved` unless every step's quorum is met by distinct, eligible, non-requester users.
- T-9 Route contract tests, repository integration tests, component tests for inbox; 100% coverage of service, policy and domain.

## 8. Acceptance criteria
- AC-1 A test document type can be submitted, routed through two steps and approved, emitting `approval.approved`.
- AC-2 A requester can never approve their own request.
- AC-3 A request with no matching band is refused.
- AC-4 Rule edits do not change pending requests.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-09: approval matrix and limits. Unanswered: stop; do not invent limits. Tests use synthetic rules.
