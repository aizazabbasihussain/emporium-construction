# 00. Constitution

Rules that apply to **every** spec. If a module spec conflicts with this file, this file wins. If anything is unclear or missing, the agent **stops and asks**; it never invents business rules.

## 1. Authority and precedence

1. `00-constitution.md` > `01-agent-workflow.md` > module specs.
2. Specs are the source of truth. Code follows specs; specs change only through `CHANGES.md` (human-approved).
3. Business decisions not in a spec (tax rates, approval limits, wage rules, account codes) are **human inputs** listed in `03-human-inputs.md`. The agent may use a documented default only when the register says `default allowed: yes`; otherwise it stops.

## 2. System context

Operations system for a construction company in Pakistan (Islamabad and Punjab): leads, lump-sum quotations, projects, procurement, inventory, own labour (about 50 workers in teams), subcontractors, billing, receivables, payables, cash and bank book, project profitability, and paid maintenance work. Single company, PKR only. Everything was on paper before, so the system is the first digital record.

Government project data must stay inside Pakistan (section 9). Production hosting moves to Pakistan before any government data is entered.

## 3. Architecture

**Monorepo (pnpm workspaces)**

```
apps/web          React + Vite SPA (UI only, no business rules)
apps/api          Fastify API; modules under src/modules/<name>/
packages/domain   Pure TypeScript business logic (no I/O, no framework imports)
packages/db       SQL migrations, seeds, query layer (Kysely), test DB helper
packages/shared   zod schemas, DTO types, enums, permission codes, i18n keys
specs/            these specs
tools/            repo tooling (spec index, module scaffold)
docs/             discovery notes, decision records
```

**Layers inside an API module** (`apps/api/src/modules/<name>/`)

```
module.json       manifest: owned table prefix, exported interfaces, consumed interfaces, events in/out
index.ts          the ONLY public entry point of the module
routes/           HTTP handlers: parse, authorize, call service, map result
service/          application logic: orchestrates domain + repository inside a transaction   [100% coverage]
policy/           permission and state-transition guards                                       [100% coverage]
repo/             SQL access via Kysely (no business rules)                                    [integration tests]
```

Business calculations live in `packages/domain/<name>/` as pure functions and state machines **[100% coverage]**.

**Hard boundaries**

1. A module imports another module **only** through that module's `index.ts`. Enforced by dependency-cruiser in CI.
2. A module writes **only** to tables with its own prefix. No cross-module writes, no cross-module SQL joins on tables the other module owns.
3. Cross-module reads use exported query functions or published read views named `<prefix>_v_*` listed in `module.json`.
4. Cross-module reactions use **domain events** through the transactional outbox (section 5.9). Handlers are idempotent.
5. `apps/web` calls the API only. It never contains money, stock, tax, wage or approval calculations; it may display values computed by the API.
6. All data access from the web goes through the API. Postgres has Row Level Security enabled with **deny-all** on every table as defense in depth; the API uses a server-side database role. The Supabase service key never reaches the browser.

**Table prefixes**

`sys_` platform, `apr_` approvals, `ntf_` notifications, `fil_` files, `mst_` master data, `crm_` leads, `est_` estimation, `qte_` quotations, `prj_` projects and cost ledger, `var_` variations, `prc_` procurement, `inv_` inventory, `val_` valuation, `exp_` expenses, `dpr_` daily reports, `lab_` workforce, `att_` attendance, `wag_` wage calculation, `rpt_` reporting, `imp_` importer, `tax_` tax, `bil_` billing, `cbk_` cash and bank, `rcv_` receivables, `pay_` payables, `sub_` subcontractors, `pyr_` payroll finalization, `pft_` profitability, `acc_` accounting exports, `svc_` service requests, `wo_` work orders, `wop_` work order parts, `sqt_` service quotes and rate cards.

## 4. Technology

TypeScript (strict) everywhere. Node LTS. React, Vite, TanStack Query and Table, Ant Design (with RTL support), react-i18next. Fastify, zod, Kysely, pino. PostgreSQL via Supabase (database, Auth, Storage only; no logic in Supabase-only features). decimal.js for arithmetic. Vitest, Testing Library, Playwright, fast-check, PGlite for in-process Postgres in tests. pnpm. Versions are pinned by the lockfile at P0-01.

Storage and auth sit behind interfaces (`FileStore`, `AuthVerifier`) so moving to Pakistan hosting changes configuration, not code.

## 5. Data conventions

1. **IDs:** UUID (v7 generated in the API). Human-readable document numbers are separate (5.7).
2. **Base columns** on every mutable table: `id`, `created_at`, `created_by`, `updated_at`, `updated_by`, `version` (integer, optimistic concurrency), `deleted_at` (nullable). Updates require the expected `version`; mismatch returns 409.
3. **Soft delete** for master data (`deleted_at`). Financial and stock documents are never deleted: they are cancelled, reversed or credited.
4. **Money:** `numeric(18,2)` in PKR, `Decimal` in code, strings in JSON. Never JavaScript floats. Rounding: half-up to 2 decimals at the points each spec names.
5. **Quantity** `numeric(18,4)`; **unit rate** `numeric(18,4)`; **percentage** `numeric(9,4)`.
6. **Dates:** business dates are `date` in Asia/Karachi; instants are `timestamptz` (UTC). The domain receives a `Clock`; tests use a fixed clock.
7. **Document numbers:** `sys_number_series` allocates numbers inside the same transaction as the document insert (row lock). Series may be marked `gapless`: a gapless number is never reused or voided; cancellation uses a credit note or a cancelled status that keeps the number. Prefix, padding and yearly reset are configurable per series; start numbers continue the paper series.
8. **Enums** are `text` with `CHECK` constraints. **State machines** (status transitions) are explicit tables of allowed transitions in the domain, tested exhaustively.
9. **Events:** state changes write an event row to `sys_outbox` in the same transaction. A dispatcher delivers to subscribers; consumption is recorded in `sys_event_consumptions` so replays are safe.
10. **Idempotency:** commands accept `Idempotency-Key`; `sys_idempotency` stores key, request hash and response. Offline retries rely on this.
11. **Append-only ledgers** (stock ledger, cost ledger, audit log) are never updated or deleted; corrections are reversing entries.
12. **Audit:** every mutation writes `sys_audit_log` (actor, action, entity, before and after, request id).
13. **Attachments:** files are stored through `FileStore`; `fil_attachments` links a file to any entity (type, id). Allowed types: jpeg, png, pdf, xlsx, csv; max 10 MB; checksum stored; access by signed URL.
14. **Cost objects:** costs attach to a cost object `(type, id)` where type is `project`, `work_order` or `overhead`. Phase 1 enables `project` and `overhead`; Phase 3 enables `work_order`.

## 6. Cost ledger vocabulary (used by every module and report)

| Status | Meaning |
|---|---|
| `committed` | Approved purchase or subcontract order value not yet delivered or certified |
| `approved` | Real cost from an approved source document, awaiting finance confirmation (goods received, expense claim approved, attendance approved, work certified) |
| `posted` | Finance-confirmed cost (vendor bill matched and posted, payroll finalized, expense posted by accountant, stock issue valued) |
| `reversed` | Cancelled by a linked reversing entry |

"Paid" is not a cost status; payment is tracked in payables, payroll and the cash book. This ledger is **not** a general ledger.

## 7. Security

1. Authentication: Supabase Auth JWT verified by the API (`AuthVerifier`). Passwords and sessions are never handled by app code.
2. Authorization: permission codes `<module>.<resource>.<action>` (for example `inventory.stock.issue`), checked in `policy/` for every route. Some roles are scoped (supervisors see only their projects and teams).
3. Separation of duties is enforced in code where a spec says so (requester cannot approve own request; creator of a payment cannot approve it).
4. All input validated with zod at the API edge; all output filtered through DTOs.
5. No secrets in the repository; `.env.example` lists names only. Logs redact tokens, CNIC and phone numbers.
6. File uploads validated for type, size and checksum. CORS locked to configured origins. Login and file endpoints rate limited.
7. Every table has RLS enabled with deny-all, verified by a test that fails if a table lacks it.

## 8. Internationalization and formatting

English UI now; all strings use i18n keys; layout is RTL-capable; Urdu translations are added later without code changes. Dates `dd/mm/yyyy` in the UI. Currency displayed with the `en-PK` locale formatter in one shared utility (lakh and crore grouping is a display setting).

## 9. Data residency and test data

1. **No real government project data in the cloud environment, the repository, CI, fixtures or logs.**
2. Development and pilot use synthetic data or private-client data only.
3. Every project carries `sector` = `government` or `private`. Creating a `government` project is blocked unless the environment flag `ALLOW_GOVERNMENT_DATA=true`, which is set only in the Pakistan-hosted production environment (Phase 4).
4. Seeds and fixtures are synthetic and generated by factories.

## 10. Testing standard

**Definition of "business logic":** `packages/domain/**`, `apps/api/src/modules/*/service/**`, `apps/api/src/modules/*/policy/**`.

1. **100% line, branch, function and statement coverage** on business logic, enforced by Vitest thresholds in CI. Coverage ignores only generated code, type-only files, index re-exports and config. An ignore comment needs a written justification in the PR; none is allowed in domain code that handles money, stock, tax, wages or approvals.
2. **Repositories:** every repository function has an integration test against PGlite with all migrations applied.
3. **Routes:** every endpoint has contract tests for success, validation failure, permission denied and not found; mutating endpoints also test idempotent retry and version conflict.
4. **State machines:** every allowed and every forbidden transition is tested.
5. **Money, stock, valuation, tax and wage logic** also has property-based tests (fast-check) for conservation and rounding invariants named in the spec.
6. **UI:** component tests for forms with validation rules; Playwright end-to-end tests for the flows each spec lists.
7. Tests are deterministic: fixed clock, seeded random, no network, no real files outside temp directories.
8. A spec is tested as a whole module: all its tests pass **and** the full repository `pnpm verify` passes (regression for every earlier module).

## 11. Definition of Done (every spec)

- [ ] Every item in the spec's Acceptance criteria passes
- [ ] All migrations are forward-only, numbered, and applied in the test database
- [ ] RLS deny-all present on new tables (checked by test)
- [ ] Permissions seeded and covered by policy tests
- [ ] i18n keys added; no hard-coded UI strings
- [ ] Audit and outbox entries written for each mutation
- [ ] `module.json` updated (owned prefix, exports, consumed interfaces, events)
- [ ] `pnpm verify` passes with the coverage gate (lint, typecheck, tests, boundaries, spec check, build)
- [ ] Spec status updated, coverage summary and migration list pasted into the PR
- [ ] No TODOs left in code without a linked entry in `specs/BACKLOG.md`

## 12. Git workflow

1. One branch per spec: `spec/<ID>-<slug>` (for example `spec/P1-12-inventory-core`).
2. Conventional commits (`feat(inventory): ...`, `test(...)`, `chore(...)`); small commits.
3. After the Definition of Done is met, push the branch and open a pull request titled `[<ID>] <title>` using the checklist in `01-agent-workflow.md`.
4. Merge to `main` only after human review and a green CI run. The agent never pushes to `main`, never force-pushes shared branches, never skips hooks.
5. The next spec starts only after the previous PR is merged, unless the human explicitly authorizes stacking.

## 13. Scope control

If a spec cannot be met without crossing a boundary, touching another module's tables, or changing another spec, the agent stops and writes a change request in `CHANGES.md` under "Proposed". It does not work around the boundary.

## 14. Globally out of scope

General ledger, balance sheet, cash-flow statement, period closing; retention; EOBI and social-security deductions; bank guarantees and bid security; AMC and preventive maintenance; native mobile app (Phase 6); multi-company and multi-currency; LIFO costing.
