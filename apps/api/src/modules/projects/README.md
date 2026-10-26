# projects

Projects and the append-only cost ledger every other module posts into (P1-09). Reacts to `quotation.accepted` by creating one project per quotation with a budget from the estimate. Emits `project.created` and `project.status.changed`.

- `service/projects.service.ts` projects, budget lines, tasks and supervisor assignments; `service/costing.service.ts` the ledger (`postCost`, `transitionCost`, `reverseCost`, `getCostSummary`).
- A status change of a cost appends a row of the same chain (the source line); the latest row of a chain is its current state. `prj_v_cost_summary` totals the current rows by status. A database trigger refuses any update, delete or truncate of `prj_cost_entries`.
- `policy/` guards (including the supervisor scope); `repo/` SQL; `routes/` HTTP.
- Business rules live in `packages/domain/src/costing/`.
