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

## Proposed

### 2026-10-24: P0-02 proposes a pre-project survey record for demolition and restructuring (GAP-01)

Found while mapping the demolition workflow (`docs/discovery/workflows/demolition-job.md`, `docs/discovery/gaps.md` GAP-01). Plan v2 section 9 lists "survey and inspection records with before/after photos" for demolition and restructuring, but no Phase 1 spec holds a record of the structure before a job is quoted or started. P1-06 has site visits, P1-15 has daily reports (only after a project exists), and before and after photos exist only on Phase 3 work orders (P3-02).

Options for the human to decide:
1. Extend the site visit in P1-06 with a survey section and photo attachments (smallest change).
2. Add a survey record to P1-15 once a project exists.
3. Defer to BACKLOG and rely on site visit notes with photos through `fil_attachments`.

No spec is blocked. Awaiting a decision.
