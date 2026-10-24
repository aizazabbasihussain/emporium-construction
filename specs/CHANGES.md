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

## Proposed

_None yet._
