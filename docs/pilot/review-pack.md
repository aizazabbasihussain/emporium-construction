# Gate A review pack

For the independent reviewer (H-19), spec P1-21 BR-8. Everything here is in the repository; nothing needs a running server.

## 1. Architecture summary

- Monorepo with `apps/web` (React single-page app, no business rules), `apps/api` (Fastify, one folder per module under `src/modules`), `packages/domain` (pure business logic), `packages/db` (SQL migrations and the query layer), `packages/shared` (schemas, permission codes, i18n keys). See `specs/00-constitution.md` section 3.
- Modules talk to each other only through their `index.ts`; this is enforced by `pnpm boundaries`. A module writes only tables with its own prefix.
- The API uses a server-side database role. Every table has Row Level Security enabled with no policy, so a direct connection with another role reads nothing.
- Authentication: a Supabase Auth JWT verified by the API. Authorization: permission codes granted to roles (`sys_role_permissions`), checked per route; supervisors are limited to their assigned projects and teams by scope.
- Money uses `numeric(18,2)` and `decimal.js`; quantities `numeric(18,4)`. Stock, cost and audit ledgers are append-only (triggers refuse update and delete). State changes write an audit row and an outbox event in the same transaction.

## 2. Permission matrix

`apps/api/src/acceptance/permission-matrix.expected.json` lists every route and the roles that get past the permission check. `apps/api/src/acceptance/security.test.ts` rebuilds it from the running API and fails on any difference. Please review the file itself, not only the test: it is the statement of intent. A role with no row for a route is refused (HTTP 403).

## 3. RLS report

`security.test.ts` > "has Row Level Security enabled on every table" lists tables without RLS (must be empty) and "no policy lets a role read a table" lists policies (must be empty). `packages/db/src/rls.ts` is the query.

## 4. Authentication sweep

`security.test.ts` calls every route without a token and with a forged token. Only `GET /health` and the signed download link `GET /files/blob` (whose signature is its credential) answer without a valid token.

## 5. Ledger, valuation and money tests

| Area | Where |
| ---- | ----- |
| Stock valuation (weighted average, FIFO, conservation, return costing) | `packages/domain/src/valuation/valuation.test.ts`, `apps/api/src/modules/valuation/**/*.test.ts` |
| Inventory ledger, balances, client material | `packages/domain/src/inventory`, `apps/api/src/modules/inventory/**/*.test.ts` |
| Project cost ledger and summary | `packages/domain/src/costing`, `apps/api/src/modules/projects/**/*.test.ts` |
| Wage calculation and rounding | `packages/domain/src/wages/wages.test.ts`, `apps/api/src/modules/wages/**/*.test.ts` |
| Approvals and separation of duties | `packages/domain/src/approvals`, `apps/api/src/modules/approvals/**/*.test.ts` |
| End-to-end figures to the paisa | `apps/api/src/acceptance/scenario.test.ts` against `docs/pilot/gate-a-expected.md` |
| Integrity checker and seeded faults | `apps/api/src/acceptance/integrity.test.ts` |
| Backup and restore | `apps/api/src/acceptance/backup.ts`, scenario step 14 |

## 6. How to run it

```
pnpm install
pnpm gate:a          # all checks; writes docs/pilot/gate-a-report.md
pnpm e2e             # the end-to-end scenario and the browser smoke tests
pnpm seed:synthetic  # loads the synthetic company into the database named by DATABASE_URL
```

## 7. Out of scope for this review

Billing, payments and tax (Phase 2), government data (Gate C), hosting and backups of the production database.
