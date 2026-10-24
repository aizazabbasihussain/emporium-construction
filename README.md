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
