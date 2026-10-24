# 02. Spec Template

Every spec file lives at `specs/phase-<n>/<ID>-<slug>.md` and starts with this frontmatter. `pnpm spec:check` rejects files that do not match.

```
---
id: P1-12
title: Inventory core
phase: 1
module: inventory
status: not-started        # not-started | in-progress | in-review | done | blocked
depends_on: [P1-11, P1-13]
requires_inputs: [H-27]
---
```

Required headings, in this order:

```
# <ID> <Title>

## 1. Purpose
Why this module exists, in 2-4 sentences.

## 2. Boundary
- Owns: tables (prefix), domain code, routes
- Provides: interfaces and events other modules may use
- Consumes: interfaces and events from other modules
- Must not: what this module is forbidden to do
- Out of scope: things people may expect but are NOT built here (with the spec that owns them, if any)

## 3. Data model
Tables, key columns, constraints, indexes, views.

## 4. Business rules
Numbered BR-1, BR-2, ... Precise enough to write tests from.

## 5. API and UI
Endpoints (method, path, purpose) and screens.

## 6. Permissions
Permission codes and which roles hold them by default.

## 7. Test requirements
Numbered T-1, T-2, ... Cases that must exist, including property-based and end-to-end tests.

## 8. Acceptance criteria
Numbered AC-1, AC-2, ... Observable, pass or fail.

## 9. Open inputs
Human inputs (H-ids) and the behavior when unanswered.
```

Writing rules: use "must" for requirements; no vague words ("appropriate", "etc."); every rule testable; every number or limit written out; every table owned by exactly one module.
