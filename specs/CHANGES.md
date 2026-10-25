# CHANGES

Changes to the constitution, workflow or specs. Only humans approve. The agent adds entries under "Proposed" and stops.

## Approved

### 2026-10-24: initial spec set (v1)

Created from plan v2 (`construction-ops-crm-plan-v2.md`) and the user's answers. Notable decisions:

1. **Stock valuation is configurable** (user decision). Company default plus per-category override; weighted average and FIFO; LIFO excluded (IFRS); effective-dated policies; approval-controlled transition with a value-conservation check. Specified in P1-13; consumed by P1-12.
2. **Test standard:** 100% line, branch, function and statement coverage on business logic (`packages/domain`, API `service/` and `policy/`), enforced in CI. UI uses component and end-to-end tests. (User decision.)
3. **Git workflow:** one branch per spec, pull request, merge after human review. (User decision.)
4. **Spec depth:** Phases 0-3 full; Phases 4-7 outlines. (User decision.)
5. **Architecture change from plan v2:** an API service (Node, TypeScript, Fastify) holds business logic instead of Postgres functions and Supabase Edge Functions. Reason: the 100% coverage requirement on business logic is measurable and practical in TypeScript, not in PL/pgSQL; the same API also moves unchanged to Pakistan hosting. Supabase is used for Postgres, Auth and Storage only. Cost effect: a small API host is needed during the pilot (roughly USD 5-10 per month, confirm on provider sites) in addition to Supabase Pro.
6. **Cost objects** (`project`, `work_order`, `overhead`) are part of the cost ledger from P1-09 so maintenance (Phase 3) needs no redesign.
7. **Cost ledger statuses:** committed, approved, posted, reversed; "paid" is tracked elsewhere.

### 2026-10-24: autonomous run with auto-merge (user request)

Approved by the user ("merge automatically if there is no error in the git actions", "start the next phase with a new agent session always"). Adds `specs/04-autonomous-run.md`, `specs/tools/next-spec.mjs`, `tools/agent/pr.mjs` and `tools/agent/loop.mjs`. Effects on `01-agent-workflow.md` for runs started by the loop:

1. One fresh agent session per spec. A driver script starts each session and judges the result from `main`.
2. A PR is merged automatically only after every CI check on its head commit passes. The spec is set to `done` and `STATUS.md` regenerated inside the same PR, replacing the separate "in-review" step and the follow-up status PR.
3. PRs that touch the constitution, workflow files, `CHANGES.md`, spec tools, CI, hooks, lint, coverage or dependency rules, another spec, or `.env*` are never auto-merged; a human reviews them.
4. Spec selection skips a spec that waits on an open human input with "default allowed: no" and takes the next eligible spec by dependency order, instead of stopping the whole run. The loop ends when none is eligible and lists the inputs needed.

Human review of ordinary spec PRs now happens after the merge. Branch protection on `main` (needs the Administration permission on the token) would make the "checks must pass" rule enforced by GitHub as well.

### 2026-10-24: answers to H-04, H-10, H-24 and H-27 change three specs (options chosen by the user)

1. **Worker login: new spec** (option 1). Added `specs/phase-1/P1-22-worker-self-service.md` (depends on P1-02, P1-16, P1-17, P1-18; not part of Gate A). P1-02 gains `registerRole()` and the seeded role `estimator`.
2. **Backdating: admin override with reason** (direct override, not an approval request). P1-01 BR-5 and T-3 extended and permission `platform.backdate.override` added (admin).
3. **Number format:** P1-01 BR-1 produced `<prefix>/<yy>`, which cannot give the requested `INV-2026-0001`. It now produces `<prefix>-<yyyy>-<number>` for yearly series and `<prefix>-<number>` otherwise.

## Proposed

### 2026-10-24: P0-02 proposes a pre-project survey record for demolition and restructuring (GAP-01)

Found while mapping the demolition workflow (`docs/discovery/workflows/demolition-job.md`, `docs/discovery/gaps.md` GAP-01). Plan v2 section 9 lists "survey and inspection records with before/after photos" for demolition and restructuring, but no Phase 1 spec holds a record of the structure before a job is quoted or started. P1-06 has site visits, P1-15 has daily reports (only after a project exists), and before and after photos exist only on Phase 3 work orders (P3-02).

Options for the human to decide:
1. Extend the site visit in P1-06 with a survey section and photo attachments (smallest change).
2. Add a survey record to P1-15 once a project exists.
3. Defer to BACKLOG and rely on site visit notes with photos through `fil_attachments`.

No spec is blocked. Awaiting a decision.

### 2026-10-25: P1-13 adds tables, a column, an event and a grant beyond its data model

P1-13 was built and auto-merged (PR #16) with "Deviations and questions: none". The agent treated these as implementation details, but they go beyond the spec's data model and need a human decision:

1. Table `val_keys`: the current method of each store and item, also the lock row for concurrent movements.
2. Table `val_return_parts`: records which layers a return gave back.
3. Column `val_layers.remaining_value`.
4. Event `valuation.movement.recorded`, so every mutation writes an outbox row.
5. The `admin` role can read the valuation policy and report screens.

Options for the human to decide:
1. Approve and add them to P1-13 section "Data model" and "Interfaces" (the code already matches).
2. Reject and ask for a rework spec; this changes migration `0008_valuation.sql` after it has shipped.

P1-12 reads these tables, so the decision should come before it starts.

### 2026-10-25: P1-05 judgment calls to ratify

P1-05 (PR #14) was left open by the agent because six points were unclear, and was merged afterwards. Nothing in the repository records the answers, so ratify or change them:

1. `getRegistration(authority)` picks one registration when several types are active, preferring ntn, then strn, pra, other, with an optional `type` argument.
2. BR-6: a cost code is blocked from deactivation only when it has both posted costs and open budget lines.
3. T-4 property test: a unit conversion round trip cannot hold for every factor (0.3048 can lose up to 1.6 units), so it is tested for factors 1 to 1000.
4. Three read permissions not listed in the spec were added: `master.reference.read`, `master.item.read`, `master.price.read`.
5. Duplicate parties: a repeated NTN or CNIC is always refused; a repeated name plus phone is a warning the user can confirm.
6. Importers: a file with a row that repeats an existing party fails the whole commit instead of skipping that row.

Options for the human to decide: approve all six and update the P1-05 spec text to match, or list which points to change.

### 2026-10-25: P1-07 stores the revision as `revision`, and adds items beyond its data model

P1-07 (PR #20) is open and not auto-merged. Its data model lists a column `version` on `est_estimates` for the revision number, but the constitution (5.2) reserves `version` for optimistic concurrency, so one table cannot hold both under one name. Decision needed:

1. **Revision column.** The code stores the revision as `revision` (first estimate 1, first revision 2) and keeps `version` as the concurrency counter. A revision keeps the estimate number; `unique (number, revision)`. Option A: approve and change the P1-07 text (data model, BR-8, AC-3) from `version` to `revision`. Option B: keep `version` for the revision and add a differently named concurrency column to this table only, which departs from constitution 5.2.
2. **Beyond the data model and API** (all listed in the PR body): columns `template_id` and `locked_at`; endpoints `POST /estimation/templates/:id/copy`, `POST /estimation/formula-preview`, `POST /estimation/estimates/preview`, `GET /estimation/estimates/:id`; template reads need `estimation.estimate.read`; events `estimation.template.changed` and `estimation.estimate.changed`; number series `estimate` / `EST`; work types `room` and `slab`; the `admin` role holds the five permissions. Option: approve and add them to the P1-07 text, or list which to remove.
3. **AC-4 lint rule.** `eslint.config.js` is protected, so `no-eval`, `no-new-func` and `no-implied-eval` are switched on by an inline directive in `formula.ts`, plus a test that scans the source. Option: approve, or add the rules to the shared config in a human-reviewed change.

The PR can be merged once the first point is decided.

### 2026-10-26: P1-08 settles four points that the spec text leaves open or contradicts

P1-08 (PR #22) is open and not auto-merged, because its "Deviations and questions" section is not "none". The code follows the constitution and answered inputs where they conflict with the spec text. Decide, then update the P1-08 text to match or tell the agent what to change:

1. **Revision column.** The data model lists `version` for the revision number; constitution 5.2 reserves `version` for the concurrency counter. The code stores `revision` (same as the P1-07 proposal above). Option A: change P1-08 data model and BR-7 from `version` to `revision`. Option B: keep `version` for the revision and add another concurrency column, which departs from 5.2.
2. **Number series.** BR-7 says `QTE`; the answered input H-27 and the existing series say `QUO` (`QUO-YYYY-0001`). The code uses `QUO` and prints a revision as `QUO-2026-0001/2`. Option: change BR-7 to `QUO`, or add a second series `QTE` (and drop `QUO`).
3. **Approver says no.** BR-4 has no transition for an approval request that is rejected, returned or cancelled. The code moves `pending_approval` back to `draft` so the quotation can be edited and resubmitted; a client's refusal is the separate `rejected` status. Option: approve and add `pending_approval to draft` to BR-4, or define a different outcome.
4. **Beyond the data model, API and events** (listed in the PR body): column `accepted_by_name`; `qte_status_history` columns `from_status`, `to_status`, `changed_by` and an `id`; `issued`, `rejected` and `expired` become `superseded` when their revision is issued; acceptance is refused after the expiry date even before the daily job runs; `DELETE /quotations/:id` for drafts; event `quotations.quotation.changed`; typed setting `quotations.margin_floor_percent` (default 0, H-09); the `admin` role holds none of the P1-08 permissions. Option: approve and add them to the P1-08 text, or list which to remove.
