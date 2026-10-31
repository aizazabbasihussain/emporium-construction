# Gate A independent review

Spec P1-21 BR-8. A named reviewer who is independent of the build reads the review pack (`docs/pilot/review-pack.md`) and records findings here. **Critical findings must be fixed before the pilot starts with private-client data.** The pilot may run on synthetic data only while this review is open.

## Reviewer

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| Reviewer        | **Not named yet.** Input H-19 is open; the owner names the reviewer.    |
| Scope           | Security (authentication, permissions, RLS, file handling) and the financial logic of the ledgers, valuation, wages and approvals |
| Review pack sent | No                                                                     |
| Review finished | No                                                                     |

## Findings

Severity: `critical` (must be fixed before private-client data), `major`, `minor`, `note`. Status: `open`, `fixed`, `accepted` (with the reason written next to it).

| No | Severity | Area | Finding | Status | Resolution |
| -- | -------- | ---- | ------- | ------ | ---------- |

_No findings recorded: the review has not taken place._

## Observations from the build (not a review)

These come from the acceptance work itself and are given to the reviewer as a starting point. They are not findings and nobody has judged them yet.

1. The `estimator` role holds no permission on estimation or quotations; those grants went to `project_manager` and `management`. The permission matrix (`apps/api/src/acceptance/permission-matrix.expected.json`) shows it. The owner should confirm that is intended.
2. Saved report filters (`/reports/saved-filters`) need no report permission because they hold no report data; a user without any role can list and save their own filters.
3. The permission matrix file was generated from the running API at the time of the build and then reviewed only by the build agent. The reviewer is asked to check it against the intended roles, not just against the code.
4. The performance checks run on an in-process PGlite database, not on the hosted PostgreSQL. The 3-second wage calculation passed with little margin on the build machine (about 2.5 s including the HTTP round trip).
