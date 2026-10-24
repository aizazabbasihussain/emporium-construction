# Specification Set: Construction Operations System

Specs for building the system with a coding agent. Read in this order:

1. `00-constitution.md`: rules for every spec (architecture, data conventions, security, testing, git)
2. `01-agent-workflow.md`: the loop the agent follows for each spec
3. `02-spec-template.md`: required structure of each spec
4. `03-human-inputs.md`: decisions only humans can make (agent never guesses)
5. `STATUS.md`: generated index of all specs, status and readiness
6. `CHANGES.md`: approved and proposed changes to the specs
7. `BACKLOG.md`: deferred ideas

## Layout

```
specs/
  phase-0/   Foundation of the project: repo, discovery, decisions, import framework
  phase-1/   Core construction operations (Gate A)
  phase-2/   Billing, money and control (Gate B)
  phase-3/   Paid maintenance and service work
  phase-4/   OUTLINE.md: Pakistan hosting and government go-live (Gate C)
  phase-5/   OUTLINE.md: supporting modules
  phase-6/   OUTLINE.md: mobile app
  phase-7/   OUTLINE.md: analytics and portals
  tools/     spec-index.mjs (validates specs and generates STATUS.md)
```

Phases 0-3 are fully specified. Phases 4-7 are outlines (scope, boundaries, dependencies, entry criteria); they are expanded into full specs when the business reaches them.

## Spec map

| Phase | Specs | Gate |
|---|---|---|
| 0 | P0-01 to P0-04: repo and quality gates, discovery, decision records, import framework | none |
| 1 | P1-01 to P1-21: platform, approvals, master data, CRM, estimation, quotations, projects and cost ledger, variations, procurement, inventory, stock valuation, expenses, DPR, workforce, attendance, wages, reports, offline drafts, acceptance | Gate A: operational pilot |
| 2 | P2-01 to P2-10: tax, billing, cash and bank, receivables, payables, subcontractors, payroll finalization, profitability, accountant exports, acceptance | Gate B: financial go-live (private data only) |
| 3 | P3-01 to P3-05: service requests, work orders, parts, service quotes and invoices, reports | Maintenance acceptance |
| 4 | Outline | Gate C: Pakistan go-live; **no government data before this gate** |

## Commands (created by P0-01)

```
pnpm spec:check     validate specs, dependencies, human inputs
pnpm spec:status    same, and regenerate STATUS.md
pnpm verify         lint, typecheck, tests with 100% business-logic coverage, boundaries, spec check, build
```

Until P0-01 is done, run the tool directly: `node specs/tools/spec-index.mjs --write`.

## Key design decisions (see CHANGES.md for history)

- Stock valuation is configurable: company default plus per-category override; weighted average and FIFO; effective-dated; approval-controlled transitions (P1-13).
- Business logic lives in pure TypeScript (`packages/domain`) and API services so it can be unit-tested to 100% coverage and moved to any host. Postgres holds data, constraints and migrations.
- Costs attach to cost objects (project now, work order in Phase 3). The cost ledger is not a general ledger.
- Government project data never enters the cloud environment.
