---
id: P0-02
title: Discovery pack and paper-form intake
phase: 0
module: discovery
status: in-review
depends_on: [P0-01]
requires_inputs: [H-14]
---

# P0-02 Discovery pack and paper-form intake

## 1. Purpose
Capture the company's real paper forms and workflows in the repository, so later specs implement actual practice and staff recognize the screens and printouts.

## 2. Boundary
- Owns: `docs/discovery/**` and the `docs:check` script.
- Provides: forms inventory, field mappings, workflow maps, gap list that other specs reference.
- Consumes: paper form samples supplied by the human (H-14).
- Must not: change any spec or code; findings that conflict with a spec become a proposal in `CHANGES.md`.
- Out of scope: building screens or print layouts (done in the owning module specs).

## 3. Data model
No database tables. Documents only:
- `docs/discovery/forms-inventory.md`: table with one row per paper form: name, who fills it, when, copies, signatures, linked spec ID, status (`received` or `awaiting`).
- `docs/discovery/forms/<form-slug>.md`: paper field to system field mapping (paper field, example value, system field, owning spec, note).
- `docs/discovery/workflows/<name>.md`: workflow maps for quotation to project, procurement to stock, site daily cycle, labour attendance to monthly wages, billing to collection, demolition job, paid maintenance job.
- `docs/discovery/glossary.md`: English and Urdu trade terms (for later translation).
- `docs/discovery/gaps.md`: paper fields with no system field, each with a proposed owner spec.

## 4. Business rules
- BR-1 The forms inventory includes at least: quotation, site report, purchase voucher, goods receipt or challan, expense voucher, labour register, attendance sheet, wage sheet, tax invoice, cheque register, stock register.
- BR-2 Every inventory row links to an existing spec ID.
- BR-3 Every mapping row names an owning spec or points to a gap entry.
- BR-4 If no sample has been supplied for a form, its row has status `awaiting`, the mapping file contains only the header, and no spec is blocked (H-14 default allowed).
- BR-5 No real names, CNIC numbers, phone numbers or amounts from samples are copied; examples use synthetic values.
- BR-6 Each workflow file lists steps, actor per step, document produced, approval, and the spec that implements the step.

## 5. API and UI
`pnpm docs:check` validates links, spec IDs and table structure in `docs/discovery`.

## 6. Permissions
None.

## 7. Test requirements
- T-1 The checker rejects: a row linking to an unknown spec ID, a mapping row with neither spec nor gap, a missing required form row, a broken relative link.
- T-2 The checker accepts a valid fixture set and an `awaiting` form with an empty mapping.
- T-3 The checker detects likely real data (13-digit CNIC pattern, Pakistani mobile pattern) in discovery docs and fails.
- T-4 100% coverage on the checker's logic.

## 8. Acceptance criteria
- AC-1 All files above exist with the required structure.
- AC-2 `pnpm docs:check` passes.
- AC-3 Every workflow step maps to a spec in this set.
- AC-4 Gaps found are listed in `gaps.md` and referenced from `CHANGES.md` proposals if they need spec changes.
- AC-5 Definition of Done satisfied (migration and RLS items are not applicable).

## 9. Open inputs
H-14: paper form samples. Unanswered: proceed with `awaiting` rows (default allowed).
