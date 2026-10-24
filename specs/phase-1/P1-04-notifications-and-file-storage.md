---
id: P1-04
title: Notifications and file storage
phase: 1
module: files-notifications
status: done
depends_on: [P1-02]
requires_inputs: []
---

# P1-04 Notifications and file storage

## 1. Purpose
Store photos and documents safely behind one interface that can move from Supabase Storage to local storage in Pakistan, and notify users inside the app about approvals, reminders and assignments.

## 2. Boundary
- Owns: tables `fil_*` and `ntf_*`; modules `files` and `notifications`; the `FileStore` interface and its Supabase and local-disk drivers.
- Provides: `files.attach(entityType, entityId, upload)`, `files.list(entityType, entityId)`, `files.getSignedUrl(attachmentId)`, `files.remove(attachmentId)` (soft), `notify(userIds, template, data)`, `notifyRole(roleCode, ...)`, `scheduleReminder(userId, at, template, data)`.
- Consumes: identity, kernel events (to turn approval and assignment events into notifications).
- Must not: know which module owns an entity beyond its type string.
- Out of scope: email, SMS and WhatsApp delivery (interface only, no provider; Phase 7); image editing.

## 3. Data model
- `fil_attachments(id, entity_type, entity_id, storage_key, file_name, content_type, size_bytes, checksum_sha256, caption, taken_at nullable, latitude nullable, longitude nullable, uploaded_by, ...base)`.
- `ntf_notifications(id, user_id, template, data jsonb, read_at, created_at)`; `ntf_reminders(id, user_id, due_at, template, data, sent_at)`.

## 4. Business rules
- BR-1 Allowed content types: image/jpeg, image/png, application/pdf, text/csv, XLSX; maximum 10 MB per file; the type is verified by content signature, not file extension.
- BR-2 The checksum is computed server-side; an upload to the same entity with an identical checksum returns the existing attachment (idempotent retry).
- BR-3 Storage keys are random UUID paths; original file names are metadata only; path traversal characters are rejected.
- BR-4 Files are downloaded only through short-lived signed URLs (5 minutes) issued after a permission check against the owning entity type's read permission, registered by each module via `registerFileAccess(entityType, checkFn)`.
- BR-5 Removal is soft (`deleted_at`); the object remains for 30 days then a purge job deletes it, unless the entity type is flagged `retain_forever` (financial documents).
- BR-6 `FileStore` interface: `put`, `getSignedUrl`, `delete`, `exists`; drivers selected by `FILE_STORE_DRIVER` (`supabase` or `local`); both drivers pass the same contract test suite.
- BR-7 Notifications are in-app only; users read their own; marking read is idempotent; notifications older than 90 days are purged.
- BR-8 Reminders are delivered by a scheduler tick every minute that creates a notification for each due, unsent reminder exactly once.
- BR-9 A notification template registry maps template codes to i18n keys; a missing template fails fast in tests.
- BR-10 Event subscriptions: `approval.*` events notify the requester and next-step approvers; the template set for later modules is registered by those modules.

## 5. API and UI
- `POST /files` (multipart: entityType, entityId, file, caption); `GET /files?entityType&entityId`; `GET /files/:id/url`; `DELETE /files/:id`
- `GET /notifications`; `POST /notifications/:id/read`; `POST /notifications/read-all`
- UI: reusable attachment uploader with client-side image compression (max long edge 1600 px, JPEG quality 0.7) and thumbnail grid; notification bell and list.

## 6. Permissions
Files follow the owning entity's permissions (`files.attachment.upload|read|remove` combined with the entity check). `notifications.read.own` for all users.

## 7. Test requirements
- T-1 Type sniffing: a renamed `.exe` as `.jpg` is rejected; oversize rejected; valid types accepted.
- T-2 Checksum idempotency; path traversal rejected.
- T-3 Driver contract suite runs against the local driver and an in-memory fake for Supabase (no network).
- T-4 Signed URL expires; denied when the entity check fails; works for the permitted user.
- T-5 Soft delete, purge after 30 days, `retain_forever` exemption (fixed clock).
- T-6 Notification creation from approval events, read idempotency, 90-day purge, reminder delivered once under two concurrent ticks.
- T-7 Template registry completeness test (every registered template has an i18n key).
- T-8 Component test for the uploader (compression parameters called with expected limits); route contract tests; repository integration tests; 100% coverage of service and policy.

## 8. Acceptance criteria
- AC-1 A file attached to a test entity can be listed and fetched by a permitted user and not by an unpermitted one.
- AC-2 The same contract tests pass for both drivers.
- AC-3 An approval event produces notifications for the right users exactly once.
- AC-4 Definition of Done satisfied.

## 9. Open inputs
None.
