---
id: P1-20
title: Offline-tolerant drafts and PWA
phase: 1
module: pwa
status: not-started
depends_on: [P1-15, P1-17, P1-14]
requires_inputs: []
---

# P1-20 Offline-tolerant drafts and PWA

## 1. Purpose
Let supervisors keep working when the connection drops: the app installs on a phone, saves drafts of DPRs, attendance sheets and expense claims on the device, queues photos, and retries safely when the connection returns. Full offline mode comes with the native app (Phase 6).

## 2. Boundary
- Owns: web-only code in `apps/web/src/offline` and `packages/shared/offline` (no database tables, no API module).
- Provides: `useDraft(key)`, `submitQueue` (retry queue with idempotency keys), `PhotoQueue`, sync status indicator.
- Consumes: the existing API of DPR, attendance and expenses through their idempotent endpoints; `Idempotency-Key` from the kernel.
- Must not: duplicate business rules in the client or compute money; it stores raw form input only.
- Out of scope: offline reading of other data, multi-device merge, background sync guarantees on iOS, offline stock or approvals (Phase 6).

## 3. Data model
Client-side only (IndexedDB database `ops-offline`):
- `drafts(key, form_type dpr|attendance|expense, payload, updated_at, user_id)`
- `queue(id, idempotency_key, method, url, body, attempts, next_attempt_at, status pending|sent|failed, last_error)`
- `photos(id, draft_key, blob, name, compressed bool, upload_status pending|uploaded|failed, attachment_id)`

## 4. Business rules
- BR-1 The app is an installable PWA (manifest, icons, `display: standalone`, theme color) and caches the app shell with a service worker so the shell opens offline; API responses are never served stale for writes.
- BR-2 DPR, attendance and expense forms autosave to a local draft on every change (debounced 500 ms) and restore after reload or restart; drafts belong to the signed-in user and are deleted at logout on a shared device only if the user confirms (default keep, setting).
- BR-3 Submitting while offline places the request in the queue with a generated `Idempotency-Key` and shows "saved, will send"; the queue retries with exponential backoff (5 s, 15 s, 60 s, 5 min, then every 15 min) when the browser reports online or on app foreground.
- BR-4 Retries are safe because every endpoint is idempotent on the key; a server 409 or 422 stops retrying, marks the item `failed` and shows the reason to the user with an edit-and-resend action; 401 pauses the queue until sign-in.
- BR-5 Photos are compressed client-side (long edge 1600 px, JPEG quality 0.7) before queueing, stored as blobs, and uploaded individually after the parent record exists; an upload failure retries independently and never blocks the form submission; the same checksum deduplicates on the server.
- BR-6 Storage quota: if free storage is below 50 MB or a write fails, the user is told before losing data; drafts older than 30 days are flagged.
- BR-7 A visible indicator shows online/offline and the number of unsent items; unsent items are listed with their status.
- BR-8 Conflict rule: submitted records on the server always win; a draft for a date that already has a submitted report is shown with a warning and cannot overwrite it.
- BR-9 No sensitive data is stored except form input; wage rates and costs are never cached by this layer.

## 5. API and UI
No new endpoints. UI: install prompt, sync status bar, "unsent items" screen, draft restore banner.

## 6. Permissions
Uses existing permissions of the forms it wraps.

## 7. Test requirements
- T-1 Queue logic as pure functions: backoff schedule, state transitions, stop rules for 401, 409, 422, dedupe by key (100% coverage).
- T-2 Draft store with fake IndexedDB: save, restore, expiry flags, per-user isolation.
- T-3 Photo queue: compression parameters, upload ordering after parent, retry independence, dedupe.
- T-4 Component tests: autosave debounce, restore banner, status bar, conflict warning.
- T-5 Playwright with network toggled offline: fill a DPR with a photo offline, reload, restore draft, go online, record is created exactly once even if the first request is repeated.
- T-6 Service worker caching test: shell loads offline; API write routes are never cached.
- T-7 Storage-low behavior with a simulated quota error.

## 8. Acceptance criteria
- AC-1 A DPR filled offline with two photos is delivered exactly once after reconnection.
- AC-2 A server rejection shows a clear reason and keeps the data for editing.
- AC-3 Reload while offline does not lose the draft.
- AC-4 Definition of Done satisfied (database items not applicable).

## 9. Open inputs
None. (Supervisor phone models and connectivity, if answered, may tighten photo limits through a proposal.)
