---
id: P1-05
title: Master data and company profile
phase: 1
module: masterdata
status: not-started
depends_on: [P1-02, P0-04]
requires_inputs: [H-01, H-25, H-26]
---

# P1-05 Master data and company profile

## 1. Purpose
The shared reference data every module uses: company profile and tax registrations, parties (clients, vendors, subcontractors), items and categories, units, cost codes, locations, and vendor price lists.

## 2. Boundary
- Owns: tables `mst_*`, module `masterdata`, importers for each master.
- Provides: query interfaces `getParty`, `searchParties`, `getItem`, `getItemCategory`, `getUnit`, `convertQuantity`, `getCostCode`, `getRegistration(authority)`, `listLocations`; events `master.party.changed`, `master.item.changed`.
- Consumes: kernel, identity, importer framework, files.
- Must not: hold transactional data; no stock, price history of purchases, or tax rates (P2-01).
- Out of scope: workers (P1-16), users (P1-02), valuation policy (P1-13 references item categories).

## 3. Data model
- `mst_company(id, name, address, phone, email, logo_file_id)` single row; `mst_tax_registrations(id, authority code, registration_type ntn|strn|pra|other, number, valid_from, valid_to nullable)`.
- `mst_parties(id, code unique, name, legal_name, kind jsonb roles: client|vendor|subcontractor|labour_contractor, ntn nullable, strn nullable, cnic nullable, phone, email, address, city, status, notes, ...base)`; `mst_party_contacts(party_id, name, phone, email, role)`.
- `mst_units(code pk, name, kind count|length|area|volume|weight|time|lump)`, `mst_unit_conversions(from_unit, to_unit, factor numeric(18,6))`.
- `mst_item_categories(id, code unique, name, parent_id)`; `mst_items(id, code unique, name, category_id, unit_code, item_kind material|consumable|service|labour|equipment, stockable bool, default_tax_kind goods|services, reorder_level nullable, active)`.
- `mst_cost_codes(id, code unique, name, parent_id, kind material|labour|subcontract|equipment|overhead, active)`.
- `mst_locations(id, name, region islamabad|punjab, city)`.
- `mst_vendor_prices(id, vendor_id, item_id, unit_code, rate numeric(18,4), valid_from, valid_to nullable)`.

## 4. Business rules
- BR-1 Party codes are generated from a number series per kind; names are required; a party can hold several roles.
- BR-2 Duplicate protection: same normalized name plus phone, same NTN, or same CNIC (13 digits, validated format) returns a duplicate warning; NTN and CNIC are unique among active parties when present.
- BR-3 CNIC format `13 digits` (hyphens stripped); phone normalized to E.164 for Pakistan (`+92...`), invalid numbers rejected.
- BR-4 Items: `stockable` is true only for kinds `material` and `consumable`; `service` and `labour` items cannot be stockable; item code unique; unit must exist.
- BR-5 Unit conversion: conversions are directed pairs; `convertQuantity` uses a direct pair or its inverse; no chained conversion; missing pair is an error; conversion rounds to 4 decimals half-up.
- BR-6 Cost code hierarchy has no cycles; the cost code structure and kinds come from H-25 (seed from P0-03 when accepted); a code with posted costs (checked via the cost ledger query interface, P1-09, once available) cannot be deactivated unless it has no open budget lines.
- BR-7 Registrations: at most one active registration per `(authority, registration_type)` on a date; `getRegistration(authority)` returns the active one or null.
- BR-8 Deleting is soft; a party or item referenced by any transactional document cannot be soft-deleted, only set inactive (checked through each module's `isReferenced` interface registered at startup).
- BR-9 Changes emit events and audit entries.
- BR-10 Importers registered: parties, items, item categories, units, cost codes, vendor prices, tax registrations; each validates the same rules as the API.

## 5. API and UI
CRUD under `/master/*` for each table with search, pagination (default 50, max 200), sorting; `POST /master/parties/check-duplicate`; `GET /master/units/convert`.
Screens: company profile, parties list and form, items and categories, units, cost code tree, locations, vendor price list.

## 6. Permissions
`master.company.manage` (admin), `master.party.read|manage` (office roles; `read` also for supervisors limited to clients and vendors of their projects is not required: supervisors read parties only through project context), `master.item.manage` (procurement, storekeeper read), `master.costcode.manage` (accountant, management), `master.price.manage` (procurement).

## 7. Test requirements
- T-1 Duplicate detection (name plus phone, NTN, CNIC) and uniqueness constraints.
- T-2 CNIC and phone normalization and rejection (valid, too short, letters, non-Pakistan prefix).
- T-3 Stockable rule per item kind; unit existence.
- T-4 Conversion: direct, inverse, missing pair, rounding at 4 decimals; property test that `convert(convert(x, a, b), b, a)` is within 1 unit of the 4th decimal.
- T-5 Cost code hierarchy cycles rejected; deactivation rules.
- T-6 Registration overlap rejected.
- T-7 Referenced records cannot be soft-deleted (fake `isReferenced` providers).
- T-8 Each importer: template, valid file, invalid rows reported.
- T-9 Route contract tests, repository integration tests, component tests for party form validation; 100% coverage of service, policy and domain.

## 8. Acceptance criteria
- AC-1 A party with several roles can be created, found by name, NTN or CNIC, and flagged as duplicate when repeated.
- AC-2 A unit conversion works both directions and fails for unrelated units.
- AC-3 Cost code tree and item categories can be imported from CSV in a dry run and commit.
- AC-4 Tax registrations are stored per authority and retrievable by date.
- AC-5 Definition of Done satisfied.

## 9. Open inputs
H-01 (registrations: unanswered, create none), H-25 (cost code structure: unanswered, stop before seeding real codes), H-26 (units: default allowed, seed the default list).
