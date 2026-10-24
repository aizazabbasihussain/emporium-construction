---
id: P1-02
title: Authentication, roles and app shell
phase: 1
module: identity
status: not-started
depends_on: [P1-01]
requires_inputs: [H-10]
---

# P1-02 Authentication, roles and app shell

## 1. Purpose
Identify users, check their permissions on every request, scope supervisors to their own projects and teams, and provide the web application shell (login, navigation, language-ready layout).

## 2. Boundary
- Owns: tables `sys_users`, `sys_roles`, `sys_role_permissions`, `sys_user_roles`, `sys_user_scopes`; module `identity`; the web shell.
- Provides: `AuthVerifier` interface (Supabase JWT implementation), `requirePermission(code)` route guard, `currentUser()` context, `userHasScope(user, scopeType, scopeId)`, permission registry helper `registerPermissions(module, codes)`.
- Consumes: kernel audit and settings.
- Must not: store passwords or run its own login (Supabase Auth does).
- Out of scope: approvals (P1-03), per-module permission lists (each module registers its own).

## 3. Data model
- `sys_users(id, auth_subject unique, email unique, full_name, phone, status active|disabled, locale default 'en', last_login_at, ...base)`.
- `sys_roles(code pk, name, description, system bool)`; seeded: `admin`, `management`, `project_manager`, `procurement`, `storekeeper`, `supervisor`, `accountant`, `service_coordinator`.
- `sys_role_permissions(role_code, permission_code)`; permissions are text codes registered by modules.
- `sys_user_roles(user_id, role_code)`; `sys_user_scopes(user_id, scope_type project|team, scope_id)`.

## 4. Business rules
- BR-1 Every API route except `/health` requires a valid JWT; the `AuthVerifier` maps `sub` to an active `sys_users` row; unknown or disabled users get 401 and 403 respectively.
- BR-2 First login: if the verified email matches a pre-created `sys_users` row, bind `auth_subject`; there is no self-registration (admin creates users).
- BR-3 Permission check: a user holds the union of permissions of all assigned roles. Missing permission returns 403 with the permission code in the error body.
- BR-4 Scoped roles: for `supervisor`, queries for projects, DPRs, attendance and expenses are limited to scopes assigned in `sys_user_scopes`. Unscoped roles see everything their permissions allow. Scope enforcement lives in policy code, not in the UI.
- BR-5 Only `admin` can create, disable users and edit role assignments; an admin cannot remove their own admin role or disable themselves (prevents lockout); the last active admin cannot be disabled.
- BR-6 Disabling a user invalidates access immediately (checked on every request; no token caching beyond 60 seconds).
- BR-7 Role-permission edits are audited and take effect within 60 seconds.
- BR-8 Seed: roles and the default permission map come from P0-03 `role_permissions.csv` when accepted; otherwise a minimal admin-only set exists.
- BR-9 The web shell stores no tokens in localStorage beyond the Supabase session handling; logout clears session and query cache.
- BR-10 Navigation items render only if the user holds the item's permission; direct URL access to a forbidden page shows a 403 page.
- BR-11 All shell strings use i18n keys; layout switches to RTL when locale is `ur` (translation file added later); dates `dd/mm/yyyy`; amounts via the shared `en-PK` formatter.

## 5. API and UI
- `GET /me` (profile, roles, permissions, scopes); `PATCH /me` (locale).
- `GET/POST/PATCH /admin/users`; `PUT /admin/users/:id/roles`; `PUT /admin/users/:id/scopes`; `GET /admin/roles`; `PUT /admin/roles/:code/permissions`.
- Web: login page, app layout (header, sidebar by permission, language switch), 403 and 404 pages, user and role admin screens.

## 6. Permissions
`identity.user.manage`, `identity.role.manage` (admin only), `identity.user.read` (admin, management).

## 7. Test requirements
- T-1 `AuthVerifier` with valid, expired, wrong-audience and tampered tokens (test keys, no network).
- T-2 Permission union across multiple roles; denied path returns 403 with code.
- T-3 Scope enforcement matrix: supervisor sees assigned project only; unassigned project returns 404 (not 403) for reads; a manager sees all.
- T-4 Lockout protections in BR-5 (self-removal, last admin).
- T-5 Disable user takes effect on next request.
- T-6 Property test: for any role set, permissions equal the union.
- T-7 Route contract tests for all endpoints; repository integration tests; 100% coverage of service and policy.
- T-8 Component tests: nav filtering, 403 page, language switch toggles direction; Playwright: login, see allowed pages, blocked page.

## 8. Acceptance criteria
- AC-1 An unauthenticated request to any route except `/health` returns 401.
- AC-2 A supervisor cannot read another project's data by any API path covered by this module's scope helper.
- AC-3 The last admin cannot be disabled or demoted.
- AC-4 Role changes are audited.
- AC-5 Shell renders in LTR and RTL with i18n keys only.
- AC-6 Definition of Done satisfied.

## 9. Open inputs
H-10: role holders. Unanswered: seed only an admin user taken from an environment variable; stop before creating other users.
