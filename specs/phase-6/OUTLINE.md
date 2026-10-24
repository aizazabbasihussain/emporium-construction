# Phase 6 Outline: Mobile App

Status: outline. Specified in full when the web system is stable in use and the supervisors' phone and connectivity facts are known (open item: how many supervisors, Android phones, connectivity at sites).

## Purpose
A field app for supervisors (and optionally storekeepers and technicians) with full offline operation and safe synchronization, built on the same API.

## Candidate specs

| ID (planned) | Title | Scope | Boundary | Depends on |
|---|---|---|---|---|
| P6-01 | Mobile foundation and sync engine | React Native (Expo) app shell, login, local database, sync protocol using UUIDs, `updated_at`, idempotency keys and a change feed endpoint, conflict rules (server wins on submitted records), sync status UI | Adds an API sync module with its own tables (`syn_`); no change to business modules except exposing change feeds | Gate A |
| P6-02 | Supervisor app: attendance and DPR | Offline attendance grid and DPR with photo queue, project and team caches, reuse of validation rules through `packages/domain` and `packages/shared` | Client only; server rules unchanged | P6-01, P1-15, P1-17 |
| P6-03 | Store and expense features | Offline GRN receiving, stock issue and expense claims | Client only | P6-01, P1-12, P1-14 |
| P6-04 | Technician features | Work order list, checklist, before/after photos, sign-off, parts request | Client only | P6-01, Phase 3 |
| P6-05 | Mobile release and device management | Build and signing pipeline, Android distribution (internal track or direct APK), update policy, remote disable for lost devices, minimum OS support | Operational | P6-01 |

## Entry criteria
- Gate A passed and in real use for at least one month.
- Device and connectivity facts collected.
- Decision on distribution (store listing or direct install).

## Key constraints
- Low-end Android support, small app size, photo compression as in P1-20.
- No business rule duplication: validations come from shared packages; the server remains the authority.
- Government data on devices follows the residency policy (encrypted local storage, remote wipe).
