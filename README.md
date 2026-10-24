# Emporium Construction Operations

Construction operations system (leads, quotations, projects, procurement, inventory, labour, billing, maintenance). Built spec by spec; see `specs/README.md`.

## Setup

```
pnpm install            # Node 22 is downloaded automatically (devEngines)
cp .env.example .env    # fill in values locally; never commit .env
```

## Commands

| Command                                | What it does                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                          | lint, typecheck, tests with 100% business-logic coverage, tooling self-tests, boundary check, spec check, build |
| `pnpm --filter @emporium/api dev`      | API on http://localhost:3000 (`GET /health`)                                                                    |
| `pnpm --filter @emporium/web dev`      | Web app on http://localhost:5173                                                                                |
| `pnpm --filter @emporium/db migrate`   | Apply SQL migrations to `DATABASE_URL`                                                                          |
| `pnpm module:new <name>`               | Scaffold an API module and its domain folder                                                                    |
| `pnpm spec:check` / `pnpm spec:status` | Validate specs / also regenerate `specs/STATUS.md`                                                              |
| `pnpm docs:check`                      | Validate `docs/discovery` (forms, workflows, links, no real CNIC or phone numbers)                              |

## Sign-in (P1-02)

Users sign in with Supabase Auth; the API verifies the JWT and maps it to a row in `sys_users`. There is no self-registration.

- **First admin:** set `ADMIN_EMAIL` in `.env` before the first start. The API creates that user with the `admin` role if it does not exist. The person then signs in with a Supabase account that has the same email; the first login binds the Supabase subject to the user. All other users are created by that admin in the UI.
- **Web app:** set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (both are public values) when running or building `apps/web`.
- **API:** set `SUPABASE_JWKS_URL` (or the legacy `SUPABASE_JWT_SECRET`). Tokens must carry the `authenticated` audience.
