# Phase 4 Outline: Pakistan Hosting and Government Go-Live (Gate C)

Status: outline. Expand into full specs (P4-01 onward) when Phases 1-2 are accepted and the hosting provider is chosen. Not detailed now because provider choice (H-18) and contract terms (H-17) change the design.

## Purpose
Move the system to servers in Pakistan, managed by a hosting provider, and admit government project data only after the move is accepted.

## Candidate specs

| ID (planned) | Title | Scope | Boundary | Depends on |
|---|---|---|---|---|
| P4-01 | Hosting provider selection and requirements | Written requirements (Postgres, Node runtime, object storage, TLS, backups in Pakistan, monitoring, support hours, restore time); evaluation of provider quotes against them; decision record | Documents only | Phase 2 accepted; H-17, H-18 |
| P4-02 | Production environment build | Provider environment definition (infrastructure notes or scripts), Postgres setup, API and web hosting, `local` file store driver in use, auth strategy for self-hosting (self-hosted Supabase Auth or an alternative behind `AuthVerifier`), secrets handling, `ALLOW_GOVERNMENT_DATA=true` only here | No business logic change; only drivers and configuration | P4-01 |
| P4-03 | Data migration and cutover | Rebuild database from migrations, load data from the cloud environment (private-client data only), verify counts and reconciliations, DNS cutover, rollback plan | Uses the import and reconciliation tooling from P0-04 and P2-10 | P4-02 |
| P4-04 | Security hardening, backups and monitoring | Access review, network rules, encrypted backups stored inside Pakistan, tested restore, uptime and error alerts, log retention, admin access policy | Operational only | P4-02 |
| P4-05 | Gate C acceptance | Re-run Gate A and Gate B suites on the new environment; independent review of the environment; government data admission checklist; written confirmation that backups and logs stay in Pakistan | Acceptance only | P4-03, P4-04 |

## Entry criteria
- Gate B passed.
- H-17 answered (what the contract wording requires, including backups).
- H-18 answered (provider and signed quote).
- Budget approved for hosting.

## Hard rule
No project with `sector = government` may be created or any government document stored until Gate C is passed and `ALLOW_GOVERNMENT_DATA=true` is set in the Pakistan environment only.

## Open questions
- Does the residency rule cover backups, logs, email notifications and the web application files?
- Who operates the server day to day (provider, owner, retained engineer)?
- Is the move needed earlier if a government contract arrives before Phase 3 is complete? If so, this phase moves ahead of Phase 3.
