---
id: P0-01
title: Repo bootstrap and quality gates
phase: 0
module: tooling
status: done
depends_on: []
requires_inputs: []
---

# P0-01 Repo bootstrap and quality gates

## 1. Purpose
Create the monorepo, tooling, test harness and CI so every later spec is built and checked under the same gates, including the 100% business-logic coverage gate and module-boundary enforcement.

## 2. Boundary
- Owns: repository structure, tool configuration, CI workflow, migration runner, test database helper, module scaffold generator, API and web skeletons.
- Provides: `pnpm verify`, `pnpm spec:check`, `pnpm module:new <name>`, `createTestDb()`, config loader, error model, logger.
- Consumes: `specs/tools/spec-index.mjs`.
- Must not: contain any business logic or business tables.
- Out of scope: authentication (P1-02), audit, numbering and events (P1-01), any feature screens.

## 3. Data model
Only the migration bookkeeping table: `sys_migrations(id serial, name text unique, checksum text, applied_at timestamptz)`.

## 4. Business rules
- BR-1 Workspace layout exactly as constitution section 3 (`apps/web`, `apps/api`, `packages/{domain,db,shared}`, `tools`, `docs`, `specs`).
- BR-2 TypeScript strict mode with `noUncheckedIndexedAccess`; ESLint forbids `any`, floating promises and default exports in domain code; Prettier enforced.
- BR-3 Vitest coverage thresholds of 100 (lines, branches, functions, statements) apply to `packages/domain/**`, `apps/api/src/modules/*/service/**`, `apps/api/src/modules/*/policy/**`. Exclusions are limited to generated code, `*.d.ts`, `index.ts` re-exports and config files.
- BR-4 dependency-cruiser fails the build if a module imports another module's internals (anything other than its `index.ts`), if `packages/domain` imports I/O or framework packages, or if `apps/web` imports `apps/api`.
- BR-5 SQL migrations live in `packages/db/migrations/NNNN_name.sql`, forward-only. The runner applies them in order inside a transaction each, records name and SHA-256 checksum, and fails if an applied file's checksum changed or a number is skipped or duplicated.
- BR-6 `createTestDb()` returns a fresh PGlite database with all migrations applied; a `withRollback(db, fn)` helper isolates tests.
- BR-7 A test fails the build if any table in the public schema lacks `ENABLE ROW LEVEL SECURITY` (constitution 7.7).
- BR-8 `pnpm verify` runs, in order: lint, typecheck, unit and integration tests with coverage, boundary check, `spec:check`, build of web and api. Any failure fails the command.
- BR-9 CI (GitHub Actions) runs `pnpm verify` on every pull request and on pushes to `main`; coverage summary is uploaded as an artifact.
- BR-10 Config is read once by a zod-validated loader from environment variables; missing or invalid values fail startup. `.env.example` lists names only. Variables include `DATABASE_URL`, `SUPABASE_JWT_SECRET` or JWKS URL, `FILE_STORE_DRIVER`, `ALLOW_GOVERNMENT_DATA` (default false), `CORS_ORIGINS`.
- BR-11 The API skeleton provides: request id, pino logger with redaction (authorization, CNIC, phone), central error handler mapping domain errors to HTTP (400 validation, 401, 403, 404, 409 conflict, 422 rule violation, 500), `GET /health`.
- BR-12 `pnpm module:new <name>` generates `apps/api/src/modules/<name>/` with `module.json`, `index.ts`, `routes/`, `service/`, `policy/`, `repo/`, a sample test, and a domain folder `packages/domain/src/<name>/`.
- BR-13 Commit hooks run lint-staged and typecheck; commit messages follow Conventional Commits.
- BR-14 The web skeleton provides Vite, React, Ant Design, TanStack Query, react-i18next (English only, keys in `packages/shared`), router, Testing Library, Playwright config.

## 5. API and UI
- `GET /health` returns `{status:"ok", version, time}`.
- Web: a blank shell page with the app title, proving the build and i18n.

## 6. Permissions
None.

## 7. Test requirements
- T-1 Migration runner: applies in order; idempotent re-run; rejects changed checksum; rejects gap or duplicate number; rolls back a failing migration without recording it.
- T-2 Config loader: valid env passes; each missing or invalid variable fails with a named error; `ALLOW_GOVERNMENT_DATA` defaults to false.
- T-3 Error handler: each error class maps to the documented status and body; unknown errors return 500 without leaking details.
- T-4 Logger redaction removes authorization header, CNIC pattern and phone pattern.
- T-5 Tooling self-tests: a fixture with an uncovered branch makes the coverage gate fail; a fixture with an illegal cross-module import makes the boundary check fail; a fixture table without RLS fails the RLS test.
- T-6 Module generator output compiles, passes lint and has a passing sample test.
- T-7 `createTestDb()` isolation: data written in one test is absent in the next.
- T-8 Health endpoint contract test.

## 8. Acceptance criteria
- AC-1 `pnpm install && pnpm verify` passes on a clean clone.
- AC-2 Each self-test in T-5 demonstrably fails the gate when violated and passes when fixed.
- AC-3 CI runs on a pull request and blocks merging on failure.
- AC-4 `pnpm module:new demo` creates a module that passes `pnpm verify`; the demo module is then deleted.
- AC-5 `pnpm spec:check` runs the spec index tool and passes.
- AC-6 No secrets or real data in the repository; `.env.example` present.
- AC-7 Definition of Done (constitution section 11) satisfied.

## 9. Open inputs
None.
