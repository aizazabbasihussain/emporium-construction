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

### 2026-10-27: P1-12 BR-3 refers to an "item default cost code mapping" that no spec defines

Found while starting P1-12 (inventory core). BR-3 says the project cost entry of an issue takes its cost code "from the item's default cost code mapping or the command's cost code". Master data (P1-05) holds no such mapping: `mst_items` and `ItemDto` carry a category, unit, kind and reorder level, but no cost code, and no other spec adds one. P1-12 owns only `inv_*` tables and must not write to `mst_`. The agent stopped before building, because the issue cost code cannot be chosen without inventing a rule.

Options for the human to decide:
1. The command always supplies the cost code (issue form field, required). P1-12 BR-3 drops "item's default cost code mapping". Smallest change; the stock-loss cost code (BR-8) is already a setting.
2. Add a nullable `default_cost_code_id` to items in P1-05 (column, item form field, importer column) and keep BR-3 as written, with the command's cost code overriding it. This changes P1-05, which is already `done`.
3. Add an inventory setting `default_issue_cost_code` (H-25 code 100 Materials) used when the command has none.

Smaller points the agent would settle in code unless told otherwise, listed so they are not silent: `hasIssuesFromGrn(grnId)` is true when any issue, transfer-out or adjustment-out of a GRN line's item and store was posted after that GRN's receipt rows; the settings `allow_negative_stock`, `stock_loss_cost_code`, `supervisor_can_issue` and `salvage_value_mode` are added to the kernel setting registry as procurement did.

P1-12 stays `not-started`; P1-14, P1-15 and others that do not depend on it can proceed.

**Decision (owner, 2026-10-27): option 2.** Add nullable `default_cost_code_id` to items; the issue command's cost code overrides it; no cost code from either source means the issue is refused. Goal: fewer entries for storekeepers. P1-05 spec text and P1-12 Boundary and BR-3 are updated accordingly; P1-12 builds the master data extension. The two smaller points above are accepted as proposed.

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

### 2026-10-26: P1-09 defers the admin manual overhead journal

P1-09 (PR #24) is open and not auto-merged, because its "Deviations and questions" section is not "none". Section 5 ("Interfaces") says `postCost` has no public route "except an admin manual journal for overhead entries with approval". The spec gives no route, permission, approval document type or test for it, and `BACKLOG.md` already lists it as deferred. The code leaves it out; `postCost` already accepts overhead cost objects from other modules. Decision (deferred): remove the exception from the P1-09 text and keep the journal in `BACKLOG.md`.

Options for the human to decide: approve the deferral and change the P1-09 interface line to "`postCost` is service-level only (no public route)", or ask for a follow-up spec that defines the route, permission, approval document type and tests.

### 2026-10-27: P1-10 renames one permission and settles five points the spec text leaves open

P1-10 (PR #26) is open and not auto-merged, because its "Deviations and questions" section is not "none". Decide, then update the P1-10 text to match or tell the agent what to change:

1. **Permission code.** Section 6 names `variations.variation.client-approve`, but `sys_role_permissions` accepts only letters, digits and underscores in a code, so the hyphen is refused. The code uses `variations.variation.client_approve`. Option A: change the P1-10 text to `client_approve`. Option B: relax the identity constraint in a human-reviewed change and keep the hyphen.
2. **Approver says no.** The spec has no status for an internal rejection. The variation stays `pending_internal_approval` (it cannot go to the client) until it is cancelled, and only a client-rejected variation can be copied (BR-7). Option: approve, or add a step from `pending_internal_approval` back to `draft`.
3. **Numbering.** BR-1 (`<project code>-V<n>`, per project) differs from the answered H-27 (`VAR-YYYY-0001`). The code follows BR-1 and leaves the seeded `variation` series unused. Option: approve, or switch to the H-27 format.
4. **Deductive variations and the budget.** A line cost must be zero or more, because `addBudgetLine` only appends non-negative lines. A deductive variation lowers the price but not the budget. Option: approve, or define how the budget is reduced.
5. **At risk.** Counted for open variations only, for costs dated on or after `discovered_on`, `approved` and `posted`, on the cost codes of the lines. Option: approve, or state a different window.
6. **Beyond the spec lists.** Event `variations.variation.changed` (an outbox entry per mutation, constitution 5.9), `DELETE` of a draft, and `POST /variations/:id/copy`. Option: approve and add them to the P1-10 text.

### 2026-10-27: H-05 chart of accounts accepted provisionally, and made editable from the UI

The owner accepted the draft chart of accounts (`docs/decisions/chart-of-accounts-draft.md`) as it stands, provisionally, so P0-03 is no longer blocked; the accountant has not reviewed it. The register now shows H-05 as `answered`. The owner wants to be able to change the chart later without a new build. Proposal:

1. **P0-03** loads the draft as `chart_of_accounts.csv` seed data. No spec change; its BR-6 accepts the owner as approver.
2. **P2-09** section 3 says `acc_accounts` is "read-only in the UI except activation". Change it so a user holding a new permission `accounting.account.manage` (owner and admin) can: add an account, rename it, change its parent, and activate or deactivate it. The `code` stays fixed once any transaction carries it as a tag (tags refer to codes), and `type` cannot change once the account is in use. An account is never deleted, only deactivated. Every change is audited and writes an outbox event, as for other settings. The seed CSV is loaded only when the table is empty, so later edits are never overwritten.
3. This adds one permission, one small admin screen and a handful of rules to P2-09; it does not touch P0-03.

Options for the human to decide: approve and update the P2-09 text, or keep the chart read-only and change it only through a new seed file.

### 2026-10-28: detached, supervised autonomous loop

Changes only `tools/agent/loop.mjs` and `specs/04-autonomous-run.md` (tooling; no product behaviour). Reason: the loop ran as a child of the starting process and was lost when that process died or ran out of memory.

1. `--detach` starts the loop as a background supervisor that restarts it up to three times after a crash.
2. Session output streams to a log file instead of an in-memory buffer; each session has a timeout (default 90 minutes) and is killed with its whole process tree.
3. Sessions run with a 4 GB Node heap and `VITEST_MAX_WORKERS=2`.
4. Uncommitted work left on a `spec/<ID>-*` branch by a dead session is resumed instead of stopping the loop.

Human review needed: `tools/agent/` is a protected path and is not auto-merged.
